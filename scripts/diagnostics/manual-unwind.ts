import { ethers } from "hardhat";

async function main() {
    console.log("Manual LP Unwind...");

    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
    const lmAddress = await vault.liquidityManager();
    const lm = await ethers.getContractAt("LiquidityManager", lmAddress);

    console.log("Closing LP position...");
    const tx = await lm.closePosition();
    console.log("Tx:", tx.hash);
    await tx.wait();
    console.log("LP Closed.");
    
    // Now verify Vault balances
    const asset = await ethers.getContractAt("IERC20", await vault.asset());
    const balance = await asset.balanceOf(vaultAddress);
    console.log(`Vault USDC: ${ethers.formatUnits(balance, 6)}`);
    
    // Now compound
    console.log("Compounding...");
    await vault.compound();
    console.log("Compounded.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
