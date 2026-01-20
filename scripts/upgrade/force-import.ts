/**
 * Registers an existing UUPS proxy in the Hardhat upgrades manifest.
 *
 * Usage:
 *   CONTRACT=HedgeManager PROXY_ADDRESS=0x... \
 *     npx hardhat run scripts/upgrade/force-import.ts --network arbitrum
 */

import { ethers, upgrades, network } from "hardhat";

async function main() {
  const contractName = process.env.CONTRACT;
  const proxyAddress = process.env.PROXY_ADDRESS;

  if (!contractName || !proxyAddress) {
    throw new Error("Missing required env vars: CONTRACT and PROXY_ADDRESS.");
  }

  const factory = await ethers.getContractFactory(contractName);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("\n" + "=".repeat(60));
  console.log("HARMONIA FORCE IMPORT (UUPS)");
  console.log("=".repeat(60));
  console.log("Network:", network.name, `(chainId ${chainId})`);
  console.log("Contract:", contractName);
  console.log("Proxy:", proxyAddress);
  console.log("=".repeat(60) + "\n");

  await upgrades.forceImport(proxyAddress, factory, { kind: "uups" });
  console.log("Force import complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
