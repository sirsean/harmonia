import { ethers } from "hardhat";

async function main() {
    const hedgeManagerAddress = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
    const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);

    const oldSize = await hm.minPositionSize();
    console.log("Old min position size:", oldSize.toString());

    // Set to 0
    const newSize = 0;
    console.log("Setting min position size to:", newSize.toString());

    const tx = await hm.setMinPositionSize(newSize);
    console.log("Tx hash:", tx.hash);
    await tx.wait();

    console.log("Min position size set successfully.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
