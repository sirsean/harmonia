import { ethers } from "hardhat";

async function main() {
    console.log("Manually adjusting range as owner...");

    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
    const lmAddress = await vault.liquidityManager();
    const lm = await ethers.getContractAt("LiquidityManager", lmAddress);

    // Get new ticks
    // Use default multiplier 20
    const { newTickLower, newTickUpper } = await lm.getRebalanceTicks(20);
    console.log(`New Range: [${newTickLower}, ${newTickUpper}]`);

    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 mins

    // Call adjustRange
    // This will: close old, swap tokens (new feature!), mint new
    console.log("Calling adjustRange...");
    const tx = await lm.adjustRange(newTickLower, newTickUpper, deadline);
    console.log("Tx hash:", tx.hash);
    await tx.wait();
    console.log("Range adjusted successfully.");

    // Now rebalance the hedge
    console.log("Triggering vault rebalance to fix hedge...");
    // We expect this to work now because delta should be healthy
    const tx2 = await vault.rebalance(0);
    console.log("Rebalance Tx:", tx2.hash);
    await tx2.wait();
    console.log("Hedge rebalanced.");
}

main().catch((error) => {
    console.error("Error:", error);
    if (error.data) console.log("Error Data:", error.data);
    process.exitCode = 1;
});
