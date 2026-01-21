import { ethers } from "hardhat";

async function main() {
    const hedgeManagerAddress = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
    const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);

    const oldSlippage = await hm.slippageTolerance();
    console.log("Old slippage:", oldSlippage.toString());

    // Set to 5% (0.05 * 1e18 = 50000000000000000)
    const newSlippage = 50000000000000000n;
    console.log("Setting slippage to:", newSlippage.toString());

    const tx = await hm.setSlippageTolerance(newSlippage);
    console.log("Tx hash:", tx.hash);
    await tx.wait();

    console.log("Slippage set successfully.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
