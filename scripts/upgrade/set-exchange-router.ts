import { ethers } from "hardhat";

async function main() {
  const hedgeManagerAddress = process.env.HEDGE_MANAGER || "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
  const routerAddress = process.env.EXCHANGE_ROUTER || "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41";

  const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);
  console.log("HedgeManager:", hedgeManagerAddress);
  console.log("Setting exchange router to:", routerAddress);

  const tx = await hm.setExchangeRouter(routerAddress);
  console.log("Tx hash:", tx.hash);
  await tx.wait();
  console.log("Exchange router updated.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
