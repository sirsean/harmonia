import { ethers } from "hardhat";

const DEFAULT_VAULT = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || DEFAULT_VAULT;

  console.log("=== Step-by-Step Compound Diagnosis ===");
  console.log("Vault:", vaultAddress);
  console.log("");

  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);

  // Get addresses
  const [lmAddress, hmAddress, asset] = await Promise.all([
    vault.liquidityManager(),
    vault.hedgeManager(),
    vault.asset(),
  ]);

  const lm = await ethers.getContractAt("LiquidityManager", lmAddress);
  const hm = await ethers.getContractAt("HedgeManager", hmAddress);

  // Step 1: Check if compound would try to process fees
  console.log("=== Step 1: Fee calculation ===");
  const [protocolFeeBps, treasury, idle] = await Promise.all([
    vault.protocolFeeBps(),
    vault.treasury(),
    ethers.getContractAt("IERC20", asset).then(t => t.balanceOf(vaultAddress)),
  ]);
  console.log("Protocol fee bps:", protocolFeeBps.toString());
  console.log("Treasury:", treasury);
  console.log("Idle assets:", ethers.formatUnits(idle, 6));

  if (protocolFeeBps > 0n && treasury !== ethers.ZeroAddress) {
    const feeAssets = (idle * protocolFeeBps) / 10000n;
    console.log("Fee assets:", ethers.formatUnits(feeAssets, 6));

    try {
      const feeShares = await vault.convertToShares(feeAssets);
      console.log("Fee shares:", ethers.formatUnits(feeShares, 6));
      console.log("Step 1: PASS");
    } catch (e: any) {
      console.log("Step 1: FAIL - convertToShares error:", e.message);
    }
  } else {
    console.log("Step 1: SKIP - no fees configured");
  }

  // Step 2: Check deployCapital sub-steps
  console.log("\n=== Step 2: Deploy capital calculation ===");
  const totalIdle = idle;
  const collateralAmount = (totalIdle * 30n) / 100n;
  const lpAmount = totalIdle > collateralAmount ? totalIdle - collateralAmount : 0n;
  console.log("Total idle:", ethers.formatUnits(totalIdle, 6));
  console.log("Collateral (30%):", ethers.formatUnits(collateralAmount, 6));
  console.log("LP amount (70%):", ethers.formatUnits(lpAmount, 6));

  // Step 3: Test swapForLP calculation
  console.log("\n=== Step 3: swapForLP calculation ===");
  const rangeMultiplier = await vault.rangeWidthMultiplier();
  console.log("Range multiplier:", rangeMultiplier.toString());

  // Get pool data to calculate expected swap
  const pool = await lm.getPool();
  const poolContract = await ethers.getContractAt("IUniswapV3Pool", pool);
  const slot0 = await poolContract.slot0();
  const sqrtPriceX96 = slot0[0];
  console.log("Pool sqrtPriceX96:", sqrtPriceX96.toString());

  const [tickLower, tickUpper] = await lm.getRebalanceTicks(rangeMultiplier);
  console.log("Rebalance ticks:", tickLower.toString(), "-", tickUpper.toString());

  // Step 4: Test increase liquidity requirements
  console.log("\n=== Step 4: Increase liquidity requirements ===");
  const baseToken = await lm.baseToken();
  const quoteToken = await lm.quoteToken();
  const weth = await ethers.getContractAt("IERC20", baseToken);
  const usdc = await ethers.getContractAt("IERC20", quoteToken);

  const [vaultWeth, vaultUsdc] = await Promise.all([
    weth.balanceOf(vaultAddress),
    usdc.balanceOf(vaultAddress),
  ]);
  console.log("Vault WETH:", ethers.formatEther(vaultWeth));
  console.log("Vault USDC:", ethers.formatUnits(vaultUsdc, 6));

  // Step 5: Test hedge requirements
  console.log("\n=== Step 5: Hedge requirements ===");
  const lpDelta = await lm.getPositionDelta();
  const oraclePrice = await lm.getOraclePrice();
  console.log("LP delta:", lpDelta.toString());
  console.log("Oracle price (18d):", ethers.formatUnits(oraclePrice, 18));

  // Calculate hedge target
  let hedgeTarget = 0n;
  if (lpDelta > 0n) {
    const deltaAbs = lpDelta;
    // hedgeTarget in 30 decimals for 18 decimal base token
    hedgeTarget = deltaAbs * oraclePrice * (10n ** 12n) / (10n ** 18n);
  }
  console.log("Hedge target (30d):", hedgeTarget.toString());
  console.log("Hedge target (USD):", ethers.formatUnits(hedgeTarget, 30));

  // Check execution fee
  const [execFee, vaultEth] = await Promise.all([
    hm.getExecutionFee(),
    ethers.provider.getBalance(vaultAddress),
  ]);
  console.log("Execution fee:", ethers.formatEther(execFee));
  console.log("Vault ETH:", ethers.formatEther(vaultEth));

  if (vaultEth >= execFee) {
    console.log("Step 5: PASS - sufficient ETH for fee");
  } else {
    console.log("Step 5: FAIL - insufficient ETH for fee");
  }

  // Try to simulate rebalance directly
  console.log("\n=== Step 6: Test rebalance directly ===");
  try {
    await vault.rebalance.staticCall(0);
    console.log("rebalance(0) staticCall: PASS");
  } catch (e: any) {
    console.log("rebalance(0) staticCall: FAIL");
    console.log("Error:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
      // Try to decode
      try {
        const iface = new ethers.Interface([
          "error OnlyVault()",
          "error Unauthorized(address)",
          "error EnforcedPause()",
          "error ZeroAmount()",
          "error InsufficientExecutionFee()",
          "error PositionTooSmall()",
        ]);
        const decoded = iface.parseError(e.data);
        console.log("Decoded error:", decoded?.name);
      } catch {
        // ignore
      }
    }
  }

  // Try simulate collectFees
  console.log("\n=== Step 7: Test collectFees ===");
  try {
    await lm.collectFees.staticCall();
    console.log("collectFees staticCall: PASS");
  } catch (e: any) {
    console.log("collectFees staticCall: FAIL -", e.message);
  }

  // The issue might be in the rebalance. Let me trace what happens
  console.log("\n=== Step 8: Check _executeRebalance flow ===");
  const inRange = await lm.isInRange();
  console.log("Position in range:", inRange);

  if (!inRange) {
    console.log("Position out of range - adjustRange would be called");
    try {
      const [newTickLower, newTickUpper] = await lm.getRebalanceTicks(rangeMultiplier);
      await lm.adjustRange.staticCall(newTickLower, newTickUpper, BigInt(Math.floor(Date.now() / 1000)) + 300n);
      console.log("adjustRange staticCall: PASS");
    } catch (e: any) {
      console.log("adjustRange staticCall: FAIL -", e.message);
    }
  } else {
    console.log("Position in range - no adjustRange needed");
  }

  // Step 9: Test swapForLP from owner perspective (should work as owner passes onlyVault)
  console.log("\n=== Step 9: Test swapForLP ===");
  try {
    // swapForLP(address tokenIn, uint256 amountIn, int24 rangeWidthMultiplier, uint256 deadline)
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 300n;
    await lm.swapForLP.staticCall(asset, lpAmount, rangeMultiplier, deadline);
    console.log("swapForLP staticCall: PASS");
  } catch (e: any) {
    console.log("swapForLP staticCall: FAIL");
    console.log("Error message:", e.message);
    console.log("Error code:", e.code);

    // Check if it's a transfer from issue
    const assetContract = await ethers.getContractAt("IERC20", asset);
    const [signer] = await ethers.getSigners();
    const signerBalance = await assetContract.balanceOf(signer.address);
    console.log("Signer balance:", ethers.formatUnits(signerBalance, 6));

    // The issue is likely that the caller (signer) needs to have tokens
    // because swapForLP does safeTransferFrom(msg.sender, ...)
    console.log("Note: swapForLP transfers from msg.sender, so caller needs tokens");
  }

  // Step 10: Test mintPosition / increaseLiquidity in isolation
  console.log("\n=== Step 10: Test mint/increase position ===");
  const tokenId = await lm.tokenId();
  console.log("Current token ID:", tokenId.toString());

  const [token0, token1] = baseToken < quoteToken ? [baseToken, quoteToken] : [quoteToken, baseToken];
  const amount0 = baseToken < quoteToken ? vaultWeth : vaultUsdc;
  const amount1 = baseToken < quoteToken ? vaultUsdc : vaultWeth;

  if (tokenId !== 0n) {
    // Has existing position - test increaseLiquidity
    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + 300n;
      await lm.increaseLiquidity.staticCall(amount0, amount1, deadline);
      console.log("increaseLiquidity staticCall: PASS");
    } catch (e: any) {
      console.log("increaseLiquidity staticCall: FAIL -", e.message);
    }
  } else {
    // No position - test mintPosition
    const [newTickLower, newTickUpper] = await lm.getRebalanceTicks(rangeMultiplier);
    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + 300n;
      await lm.mintPosition.staticCall(newTickLower, newTickUpper, amount0, amount1, deadline);
      console.log("mintPosition staticCall: PASS");
    } catch (e: any) {
      console.log("mintPosition staticCall: FAIL -", e.message);
    }
  }

  // Step 11: Actually send compound() tx to get better error info
  console.log("\n=== Step 11: Estimate gas for compound ===");
  try {
    const gasEstimate = await vault.compound.estimateGas();
    console.log("Gas estimate: PASS -", gasEstimate.toString());
  } catch (e: any) {
    console.log("Gas estimate: FAIL");
    console.log("Error:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
    }
    if (e.info?.error?.data) {
      console.log("Inner error data:", e.info.error.data);
    }
  }

  // Finally test compound with verbose error
  console.log("\n=== Final: Test compound with error capture ===");
  try {
    const result = await vault.compound.staticCall();
    console.log("compound() succeeded! Result:", result);
  } catch (e: any) {
    console.log("compound() FAILED");
    console.log("Full error:", e);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
