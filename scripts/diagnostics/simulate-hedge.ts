import { ethers } from "hardhat";

async function main() {
  const vaultAddr = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddr);

  const lmAddr = await vault.liquidityManager();
  const hmAddr = await vault.hedgeManager();
  const lm = await ethers.getContractAt("LiquidityManager", lmAddr);
  const hm = await ethers.getContractAt("HedgeManager", hmAddr);

  // Calculate hedge target same as vault does
  const lpDelta = await lm.getPositionDelta();
  const price = await lm.getOraclePrice();
  const deltaAbs = lpDelta > 0n ? lpDelta : -lpDelta;

  // hedgeTarget = (deltaAbs * price) / 10^6 (for 18-decimal base token)
  const hedgeTarget = (deltaAbs * price) / 10n ** 6n;

  console.log("=== Simulating adjustHedge ===\n");
  console.log("Hedge Target (30d USD):", hedgeTarget.toString());
  console.log("Hedge Target (USD):", ethers.formatUnits(hedgeTarget, 30));

  // Check what collateral would be calculated
  const PRECISION = 10n ** 18n;
  const maxLeverage = await hm.maxLeverage();
  const targetLeverage = 2n * PRECISION;

  const collateralUsd = (hedgeTarget * PRECISION) / targetLeverage;
  const requiredFor2x = collateralUsd / 10n ** 24n;

  const minCollateralUsd = (hedgeTarget * PRECISION) / maxLeverage;
  const requiredForMax = minCollateralUsd / 10n ** 24n;

  console.log("\nRequired collateral for 2x:", ethers.formatUnits(requiredFor2x, 6), "USDC");
  console.log("Required collateral for max:", ethers.formatUnits(requiredForMax, 6), "USDC");

  const usdc = await ethers.getContractAt("IERC20", await vault.asset());
  const vaultBalance = await usdc.balanceOf(vaultAddr);
  console.log("Vault USDC balance:", ethers.formatUnits(vaultBalance, 6), "USDC");

  // Simulate the staticCall to adjustHedge
  const execFee = await hm.getExecutionFee();
  console.log("\nExecution fee:", ethers.formatEther(execFee), "ETH");

  // Try calling rebalance(0) on the vault via staticCall
  console.log("\n=== Attempting vault.rebalance.staticCall(0) ===");
  try {
    await vault.rebalance.staticCall(0);
    console.log("✅ vault.rebalance(0) would succeed!");
  } catch (error: any) {
    console.log("❌ vault.rebalance(0) reverted:");
    console.log("   Message:", error.message);
    if (error.data) {
      console.log("   Error data:", error.data);
    }
    if (error.reason) {
      console.log("   Reason:", error.reason);
    }

    // Try to decode custom error
    if (error.data && error.data.length > 2) {
      console.log("\n   Attempting to decode error...");
      const selector = error.data.slice(0, 10);
      console.log("   Error selector:", selector);

      // Common error selectors
      const knownErrors: Record<string, string> = {
        "0x08c379a0": "Error(string)",
        "0x4e487b71": "Panic(uint256)",
      };

      if (knownErrors[selector]) {
        console.log("   Known error type:", knownErrors[selector]);
        try {
          if (selector === "0x08c379a0") {
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ["string"],
              "0x" + error.data.slice(10)
            );
            console.log("   Decoded message:", decoded[0]);
          }
        } catch {
          console.log("   Could not decode error data");
        }
      }
    }
  }

  // Also try directly calling adjustHedge on HedgeManager
  console.log("\n=== Attempting hm.adjustHedge.staticCall(hedgeTarget) directly ===");
  const [signer] = await ethers.getSigners();

  // We need to impersonate the vault for this
  console.log("(Note: This may fail because caller isn't vault or owner)");

  try {
    await hm.connect(signer).adjustHedge.staticCall(hedgeTarget, { value: execFee });
    console.log("✅ adjustHedge would succeed!");
  } catch (error: any) {
    console.log("❌ adjustHedge reverted:");
    console.log("   Message:", error.message);
    if (error.reason) {
      console.log("   Reason:", error.reason);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
