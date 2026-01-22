import { ethers } from "hardhat";

async function main() {
    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const [signer] = await ethers.getSigners();
    
    console.log("Funding Vault with ETH...");
    const tx = await signer.sendTransaction({
        to: vaultAddress,
        value: ethers.parseEther("0.05")
    });
    console.log("Tx:", tx.hash);
    await tx.wait();
    console.log("Funded.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
