import { ethers } from "hardhat";

async function main() {
    console.log("Calling compound() to redeploy idle capital...");

    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);

    // Check idle balance
    const asset = await ethers.getContractAt("IERC20", await vault.asset());
    const balance = await asset.balanceOf(vaultAddress);
    console.log(`Idle Vault Balance: ${ethers.formatUnits(balance, 6)} USDC`);

    if (balance < 100n * 10n**6n) {
        console.log("Warning: Low balance, might hit minPositionSize limit.");
    }

    console.log("Sending compound tx...");
    const tx = await vault.compound();
    console.log("Tx hash:", tx.hash);
    await tx.wait();
    console.log("Compound complete.");
}

main().catch((error) => {
    console.error("Error:", error);
    if (error.data) console.log("Error Data:", error.data);
    process.exitCode = 1;
});