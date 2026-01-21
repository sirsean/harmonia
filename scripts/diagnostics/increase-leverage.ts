import { ethers } from "hardhat";

async function main() {
    const hedgeManagerAddress = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
    const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);

    const oldLeverage = await hm.maxLeverage();
    console.log("Old max leverage:", ethers.formatUnits(oldLeverage, 18));

    // Set to 10x
    const newLeverage = ethers.parseUnits("10", 18);
    console.log("Setting max leverage to:", ethers.formatUnits(newLeverage, 18));

    const tx = await hm.setMaxLeverage(newLeverage);
    console.log("Tx hash:", tx.hash);
    await tx.wait();

    console.log("Max leverage set successfully.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
