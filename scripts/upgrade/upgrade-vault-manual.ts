import { ethers } from "hardhat";

const VAULT_PROXY = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";

async function main() {
  console.log("=== Manual Vault Upgrade ===");
  console.log("Proxy:", VAULT_PROXY);

  // Deploy new implementation
  console.log("Deploying new DeltaNeutralVault implementation...");
  const VaultFactory = await ethers.getContractFactory("DeltaNeutralVault");
  const newImpl = await VaultFactory.deploy();
  await newImpl.waitForDeployment();
  const newImplAddress = await newImpl.getAddress();
  console.log("New implementation deployed:", newImplAddress);

  // Upgrade the proxy
  console.log("\nUpgrading proxy...");
  const proxy = await ethers.getContractAt("DeltaNeutralVault", VAULT_PROXY);
  const tx = await proxy.upgradeToAndCall(newImplAddress, "0x");
  console.log("Upgrade tx:", tx.hash);
  await tx.wait();
  console.log("Upgrade complete!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

