import { ethers } from "hardhat";

const HM_ADDRESS = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";

async function main() {
  const hm = await ethers.getContractAt("HedgeManager", HM_ADDRESS);
  const minSize = await hm.minPositionSize();
  console.log("Min Position Size:", minSize.toString());
  console.log("Min Position Size (USD):", ethers.formatUnits(minSize, 30));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
