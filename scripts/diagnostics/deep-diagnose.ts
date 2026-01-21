import { ethers } from "hardhat";

async function main() {
  const vaultAddr = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddr);

  // Get managers
  const lmAddr = await vault.liquidityManager();
  const hmAddr = await vault.hedgeManager();
  const lm = await ethers.getContractAt("LiquidityManager", lmAddr);
  const hm = await ethers.getContractAt("HedgeManager", hmAddr);

  // Get key values
  const lpDelta = await lm.getPositionDelta();
  const price = await lm.getOraclePrice();
  const maxLeverage = await hm.maxLeverage();
  const minPositionSize = await hm.minPositionSize();

  console.log("=== Deep Diagnostic for performUpkeep ===\n");

  // Calculate target hedge (same logic as _executeRebalance)
  const deltaAbs = lpDelta > 0n ? lpDelta : -lpDelta;

  const baseToken = await lm.baseToken();
  const baseContract = await ethers.getContractAt("IERC20Metadata", baseToken);
  const baseDecimals = await baseContract.decimals();
  console.log("Base token:", baseToken);
  console.log("Base decimals:", baseDecimals.toString());
  console.log("LP Delta:", ethers.formatUnits(lpDelta, Number(baseDecimals)), "ETH");
  console.log("Oracle price:", ethers.formatUnits(price, 18), "USD");

  // From the vault code:
  // if (decimals <= 12) { hedgeTarget = deltaAbs * price * (10 ** (12 - decimals)); }
  // else { hedgeTarget = (deltaAbs * price) / (10 ** (decimals - 12)); }
  // decimals = 18, so: hedgeTarget = (deltaAbs * price) / (10 ** (18 - 12)) = (deltaAbs * price) / 10^6
  const hedgeTargetCalc = (deltaAbs * price) / 10n ** 6n;
  console.log("\nHedge target (30d):", hedgeTargetCalc.toString());
  console.log("Hedge target (USD):", ethers.formatUnits(hedgeTargetCalc, 30));

  // Check collateral requirements
  const PRECISION = 10n ** 18n;
  const targetLeverage = 2n * PRECISION;
  const collateralUsd = (hedgeTargetCalc * PRECISION) / targetLeverage;
  const requiredFor2x = collateralUsd / 10n ** 24n;

  const minCollateralUsd = (hedgeTargetCalc * PRECISION) / maxLeverage;
  const requiredFor3x = minCollateralUsd / 10n ** 24n;

  console.log("\n=== Collateral Requirements ===");
  console.log("Max leverage:", ethers.formatUnits(maxLeverage, 18), "x");
  console.log("Required for 2x leverage:", ethers.formatUnits(requiredFor2x, 6), "USDC");
  console.log("Required for 3x leverage:", ethers.formatUnits(requiredFor3x, 6), "USDC");

  // Check vault USDC balance
  const usdc = await ethers.getContractAt("IERC20", await vault.asset());
  const vaultBalance = await usdc.balanceOf(vaultAddr);
  console.log("Vault USDC balance:", ethers.formatUnits(vaultBalance, 6), "USDC");

  // Check if sufficient
  console.log("\n=== COLLATERAL DIAGNOSIS ===");
  if (vaultBalance < requiredFor3x) {
    console.log("❌ INSUFFICIENT COLLATERAL: Vault has less than required for max leverage (3x)");
    console.log("   Shortfall:", ethers.formatUnits(requiredFor3x - vaultBalance, 6), "USDC");
  } else if (vaultBalance < requiredFor2x) {
    console.log("⚠️  Vault has enough for 3x but not 2x leverage");
    console.log("   Will use available balance at higher leverage");
  } else {
    console.log("✅ Vault has sufficient collateral for 2x leverage");
  }

  // Check min position size
  console.log("\n=== POSITION SIZE CHECK ===");
  console.log("Min position size (30d):", minPositionSize.toString());
  console.log("Min position size (USD):", ethers.formatUnits(minPositionSize, 30));
  console.log("Hedge target vs min:", hedgeTargetCalc >= minPositionSize ? "✅ OK" : "❌ TOO SMALL");

  // Check for ETH execution fee
  const execFee = await hm.getExecutionFee();
  const vaultEthBalance = await ethers.provider.getBalance(vaultAddr);
  console.log("\n=== EXECUTION FEE CHECK ===");
  console.log("Execution fee required:", ethers.formatEther(execFee), "ETH");
  console.log("Vault ETH balance:", ethers.formatEther(vaultEthBalance), "ETH");
  console.log("Sufficient ETH:", vaultEthBalance >= execFee ? "✅ YES" : "❌ NO");

  // Check order vault
  const orderVault = await hm.orderVault();
  console.log("\n=== GMX CONFIG CHECK ===");
  console.log("Order vault:", orderVault);
  console.log("Order vault set:", orderVault !== ethers.ZeroAddress ? "✅ YES" : "❌ NO");

  // Check USDC allowance from vault to hedgeManager
  const allowance = await usdc.allowance(vaultAddr, hmAddr);
  console.log("Vault -> HedgeManager allowance:", ethers.formatUnits(allowance, 6), "USDC");

  // Summary
  console.log("\n=== SUMMARY ===");
  const issues: string[] = [];
  if (vaultBalance < requiredFor3x) {
    issues.push(`Insufficient collateral: need ${ethers.formatUnits(requiredFor3x, 6)} USDC, have ${ethers.formatUnits(vaultBalance, 6)} USDC`);
  }
  if (vaultEthBalance < execFee) {
    issues.push(`Insufficient ETH for execution fee: need ${ethers.formatEther(execFee)}, have ${ethers.formatEther(vaultEthBalance)}`);
  }
  if (orderVault === ethers.ZeroAddress) {
    issues.push("Order vault not set in HedgeManager");
  }

  if (issues.length === 0) {
    console.log("No obvious issues found. Revert may be from GMX side.");
  } else {
    console.log("Issues found:");
    issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
