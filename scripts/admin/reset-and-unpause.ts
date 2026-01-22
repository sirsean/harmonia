import { ethers } from "hardhat";

const DEFAULT_VAULT = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || DEFAULT_VAULT;
  const dryRun = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";

  console.log("=== Reset Circuit Breaker and Unpause ===");
  console.log("Vault:", vaultAddress);
  console.log("Mode:", dryRun ? "DRY RUN" : "LIVE");
  console.log("");

  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);

  const [paused, circuitBreakerTriggered, deltaThreshold, owner] = await Promise.all([
    vault.paused(),
    vault.circuitBreakerTriggered(),
    vault.deltaThreshold(),
    vault.owner(),
  ]);

  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);
  console.log("Owner:", owner);
  console.log("Paused:", paused);
  console.log("Circuit breaker triggered:", circuitBreakerTriggered);
  console.log("Delta threshold:", ethers.formatUnits(deltaThreshold, 16), "%");

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    console.error("\nError: Signer is not the owner. Cannot proceed.");
    process.exitCode = 1;
    return;
  }

  // Check delta ratio before attempting reset
  const deltaRatio = await vault.getDeltaRatio();
  const absRatio = deltaRatio >= 0n ? deltaRatio : -deltaRatio;
  console.log("Current delta ratio:", ethers.formatUnits(absRatio, 16), "%");

  if (absRatio > deltaThreshold) {
    console.error("\nError: Delta ratio too high to reset circuit breaker.");
    console.error("Need to rebalance first.");
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log("\n[DRY RUN] Would execute:");
    if (circuitBreakerTriggered) {
      console.log("  1. vault.resetCircuitBreaker()");
    }
    if (paused) {
      console.log("  2. vault.unpause()");
    }
    if (!circuitBreakerTriggered && !paused) {
      console.log("  Nothing to do - vault is already active.");
    }
    return;
  }

  // Execute reset and unpause
  if (circuitBreakerTriggered) {
    console.log("\nResetting circuit breaker...");
    const tx1 = await vault.resetCircuitBreaker();
    console.log("Transaction:", tx1.hash);
    await tx1.wait();
    console.log("Circuit breaker reset.");
  }

  if (paused) {
    console.log("\nUnpausing vault...");
    const tx2 = await vault.unpause();
    console.log("Transaction:", tx2.hash);
    await tx2.wait();
    console.log("Vault unpaused.");
  }

  // Verify final state
  const [finalPaused, finalCircuitBreaker] = await Promise.all([
    vault.paused(),
    vault.circuitBreakerTriggered(),
  ]);

  console.log("\n=== Final State ===");
  console.log("Paused:", finalPaused);
  console.log("Circuit breaker triggered:", finalCircuitBreaker);

  if (!finalPaused && !finalCircuitBreaker) {
    console.log("\nVault is now operational.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
