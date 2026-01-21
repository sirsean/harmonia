import { ethers } from "hardhat";

async function main() {
    const hedgeManagerAddress = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
    const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);

    const oldFee = await hm.executionFeeOverride();
    console.log("Old exec fee:", ethers.formatEther(oldFee));

    // Increase to 0.01 ETH
    const newFee = ethers.parseEther("0.01");
    console.log("Setting exec fee to:", ethers.formatEther(newFee));

    const tx = await hm.setExecutionFeeOverride(newFee);
    console.log("Tx hash:", tx.hash);
    await tx.wait();

    console.log("Exec fee set successfully.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
