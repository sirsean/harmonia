import { ethers } from "hardhat";

const TX_HASH = "0xa4be74cfb729aaafc189f28b912b60e29d21420f9d173f50936237fdf590f93d";
const VAULT_ADDRESS = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
const HM_ADDRESS = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";

async function main() {
  console.log("=== Checking Events ===");
  console.log("Tx:", TX_HASH);

  const receipt = await ethers.provider.getTransactionReceipt(TX_HASH);
  const vault = await ethers.getContractAt("DeltaNeutralVault", VAULT_ADDRESS);
  const hm = await ethers.getContractAt("HedgeManager", HM_ADDRESS);

  for (const log of receipt?.logs || []) {
    if (log.address.toLowerCase() === VAULT_ADDRESS.toLowerCase()) {
      try {
        const parsed = vault.interface.parseLog({
          topics: [...log.topics],
          data: log.data
        });
        console.log("\nVault Event:", parsed?.name);
        console.log("Args:", parsed?.args);
      } catch (e) { }
    }
    if (log.address.toLowerCase() === HM_ADDRESS.toLowerCase()) {
      try {
        const parsed = hm.interface.parseLog({
          topics: [...log.topics],
          data: log.data
        });
        console.log("\nHM Event:", parsed?.name);
        console.log("Args:", parsed?.args);
      } catch (e) { }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
