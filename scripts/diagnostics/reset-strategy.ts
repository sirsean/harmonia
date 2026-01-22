import { ethers } from "hardhat";

async function main() {
    console.log("Resetting strategy via Emergency Unwind...");

    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);

    // 1. Emergency Unwind
    console.log("Calling emergencyUnwind...");
    const tx1 = await vault.emergencyUnwind();
    await tx1.wait();
    console.log("Unwound.");

    // 2. Unpause
    console.log("Unpausing...");
    const tx2 = await vault.unpause();
    await tx2.wait();
    console.log("Unpaused.");

    // 3. Reset Circuit Breaker (if triggered)
    const cb = await vault.circuitBreakerTriggered();
    if (cb) {
        console.log("Resetting Circuit Breaker...");
        // resetCircuitBreaker requires delta to be safe.
        // If we unwound, delta should be 0.
        const tx3 = await vault.resetCircuitBreaker();
        await tx3.wait();
        console.log("Circuit Breaker reset.");
    }

    // 4. Compound (Redeploy)
    console.log("Compounding to redeploy...");
    const tx4 = await vault.compound();
    console.log("Compound Tx:", tx4.hash);
    await tx4.wait();
    console.log("Strategy restarted.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
