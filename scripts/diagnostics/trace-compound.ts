import { ethers } from "hardhat";

const DEFAULT_VAULT = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
const DEFAULT_CONTROLLER = "0xC6c1aC4e3fbDfbFA2d5554C77A081BaE178aac86";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || DEFAULT_VAULT;
  const controllerAddress = process.env.CONTROLLER_ADDRESS || DEFAULT_CONTROLLER;

  console.log("=== Trace Compound Operation ===");
  console.log("Vault:", vaultAddress);
  console.log("Controller:", controllerAddress);
  console.log("");

  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
  const controller = await ethers.getContractAt("RebalanceController", controllerAddress);

  // Get manager addresses
  const [lmAddress, hmAddress] = await Promise.all([
    vault.liquidityManager(),
    vault.hedgeManager(),
  ]);

  console.log("LiquidityManager:", lmAddress);
  console.log("HedgeManager:", hmAddress);
  console.log("");

  const lm = await ethers.getContractAt("LiquidityManager", lmAddress);
  const hm = await ethers.getContractAt("HedgeManager", hmAddress);

  // Check vault state
  const [paused, circuitBreaker, asset, protocolFeeBps, treasury, totalSupply, totalAssetsVal] = await Promise.all([
    vault.paused(),
    vault.circuitBreakerTriggered(),
    vault.asset(),
    vault.protocolFeeBps(),
    vault.treasury(),
    vault.totalSupply(),
    vault.totalAssets(),
  ]);

  console.log("Vault paused:", paused);
  console.log("Circuit breaker:", circuitBreaker);
  console.log("Asset:", asset);
  console.log("Protocol fee bps:", protocolFeeBps.toString());
  console.log("Treasury:", treasury);
  console.log("Total supply:", ethers.formatUnits(totalSupply, 6));
  console.log("Total assets:", ethers.formatUnits(totalAssetsVal, 6));
  console.log("");

  // Check idle balances
  const assetToken = await ethers.getContractAt("IERC20", asset);
  const idleBalance = await assetToken.balanceOf(vaultAddress);
  const vaultEth = await ethers.provider.getBalance(vaultAddress);

  console.log("Idle USDC in vault:", ethers.formatUnits(idleBalance, 6));
  console.log("ETH in vault:", ethers.formatEther(vaultEth));
  console.log("");

  // Check LP position
  const [tokenId, liquidity, baseToken, quoteToken, inRange] = await Promise.all([
    lm.tokenId(),
    lm.liquidity(),
    lm.baseToken(),
    lm.quoteToken(),
    lm.isInRange(),
  ]);

  console.log("LP token ID:", tokenId.toString());
  console.log("LP liquidity:", liquidity.toString());
  console.log("LP in range:", inRange);
  console.log("");

  // Check hedge position
  const [hedgeSize, execFee] = await Promise.all([
    hm.getPositionSizeUsd(),
    hm.getExecutionFee(),
  ]);

  console.log("Hedge position size (30d):", hedgeSize.toString());
  console.log("Hedge execution fee:", ethers.formatEther(execFee));
  console.log("");

  // Check what compound would do
  if (idleBalance > 0n) {
    console.log("=== Simulating compound ===");

    // Try calling compound staticcall to get the error
    try {
      await vault.compound.staticCall();
      console.log("compound() staticCall succeeded!");
    } catch (e: any) {
      console.log("compound() staticCall failed:");
      console.log("Error:", e.message);
      if (e.data) {
        console.log("Error data:", e.data);
      }
    }
  } else {
    console.log("No idle balance to compound");
  }

  // Also try calling through the controller
  console.log("\n=== Simulating performUpkeep through controller ===");
  const performData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [2]); // Compound = 2

  try {
    await controller.performUpkeep.staticCall(performData);
    console.log("performUpkeep() staticCall succeeded!");
  } catch (e: any) {
    console.log("performUpkeep() staticCall failed:");
    console.log("Error:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
    }
  }

  // Let's also check individual operations
  console.log("\n=== Checking individual operations ===");

  // Check if we can call getPositionDelta on LP
  try {
    const lpDelta = await lm.getPositionDelta();
    console.log("LP delta:", lpDelta.toString());
  } catch (e: any) {
    console.log("getPositionDelta failed:", e.message);
  }

  // Check if we can call getOraclePrice
  try {
    const price = await lm.getOraclePrice();
    console.log("Oracle price:", ethers.formatUnits(price, 18));
  } catch (e: any) {
    console.log("getOraclePrice failed:", e.message);
  }

  // Check hedge manager state
  try {
    const [market, exchangeRouter, collateralToken, minPositionSize, orderVault] = await Promise.all([
      hm.market(),
      hm.exchangeRouter(),
      hm.collateralToken(),
      hm.minPositionSize(),
      hm.orderVault(),
    ]);
    console.log("\nHedge Manager config:");
    console.log("  Market:", market);
    console.log("  Exchange Router:", exchangeRouter);
    console.log("  Collateral Token:", collateralToken);
    console.log("  Min position size:", minPositionSize.toString());
    console.log("  Order Vault:", orderVault);

    // Get the underlying router from exchangeRouter
    const exchangeRouterContract = await ethers.getContractAt("IExchangeRouter", exchangeRouter);
    const underlyingRouter = await exchangeRouterContract.router();
    console.log("  Underlying Router:", underlyingRouter);

    // Check HM's allowance to the underlying router
    const hmToRouterAllowance = await collateralContract.allowance(hmAddress, underlyingRouter);
    console.log("  HM -> Router allowance:", ethers.formatUnits(hmToRouterAllowance, 6));
  } catch (e: any) {
    console.log("Failed to read hedge config:", e.message);
  }

  // Check collateral allowance for GMX
  const collateralToken = await hm.collateralToken();
  const collateralContract = await ethers.getContractAt("IERC20", collateralToken);
  const hmAllowance = await collateralContract.allowance(hmAddress, await hm.exchangeRouter());
  console.log("\nHM collateral allowance to router:", ethers.formatUnits(hmAllowance, 6));

  // Check vault -> HM allowance (critical for adjustHedge)
  const vaultToHmAllowance = await collateralContract.allowance(vaultAddress, hmAddress);
  console.log("Vault -> HM collateral allowance:", ethers.formatUnits(vaultToHmAllowance, 6));

  // Check LM state in more detail since LP is out of range
  console.log("\n=== LiquidityManager detailed state ===");
  try {
    const [swapRouter, positionManager, poolFee, pool, twapEnabled, twapPeriod, maxTwapDeviation] = await Promise.all([
      lm.swapRouter(),
      lm.positionManager(),
      lm.poolFee(),
      lm.getPool(),
      lm.twapValidationEnabled(),
      lm.twapPeriod(),
      lm.maxTwapDeviation(),
    ]);
    console.log("TWAP validation enabled:", twapEnabled);
    console.log("TWAP period:", twapPeriod);
    console.log("Max TWAP deviation:", ethers.formatUnits(maxTwapDeviation, 16), "%");

    // Check current TWAP deviation
    if (twapEnabled) {
      try {
        const deviation = await lm.getSpotTWAPDeviation();
        console.log("Current spot-TWAP deviation:", ethers.formatUnits(deviation, 16), "%");

        // Check if TWAP validation would pass
        try {
          await lm.validatePriceAgainstTWAP();
          console.log("TWAP validation: PASS");
        } catch (e: any) {
          console.log("TWAP validation: FAIL -", e.message);
        }
      } catch (e: any) {
        console.log("Failed to get TWAP deviation:", e.message);
      }
    }
    console.log("Swap Router:", swapRouter);
    console.log("Position Manager:", positionManager);
    console.log("Pool Fee:", poolFee);
    console.log("Pool:", pool);

    // Check rebalance ticks
    const rangeMultiplier = await vault.rangeWidthMultiplier();
    console.log("Range multiplier:", rangeMultiplier);

    const [newTickLower, newTickUpper] = await lm.getRebalanceTicks(rangeMultiplier);
    console.log("New tick lower:", newTickLower);
    console.log("New tick upper:", newTickUpper);

    // Get current position ticks
    const [posTickLower, posTickUpper] = await Promise.all([
      lm.tickLower(),
      lm.tickUpper(),
    ]);
    console.log("Position tick lower:", posTickLower);
    console.log("Position tick upper:", posTickUpper);

    // Get current pool tick
    const poolContract = await ethers.getContractAt("IUniswapV3Pool", pool);
    const slot0 = await poolContract.slot0();
    console.log("Current pool tick:", slot0[1]);
    console.log("Pool sqrtPriceX96:", slot0[0].toString());

    // Try simulating adjustRange
    console.log("\n=== Simulating adjustRange ===");
    try {
      await lm.adjustRange.staticCall(newTickLower, newTickUpper, BigInt(Math.floor(Date.now() / 1000)) + 300n);
      console.log("adjustRange staticCall succeeded!");
    } catch (e: any) {
      console.log("adjustRange staticCall failed:", e.message);
      if (e.data) {
        console.log("Error data:", e.data);
      }
    }
  } catch (e: any) {
    console.log("Failed to read LM state:", e.message);
  }

  // Check vault's WETH and USDC balances
  console.log("\n=== Token balances in vault ===");
  const wethToken = await ethers.getContractAt("IERC20", baseToken);
  const usdcToken = await ethers.getContractAt("IERC20", asset);
  const vaultWeth = await wethToken.balanceOf(vaultAddress);
  const vaultUsdc = await usdcToken.balanceOf(vaultAddress);
  console.log("WETH:", ethers.formatEther(vaultWeth));
  console.log("USDC:", ethers.formatUnits(vaultUsdc, 6));

  // Check allowances from vault to LM
  const lmWethAllowance = await wethToken.allowance(vaultAddress, lmAddress);
  const lmUsdcAllowance = await usdcToken.allowance(vaultAddress, lmAddress);
  console.log("\nVault -> LM allowances:");
  console.log("WETH:", ethers.formatEther(lmWethAllowance));
  console.log("USDC:", ethers.formatUnits(lmUsdcAllowance, 6));

  // Check allowances from LM to position manager and swap router
  const pmAddress = await lm.positionManager();
  const routerAddress = await lm.swapRouter();
  const lmWethToPM = await wethToken.allowance(lmAddress, pmAddress);
  const lmUsdcToPM = await usdcToken.allowance(lmAddress, pmAddress);
  const lmWethToRouter = await wethToken.allowance(lmAddress, routerAddress);
  const lmUsdcToRouter = await usdcToken.allowance(lmAddress, routerAddress);
  console.log("\nLM -> Position Manager allowances:");
  console.log("WETH:", ethers.formatEther(lmWethToPM));
  console.log("USDC:", ethers.formatUnits(lmUsdcToPM, 6));
  console.log("\nLM -> Swap Router allowances:");
  console.log("WETH:", ethers.formatEther(lmWethToRouter));
  console.log("USDC:", ethers.formatUnits(lmUsdcToRouter, 6));

  // Try simulating swapForLP
  console.log("\n=== Simulating swapForLP ===");
  const rangeMultiplier = await vault.rangeWidthMultiplier();
  const lpAmount = (vaultUsdc * 70n) / 100n; // ~70% for LP
  console.log("LP amount to swap:", ethers.formatUnits(lpAmount, 6));
  try {
    await lm.swapForLP.staticCall(asset, lpAmount, rangeMultiplier, BigInt(Math.floor(Date.now() / 1000)) + 300n);
    console.log("swapForLP staticCall succeeded!");
  } catch (e: any) {
    console.log("swapForLP staticCall failed:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
    }
  }

  // Try simulating increaseLiquidity
  console.log("\n=== Simulating increaseLiquidity ===");
  try {
    // Calculate expected amounts
    const amount0 = baseToken < quoteToken ? vaultWeth : vaultUsdc;
    const amount1 = baseToken < quoteToken ? vaultUsdc : vaultWeth;
    console.log("Amount0:", baseToken < quoteToken ? ethers.formatEther(amount0) : ethers.formatUnits(amount0, 6));
    console.log("Amount1:", baseToken < quoteToken ? ethers.formatUnits(amount1, 6) : ethers.formatEther(amount1));

    await lm.increaseLiquidity.staticCall(amount0, amount1, BigInt(Math.floor(Date.now() / 1000)) + 300n);
    console.log("increaseLiquidity staticCall succeeded!");
  } catch (e: any) {
    console.log("increaseLiquidity staticCall failed:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
    }
  }

  // Try simulating adjustHedge
  console.log("\n=== Testing with impersonated vault ===");
  try {
    // Use impersonation to test from vault's perspective
    await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
    const vaultSigner = await ethers.getSigner(vaultAddress);

    // Fund the vault signer with some ETH for gas (needed for impersonation)
    const [funder] = await ethers.getSigners();
    await funder.sendTransaction({
      to: vaultAddress,
      value: ethers.parseEther("0.01"),
    });

    // Now try swapForLP from vault's context
    const lmWithVault = lm.connect(vaultSigner);
    const rangeMultiplierVal = await vault.rangeWidthMultiplier();
    const lpAmountVal = (vaultUsdc * 70n) / 100n;

    console.log("Testing swapForLP from vault context...");
    try {
      await lmWithVault.swapForLP.staticCall(
        asset,
        lpAmountVal,
        rangeMultiplierVal,
        BigInt(Math.floor(Date.now() / 1000)) + 300n
      );
      console.log("swapForLP from vault succeeded!");
    } catch (e: any) {
      console.log("swapForLP from vault failed:", e.message);
      if (e.data) console.log("Error data:", e.data);
    }

    // Try compound from vault context
    console.log("\nTesting compound from vault context...");
    const vaultWithVault = vault.connect(vaultSigner);
    try {
      await vaultWithVault.compound.staticCall();
      console.log("compound from vault succeeded!");
    } catch (e: any) {
      console.log("compound from vault failed:", e.message);
      if (e.data) console.log("Error data:", e.data);
    }

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);
  } catch (e: any) {
    console.log("Impersonation not available on this network:", e.message);
  }

  console.log("\n=== Simulating adjustHedge ===");
  try {
    // Calculate expected hedge target
    const lpDelta = await lm.getPositionDelta();
    const price = await lm.getOraclePrice();
    const baseDecimals = 18; // WETH
    let hedgeTarget = 0n;
    if (lpDelta > 0n) {
      // hedgeTarget in 30 decimals
      hedgeTarget = (lpDelta * price * (10n ** 12n)) / (10n ** BigInt(baseDecimals));
    }
    console.log("Hedge target (30d):", hedgeTarget.toString());

    const execFee = await hm.getExecutionFee();
    await hm.adjustHedge.staticCall(hedgeTarget, { value: execFee });
    console.log("adjustHedge staticCall succeeded!");
  } catch (e: any) {
    console.log("adjustHedge staticCall failed:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
