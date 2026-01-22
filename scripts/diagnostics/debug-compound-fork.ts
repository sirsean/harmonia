import { ethers, network } from "hardhat";

const VAULT = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";

async function main() {
  // Mine a block to initialize the fork properly
  await network.provider.send("evm_mine", []);

  const latestBlock = await ethers.provider.getBlockNumber();
  console.log("=== Debug Compound on Fork ===");
  console.log("Fork block:", latestBlock);
  console.log("");

  const vault = await ethers.getContractAt("DeltaNeutralVault", VAULT);
  const [lmAddress, hmAddress] = await Promise.all([
    vault.liquidityManager(),
    vault.hedgeManager(),
  ]);

  const lm = await ethers.getContractAt("LiquidityManager", lmAddress);

  // Impersonate the owner
  const owner = await vault.owner();
  await network.provider.send("hardhat_impersonateAccount", [owner]);
  await network.provider.send("hardhat_setBalance", [owner, "0x56BC75E2D63100000"]);
  const ownerSigner = await ethers.getSigner(owner);

  const vaultWithOwner = vault.connect(ownerSigner);

  console.log("Owner:", owner);
  console.log("Impersonated successfully");

  // Check state
  const [paused, idle, asset] = await Promise.all([
    vault.paused(),
    ethers.getContractAt("IERC20", await vault.asset()).then(t => t.balanceOf(VAULT)),
    vault.asset(),
  ]);
  console.log("\nVault state:");
  console.log("Paused:", paused);
  console.log("Idle:", ethers.formatUnits(idle, 6), "USDC");

  // Step-by-step execution
  console.log("\n=== Step-by-step execution ===");

  // Step 1: Test _compoundYield logic manually
  const protocolFeeBps = await vault.protocolFeeBps();
  const treasury = await vault.treasury();
  console.log("\nStep 1: Fee calculation");
  console.log("Fee bps:", protocolFeeBps.toString());
  console.log("Treasury:", treasury);

  if (protocolFeeBps > 0n && treasury !== ethers.ZeroAddress) {
    const feeAssets = (idle * protocolFeeBps) / 10000n;
    console.log("Fee assets:", ethers.formatUnits(feeAssets, 6));
    const feeShares = await vault.convertToShares(feeAssets);
    console.log("Fee shares:", ethers.formatUnits(feeShares, 6));
  }

  // Step 2: Calculate deployCapital params
  const baseToken = await lm.baseToken();
  const quoteToken = await lm.quoteToken();
  const weth = await ethers.getContractAt("IERC20", baseToken);
  const usdc = await ethers.getContractAt("IERC20", quoteToken);

  const idleAsset = await usdc.balanceOf(VAULT);
  const wethBal = await weth.balanceOf(VAULT);

  // Convert WETH to USDC value
  const oraclePrice = await lm.getOraclePrice();
  const wethValueUsdc = (wethBal * oraclePrice) / BigInt(1e18) / BigInt(1e12); // WETH 18d * price 18d / 1e18 / 1e12 = 6d

  const totalIdle = idleAsset + wethValueUsdc;
  const collateralAmount = (totalIdle * 30n) / 100n;
  const lpAmount = idleAsset > collateralAmount ? idleAsset - collateralAmount : 0n;

  console.log("\nStep 2: Capital deployment params");
  console.log("Idle USDC:", ethers.formatUnits(idleAsset, 6));
  console.log("WETH balance:", ethers.formatEther(wethBal));
  console.log("WETH value (USDC):", ethers.formatUnits(wethValueUsdc, 6));
  console.log("Total idle (USDC):", ethers.formatUnits(totalIdle, 6));
  console.log("Collateral (30%):", ethers.formatUnits(collateralAmount, 6));
  console.log("LP amount:", ethers.formatUnits(lpAmount, 6));

  // Step 3: Test swapForLP
  console.log("\n=== Step 2b: Test _swapOtherToAsset ===");
  // Since idleAsset < collateralAmount, _deployCapital will call _swapOtherToAsset
  console.log("Would _swapOtherToAsset be called? idleAsset < collateralAmount:", idleAsset < collateralAmount);

  if (idleAsset < collateralAmount) {
    console.log("Testing the swap router call...");

    const swapRouter = await lm.swapRouter();
    const poolFee = await lm.poolFee();

    // Check approvals
    const wethToRouterApproval = await weth.allowance(VAULT, swapRouter);
    console.log("Vault->Router WETH approval:", ethers.formatEther(wethToRouterApproval));

    // Try simulating the swap
    try {
      await network.provider.send("hardhat_impersonateAccount", [VAULT]);
      await network.provider.send("hardhat_setBalance", [VAULT, "0x56BC75E2D63100000"]);
      const vaultSigner = await ethers.getSigner(VAULT);

      // Approve router
      const wethWithVault = weth.connect(vaultSigner);
      await wethWithVault.approve(swapRouter, wethBal);
      console.log("Approved router for WETH");

      // Get router contract
      const router = await ethers.getContractAt("ISwapRouter", swapRouter);
      const routerWithVault = router.connect(vaultSigner);

      const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 300n;
      const params = {
        tokenIn: baseToken,
        tokenOut: quoteToken,
        fee: poolFee,
        recipient: VAULT,
        deadline: deadline,
        amountIn: wethBal,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      };

      console.log("Swap params:", {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: params.fee.toString(),
        amountIn: ethers.formatEther(params.amountIn),
      });

      // Try the swap
      const amountOut = await routerWithVault.exactInputSingle.staticCall(params);
      console.log("Swap would return:", ethers.formatUnits(amountOut, 6), "USDC");

      // Don't execute the swap, just simulate
      console.log("Swap simulation completed (not actually executed)");
      console.log("Expected output:", ethers.formatUnits(amountOut, 6), "USDC");
      console.log("Expected new USDC balance:", ethers.formatUnits(idleAsset + amountOut, 6));
      console.log("Expected new LP amount:", ethers.formatUnits((idleAsset + amountOut) - collateralAmount, 6));

      await network.provider.send("hardhat_stopImpersonatingAccount", [VAULT]);
    } catch (e: any) {
      console.log("Swap test FAILED:", e.message);
    }
  }

  console.log("\n=== Step 3: Test swapForLP ===");
  const rangeMultiplier = await vault.rangeWidthMultiplier();

  // Check vault->LM approval
  const vaultToLmApproval = await usdc.allowance(VAULT, lmAddress);
  console.log("Vault->LM USDC approval:", ethers.formatUnits(vaultToLmApproval, 6));

  if (lpAmount > 0n) {
    try {
      // Impersonate vault to call swapForLP
      await network.provider.send("hardhat_impersonateAccount", [VAULT]);
      await network.provider.send("hardhat_setBalance", [VAULT, "0x56BC75E2D63100000"]);
      const vaultSigner = await ethers.getSigner(VAULT);
      const lmWithVault = lm.connect(vaultSigner);

      const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 300n;
      console.log("Calling swapForLP...");
      console.log("  tokenIn:", asset);
      console.log("  amountIn:", ethers.formatUnits(lpAmount, 6));
      console.log("  rangeMultiplier:", rangeMultiplier.toString());
      console.log("  deadline:", deadline.toString());

      const amountOut = await lmWithVault.swapForLP.staticCall(asset, lpAmount, rangeMultiplier, deadline);
      console.log("swapForLP staticCall succeeded! AmountOut:", ethers.formatEther(amountOut));

      // Actually execute
      const tx = await lmWithVault.swapForLP(asset, lpAmount, rangeMultiplier, deadline);
      const receipt = await tx.wait();
      console.log("swapForLP executed! Gas:", receipt?.gasUsed.toString());

      await network.provider.send("hardhat_stopImpersonatingAccount", [VAULT]);
    } catch (e: any) {
      console.log("swapForLP FAILED:", e.message);
      if (e.errorArgs) console.log("Error args:", e.errorArgs);
      if (e.reason) console.log("Reason:", e.reason);

      // Try to get more detail
      console.log("\nDiagnosing swapForLP failure...");

      // Check if it's a transfer issue
      const lmUsdcBal = await usdc.balanceOf(lmAddress);
      console.log("LM USDC balance:", ethers.formatUnits(lmUsdcBal, 6));

      // Check swap router approval
      const swapRouter = await lm.swapRouter();
      const lmToRouterApproval = await usdc.allowance(lmAddress, swapRouter);
      console.log("LM->Router USDC approval:", ethers.formatUnits(lmToRouterApproval, 6));
    }
  }

  // Step 4: Try compound directly with verbose tracing
  console.log("\n=== Step 4: Try compound directly ===");
  try {
    // Enable tracing
    console.log("Attempting compound with gas limit 5M...");

    // Try to get a trace using call
    try {
      await vaultWithOwner.compound.staticCall();
      console.log("staticCall succeeded - trying actual tx");
    } catch (staticErr: any) {
      console.log("staticCall failed:", staticErr.message?.slice(0, 200));
    }

    const tx = await vaultWithOwner.compound({ gasLimit: 5000000 });
    const receipt = await tx.wait();
    console.log("compound() SUCCESS! Gas:", receipt?.gasUsed.toString());

    // Show events
    if (receipt?.logs) {
      for (const log of receipt.logs) {
        try {
          const parsed = vault.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) console.log("Event:", parsed.name, parsed.args);
        } catch {}
      }
    }
  } catch (e: any) {
    console.log("compound() FAILED");
    console.log("Error message:", e.message?.slice(0, 500));

    if (e.receipt) {
      console.log("Gas used:", e.receipt.gasUsed?.toString());
      console.log("Logs:", e.receipt.logs?.length);
    }

    // Try to trace the error
    if (e.error?.data || e.data) {
      const data = e.error?.data || e.data;
      console.log("Error data:", data);
    }
  }

  // Step 5: Try to call internal functions directly through vault
  console.log("\n=== Step 5: Test internal operations ===");

  // Check if _swapOtherToAsset would succeed
  console.log("Testing _swapOtherToAsset effect...");
  const swapRouter = await lm.swapRouter();

  // Impersonate vault and try the swap directly
  await network.provider.send("hardhat_impersonateAccount", [VAULT]);
  await network.provider.send("hardhat_setBalance", [VAULT, "0x56BC75E2D63100000"]);
  const vaultSignerFinal = await ethers.getSigner(VAULT);

  const wethWithVaultFinal = weth.connect(vaultSignerFinal);
  const routerFinal = await ethers.getContractAt("ISwapRouter", swapRouter);
  const routerWithVaultFinal = routerFinal.connect(vaultSignerFinal);
  const lmWithVaultFinal = lm.connect(vaultSignerFinal);

  // Approve and swap WETH to USDC
  await wethWithVaultFinal.approve(swapRouter, ethers.MaxUint256);
  console.log("Approved router");

  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 300n;
  const currentWethBal = await weth.balanceOf(VAULT);

  if (currentWethBal > 0n) {
    const swapTx = await routerWithVaultFinal.exactInputSingle({
      tokenIn: baseToken,
      tokenOut: quoteToken,
      fee: await lm.poolFee(),
      recipient: VAULT,
      deadline: deadline,
      amountIn: currentWethBal,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });
    await swapTx.wait();
    console.log("Swapped WETH to USDC");
  }

  const newUsdcBal = await usdc.balanceOf(VAULT);
  console.log("New USDC balance:", ethers.formatUnits(newUsdcBal, 6));

  // Now calculate new LP amount
  const newCollateral = (newUsdcBal * 30n) / 100n;
  const newLpAmount = newUsdcBal > newCollateral ? newUsdcBal - newCollateral : 0n;
  console.log("New collateral:", ethers.formatUnits(newCollateral, 6));
  console.log("New LP amount for swap:", ethers.formatUnits(newLpAmount, 6));

  // Try calling swapForLP
  console.log("\nTesting swapForLP...");
  try {
    const rangeMultiplierVal = await vault.rangeWidthMultiplier();

    // Trace swapForLP calculation manually
    const pool = await lm.getPool();
    const poolContract = await ethers.getContractAt("IUniswapV3Pool", pool);
    const slot0 = await poolContract.slot0();
    const sqrtPriceX96 = slot0[0];
    const currentTick = slot0[1];

    const tokenIdCurrent = await lm.tokenId();
    let tickLowerForSwap: bigint, tickUpperForSwap: bigint;
    if (tokenIdCurrent !== 0n) {
      tickLowerForSwap = await lm.tickLower();
      tickUpperForSwap = await lm.tickUpper();
    } else {
      [tickLowerForSwap, tickUpperForSwap] = await lm.getRebalanceTicks(rangeMultiplierVal);
    }

    console.log("Current tick:", currentTick.toString());
    console.log("Position tick lower:", tickLowerForSwap.toString());
    console.log("Position tick upper:", tickUpperForSwap.toString());

    // Calculate expected swap amount
    const DeltaCalculator = await ethers.getContractFactory("DeltaCalculator");
    // We need to replicate the swapForLP calculation

    console.log("LP amount to swap:", ethers.formatUnits(newLpAmount, 6));

    // Try with a far future deadline
    const farDeadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
    console.log("Using deadline:", farDeadline.toString());
    console.log("Calling swapForLP...");

    const swapForLPTx = await lmWithVaultFinal.swapForLP(asset, newLpAmount, rangeMultiplierVal, farDeadline);
    const swapForLPReceipt = await swapForLPTx.wait();
    console.log("swapForLP SUCCESS! Gas:", swapForLPReceipt?.gasUsed.toString());

    // Check balances after swapForLP
    const finalWethBal = await weth.balanceOf(VAULT);
    const finalUsdcBal = await usdc.balanceOf(VAULT);
    console.log("After swapForLP - WETH:", ethers.formatEther(finalWethBal));
    console.log("After swapForLP - USDC:", ethers.formatUnits(finalUsdcBal, 6));

    // Now try increaseLiquidity
    console.log("\nTesting increaseLiquidity...");
    const balBase = finalWethBal;
    let balQuote = finalUsdcBal;

    // Reserve collateral
    if (balQuote > newCollateral) {
      balQuote = balQuote - newCollateral;
    } else {
      balQuote = 0n;
    }

    console.log("For increaseLiquidity - WETH:", ethers.formatEther(balBase));
    console.log("For increaseLiquidity - USDC:", ethers.formatUnits(balQuote, 6));

    // Determine token order for Uniswap
    const amount0 = baseToken < quoteToken ? balBase : balQuote;
    const amount1 = baseToken < quoteToken ? balQuote : balBase;
    console.log("amount0:", baseToken < quoteToken ? ethers.formatEther(amount0) + " WETH" : ethers.formatUnits(amount0, 6) + " USDC");
    console.log("amount1:", baseToken < quoteToken ? ethers.formatUnits(amount1, 6) + " USDC" : ethers.formatEther(amount1) + " WETH");

    if (balBase > 0n || balQuote > 0n) {
      const incLiqTx = await lmWithVaultFinal.increaseLiquidity(amount0, amount1, deadline);
      const incLiqReceipt = await incLiqTx.wait();
      console.log("increaseLiquidity SUCCESS! Gas:", incLiqReceipt?.gasUsed.toString());
    } else {
      console.log("No tokens to add to liquidity");
    }

    // Now try _executeRebalance (adjust hedge)
    console.log("\nTesting adjustHedge...");
    const hmWithOwner = hm.connect(ownerSigner);
    const lpDelta = await lm.getPositionDelta();
    const oraclePriceNow = await lm.getOraclePrice();
    let hedgeTargetNow = 0n;
    if (lpDelta > 0n) {
      hedgeTargetNow = (lpDelta * oraclePriceNow * (10n ** 12n)) / (10n ** 18n);
    }
    console.log("LP delta:", lpDelta.toString());
    console.log("Hedge target (30d):", hedgeTargetNow.toString());

    const execFee = await hm.getExecutionFee();
    console.log("Execution fee:", ethers.formatEther(execFee));

    // Send ETH to hedge manager for fee
    await vaultSignerFinal.sendTransaction({ to: hmAddress, value: execFee });

    try {
      const adjustHedgeTx = await hmWithOwner.adjustHedge(hedgeTargetNow, { value: execFee });
      const adjustHedgeReceipt = await adjustHedgeTx.wait();
      console.log("adjustHedge SUCCESS! Gas:", adjustHedgeReceipt?.gasUsed.toString());
    } catch (adjErr: any) {
      console.log("adjustHedge FAILED:", adjErr.message?.slice(0, 300));
    }

  } catch (swapErr: any) {
    console.log("swapForLP FAILED:", swapErr.message?.slice(0, 300));

    // Try to diagnose why swapForLP failed
    console.log("\nDiagnosing swapForLP failure...");

    // Check LM's USDC balance
    const lmUsdcBal = await usdc.balanceOf(lmAddress);
    console.log("LM USDC balance:", ethers.formatUnits(lmUsdcBal, 6));

    // Check vault->LM allowance
    const vaultToLmAllowance = await usdc.allowance(VAULT, lmAddress);
    console.log("Vault->LM USDC allowance:", ethers.formatUnits(vaultToLmAllowance, 6));

    // Manually trace the swapForLP calculation
    const pool = await lm.getPool();
    const poolContract = await ethers.getContractAt("IUniswapV3Pool", pool);
    const slot0 = await poolContract.slot0();
    const sqrtPriceX96 = slot0[0];
    const currentTick = slot0[1];

    const tokenIdCurrent = await lm.tokenId();
    let tickLowerForSwap: bigint, tickUpperForSwap: bigint;
    if (tokenIdCurrent !== 0n) {
      tickLowerForSwap = await lm.tickLower();
      tickUpperForSwap = await lm.tickUpper();
    } else {
      const rangeMultiplierVal = await vault.rangeWidthMultiplier();
      [tickLowerForSwap, tickUpperForSwap] = await lm.getRebalanceTicks(rangeMultiplierVal);
    }

    console.log("Current tick:", currentTick.toString());
    console.log("Position ticks:", tickLowerForSwap.toString(), "to", tickUpperForSwap.toString());
    console.log("In range:", currentTick >= tickLowerForSwap && currentTick < tickUpperForSwap);

    // Try a smaller swap
    console.log("\nTrying with smaller amount...");
    try {
      const smallAmount = newLpAmount / 10n;
      console.log("Small amount:", ethers.formatUnits(smallAmount, 6));
      const smallSwapTx = await lmWithVaultFinal.swapForLP(asset, smallAmount, await vault.rangeWidthMultiplier(), deadline);
      const smallSwapReceipt = await smallSwapTx.wait();
      console.log("Small swapForLP SUCCESS! Gas:", smallSwapReceipt?.gasUsed.toString());
    } catch (smallErr: any) {
      console.log("Small swapForLP also FAILED:", smallErr.message?.slice(0, 200));
    }

    // Try minimal amount
    console.log("\nTrying with minimal amount (1 USDC)...");
    try {
      const minAmount = 1000000n; // 1 USDC
      const minSwapTx = await lmWithVaultFinal.swapForLP(asset, minAmount, await vault.rangeWidthMultiplier(), deadline);
      const minSwapReceipt = await minSwapTx.wait();
      console.log("Minimal swapForLP SUCCESS! Gas:", minSwapReceipt?.gasUsed.toString());
    } catch (minErr: any) {
      console.log("Minimal swapForLP also FAILED:", minErr.message?.slice(0, 200));
    }

    // Try with 0 amount (should return early)
    console.log("\nTrying with 0 amount...");
    try {
      const zeroSwapTx = await lmWithVaultFinal.swapForLP(asset, 0n, await vault.rangeWidthMultiplier(), deadline);
      const zeroSwapReceipt = await zeroSwapTx.wait();
      console.log("Zero swapForLP SUCCESS! Gas:", zeroSwapReceipt?.gasUsed.toString());
    } catch (zeroErr: any) {
      console.log("Zero swapForLP FAILED:", zeroErr.message?.slice(0, 200));
    }

    // Try calling from owner instead of vault (owner also passes onlyVault)
    console.log("\nTrying from owner...");
    const lmWithOwner = lm.connect(ownerSigner);
    try {
      const ownerSwapTx = await lmWithOwner.swapForLP(asset, 1000000n, await vault.rangeWidthMultiplier(), deadline);
      const ownerSwapReceipt = await ownerSwapTx.wait();
      console.log("Owner swapForLP SUCCESS! Gas:", ownerSwapReceipt?.gasUsed.toString());
    } catch (ownerErr: any) {
      console.log("Owner swapForLP FAILED:", ownerErr.message?.slice(0, 200));
    }

    // Try calling collectFees (also has onlyVault) to verify modifier works
    console.log("\nTrying collectFees from vault...");
    try {
      const collectTx = await lmWithVaultFinal.collectFees();
      const collectReceipt = await collectTx.wait();
      console.log("collectFees SUCCESS! Gas:", collectReceipt?.gasUsed.toString());
    } catch (collectErr: any) {
      console.log("collectFees FAILED:", collectErr.message?.slice(0, 200));
    }

    // Try raw call to swapForLP
    console.log("\nTrying raw call to swapForLP...");
    const iface = new ethers.Interface([
      "function swapForLP(address tokenIn, uint256 amountIn, int24 rangeWidthMultiplier, uint256 deadline) external returns (uint256)"
    ]);
    const calldata = iface.encodeFunctionData("swapForLP", [asset, 0n, await vault.rangeWidthMultiplier(), deadline]);
    console.log("Calldata:", calldata);

    try {
      const rawResult = await vaultSignerFinal.call({
        to: lmAddress,
        data: calldata,
      });
      console.log("Raw call result:", rawResult);
    } catch (rawErr: any) {
      console.log("Raw call FAILED:", rawErr.message?.slice(0, 200));
    }

    // Try to trace the issue using DeltaCalculator functions
    console.log("\n=== Tracing DeltaCalculator calls ===");
    const DeltaCalculatorFactory = await ethers.getContractFactory("DeltaCalculator");
    const harness = await ethers.getContractAt(
      "DeltaCalculatorHarness",
      "0x0000000000000000000000000000000000000000" // Dummy - we'll just use the library
    );

    // Get the actual sqrtPriceX96 values
    const poolLast = await lm.getPool();
    const poolContractLast = await ethers.getContractAt("IUniswapV3Pool", poolLast);
    const slot0Last = await poolContractLast.slot0();
    const sqrtPriceX96Last = slot0Last[0];

    console.log("sqrtPriceX96:", sqrtPriceX96Last.toString());

    // Calculate sqrt prices for ticks using library (through harness if available)
    // Since we can't call library directly, let's check the tick spacing
    const tickSpacing = await poolContractLast.tickSpacing();
    console.log("Tick spacing:", tickSpacing.toString());

    // Check if ticks are valid (divisible by spacing)
    console.log("Tick lower valid:", tickLowerForSwap % BigInt(tickSpacing) === 0n);
    console.log("Tick upper valid:", tickUpperForSwap % BigInt(tickSpacing) === 0n);

    // Check the vault address in LM
    const lmVault = await lm.vault();
    console.log("\nLM vault address:", lmVault);
    console.log("Actual vault address:", VAULT);
    console.log("Match:", lmVault.toLowerCase() === VAULT.toLowerCase());

    // Check owner
    const lmOwner = await lm.owner();
    console.log("LM owner:", lmOwner);

    // Check if LM is a proxy and get implementation
    console.log("\n=== Proxy check ===");
    // Try reading the implementation slot (EIP-1967)
    const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const implData = await ethers.provider.getStorage(lmAddress, implSlot);
    const implAddress = "0x" + implData.slice(26);
    console.log("Implementation address:", implAddress);

    // Try calling a simple view function
    console.log("\n=== Testing simple view calls ===");
    try {
      const poolAddr = await lm.getPool();
      console.log("getPool():", poolAddr);
    } catch (e: any) {
      console.log("getPool() FAILED:", e.message?.slice(0, 100));
    }

    try {
      const baseTokenAddr = await lm.baseToken();
      console.log("baseToken():", baseTokenAddr);
    } catch (e: any) {
      console.log("baseToken() FAILED:", e.message?.slice(0, 100));
    }

    try {
      const tokenIdVal = await lm.tokenId();
      console.log("tokenId():", tokenIdVal.toString());
    } catch (e: any) {
      console.log("tokenId() FAILED:", e.message?.slice(0, 100));
    }
  }

  await network.provider.send("hardhat_stopImpersonatingAccount", [VAULT]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
