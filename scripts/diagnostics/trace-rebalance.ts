import { ethers } from "hardhat";

async function main() {
  const vaultAddr = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddr);

  const lmAddr = await vault.liquidityManager();
  const hmAddr = await vault.hedgeManager();
  const lm = await ethers.getContractAt("LiquidityManager", lmAddr);
  const hm = await ethers.getContractAt("HedgeManager", hmAddr);

  console.log("=== Tracing Rebalance Flow ===\n");

  // Step 1: Check circuit breaker
  console.log("Step 1: Circuit breaker check");
  const circuitBreakerEnabled = await vault.circuitBreakerEnabled();
  const circuitBreakerTriggered = await vault.circuitBreakerTriggered();
  console.log("  Enabled:", circuitBreakerEnabled);
  console.log("  Triggered:", circuitBreakerTriggered);

  // Step 2: Check LP position status
  console.log("\nStep 2: LP position check");
  const tokenId = await lm.tokenId();
  console.log("  Token ID:", tokenId.toString());

  if (tokenId > 0n) {
    const inRange = await lm.isInRange();
    console.log("  In range:", inRange);

    if (!inRange) {
      console.log("  LP is OUT OF RANGE - rebalance will try to adjust range");
      // Check if adjustRange would succeed
      try {
        const rangeWidthMultiplier = await vault.rangeWidthMultiplier();
        console.log("  Range width multiplier:", rangeWidthMultiplier.toString());

        const [newLower, newUpper] = await lm.getRebalanceTicks(rangeWidthMultiplier);
        console.log("  New tick lower:", newLower.toString());
        console.log("  New tick upper:", newUpper.toString());

        // Try staticCall adjustRange
        console.log("\n  Testing adjustRange staticCall...");
        await lm.adjustRange.staticCall(newLower, newUpper, Math.floor(Date.now() / 1000));
        console.log("  ✅ adjustRange would succeed");
      } catch (error: any) {
        console.log("  ❌ adjustRange would fail:", error.message);
        if (error.reason) console.log("     Reason:", error.reason);
      }
    }
  } else {
    console.log("  No LP position");
  }

  // Step 3: Calculate hedge target
  console.log("\nStep 3: Hedge target calculation");
  const lpDelta = await lm.getPositionDelta();
  const price = await lm.getOraclePrice();
  const deltaAbs = lpDelta > 0n ? lpDelta : -lpDelta;
  const hedgeTarget = (deltaAbs * price) / 10n ** 6n;

  console.log("  LP Delta:", ethers.formatUnits(lpDelta, 18), "ETH");
  console.log("  Price:", ethers.formatUnits(price, 18), "USD");
  console.log("  Hedge Target:", ethers.formatUnits(hedgeTarget, 30), "USD");

  // Step 4: Check hedge manager state
  console.log("\nStep 4: Hedge manager check");
  const hasPosition = await hm.hasPosition();
  const currentHedgeSize = await hm.getPositionSizeUsd();
  console.log("  Has position:", hasPosition);
  console.log("  Current size:", ethers.formatUnits(currentHedgeSize, 30), "USD");

  // Step 5: Check ETH balance for execution fee
  console.log("\nStep 5: Execution fee check");
  const execFee = await hm.getExecutionFee();
  const vaultEthBalance = await ethers.provider.getBalance(vaultAddr);
  console.log("  Exec fee required:", ethers.formatEther(execFee), "ETH");
  console.log("  Vault ETH balance:", ethers.formatEther(vaultEthBalance), "ETH");
  console.log("  Sufficient:", vaultEthBalance >= execFee ? "✅" : "❌");

  // Step 6: Check collateral for hedge
  console.log("\nStep 6: Collateral check");
  const usdc = await ethers.getContractAt("IERC20", await vault.asset());
  const vaultBalance = await usdc.balanceOf(vaultAddr);
  const maxLeverage = await hm.maxLeverage();
  const PRECISION = 10n ** 18n;

  // Calculate what _calculateRequiredCollateral would return
  const targetLeverage = 2n * PRECISION;
  const collateralUsd = (hedgeTarget * PRECISION) / targetLeverage;
  const requiredFor2x = collateralUsd / 10n ** 24n;
  const minCollateralUsd = (hedgeTarget * PRECISION) / maxLeverage;
  const requiredForMax = minCollateralUsd / 10n ** 24n;

  console.log("  Vault USDC:", ethers.formatUnits(vaultBalance, 6), "USDC");
  console.log("  Required (2x):", ethers.formatUnits(requiredFor2x, 6), "USDC");
  console.log("  Required (max leverage):", ethers.formatUnits(requiredForMax, 6), "USDC");

  // What will _calculateRequiredCollateral actually return?
  let collateralToUse: bigint;
  if (requiredFor2x <= vaultBalance) {
    collateralToUse = requiredFor2x;
  } else if (requiredForMax <= vaultBalance) {
    collateralToUse = vaultBalance;
  } else {
    collateralToUse = vaultBalance;
  }
  console.log("  Collateral to use:", ethers.formatUnits(collateralToUse, 6), "USDC");

  // Calculate resulting leverage
  const collateralUsdUsed = collateralToUse * 10n ** 24n;
  const resultingLeverage = collateralUsdUsed > 0n ? (hedgeTarget * PRECISION) / collateralUsdUsed : 0n;
  console.log("  Resulting leverage:", ethers.formatUnits(resultingLeverage, 18), "x");
  console.log("  Max leverage:", ethers.formatUnits(maxLeverage, 18), "x");
  console.log("  Within limits:", resultingLeverage <= maxLeverage ? "✅" : "❌");

  // Step 7: Check USDC allowance
  console.log("\nStep 7: Allowance check");
  const allowance = await usdc.allowance(vaultAddr, hmAddr);
  console.log("  Vault -> HedgeManager:", ethers.formatUnits(allowance, 6), "USDC");
  console.log("  Sufficient:", allowance >= collateralToUse ? "✅" : "❌");

  // Step 8: Check HedgeManager -> GMX approvals
  console.log("\nStep 8: GMX approval chain");
  const exchangeRouter = await hm.exchangeRouter();
  const routerContract = await ethers.getContractAt("IExchangeRouter", exchangeRouter);
  const router = await routerContract.router();
  const orderVault = await hm.orderVault();

  const hmUsdcBalance = await usdc.balanceOf(hmAddr);
  const hmAllowanceToRouter = await usdc.allowance(hmAddr, router);
  const hmAllowanceToExchange = await usdc.allowance(hmAddr, exchangeRouter);

  console.log("  HedgeManager USDC balance:", ethers.formatUnits(hmUsdcBalance, 6));
  console.log("  HedgeManager -> Router allowance:", ethers.formatUnits(hmAllowanceToRouter, 6));
  console.log("  HedgeManager -> ExchangeRouter allowance:", ethers.formatUnits(hmAllowanceToExchange, 6));
  console.log("  Order vault:", orderVault);

  // Summary
  console.log("\n=== SUMMARY ===");
  const issues: string[] = [];

  if (circuitBreakerTriggered) {
    issues.push("Circuit breaker is triggered");
  }
  if (tokenId > 0n) {
    const inRange = await lm.isInRange();
    if (!inRange) {
      issues.push("LP position is out of range (adjustRange will be called first)");
    }
  }
  if (vaultEthBalance < execFee) {
    issues.push("Insufficient ETH for execution fee");
  }
  if (resultingLeverage > maxLeverage) {
    issues.push("Resulting leverage would exceed max");
  }

  if (issues.length === 0) {
    console.log("No obvious issues found in preconditions.");
    console.log("The revert is likely happening inside GMX or during order creation.");
  } else {
    console.log("Potential issues:");
    issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
