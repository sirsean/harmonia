import { ethers } from "hardhat";

async function main() {
  const hedgeManagerAddress = process.env.HEDGE_MANAGER || "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
  const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);
  const execFee = await hm.getExecutionFee();

  console.log("HedgeManager:", hedgeManagerAddress);
  console.log("Execution fee:", execFee.toString());

  try {
    const tx = await hm.adjustHedge(0, { value: execFee });
    console.log("Tx hash:", tx.hash);
    await tx.wait();
    console.log("adjustHedge(0) succeeded");
  } catch (error) {
    console.error("adjustHedge(0) failed:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
