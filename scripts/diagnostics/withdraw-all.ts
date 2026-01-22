import { ethers } from "hardhat";

async function main() {
    console.log("Withdrawing all funds...");

    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
    
    const [signer] = await ethers.getSigners();
    const balance = await vault.balanceOf(signer.address);
    console.log(`Shares: ${ethers.formatUnits(balance, 18)}`);

    if (balance > 0) {
        console.log("Redeeming...");
        const tx = await vault.redeem(balance, signer.address, signer.address);
        console.log("Tx:", tx.hash);
        await tx.wait();
        console.log("Redeemed.");
    } else {
        console.log("No shares to redeem.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
