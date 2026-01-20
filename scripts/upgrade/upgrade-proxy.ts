/**
 * UUPS upgrade helper for Harmonia core contracts.
 *
 * Examples:
 *   CONTRACT=DeltaNeutralVault PROXY_ADDRESS=0x... MODE=prepare \
 *     npx hardhat run scripts/upgrade/upgrade-proxy.ts --network arbitrum
 *
 *   CONTRACT=HedgeManager PROXY_ADDRESS=0x... MODE=upgrade \
 *     npx hardhat run scripts/upgrade/upgrade-proxy.ts --network arbitrum
 *
 *   CONTRACT=DeltaNeutralVault PROXY_ADDRESS=0x... MODE=upgrade \
 *     INIT_FUNCTION=initializeV2 INIT_ARGS='[123]' \
 *     npx hardhat run scripts/upgrade/upgrade-proxy.ts --network arbitrum
 */

import { ethers, upgrades, network } from "hardhat";

type UpgradeMode = "prepare" | "upgrade";

function parseMode(rawMode: string | undefined): UpgradeMode {
  const mode = (rawMode || "prepare").toLowerCase();
  if (mode !== "prepare" && mode !== "upgrade") {
    throw new Error(`Invalid MODE "${rawMode}". Use "prepare" or "upgrade".`);
  }
  return mode as UpgradeMode;
}

function parseInitArgs(raw: string | undefined): unknown[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("INIT_ARGS must be a JSON array, e.g. '[123, \"0x...\"]'.");
  }
  return parsed;
}

async function main() {
  const contractName = process.env.CONTRACT;
  const proxyAddress = process.env.PROXY_ADDRESS;
  const mode = parseMode(process.env.MODE);
  const initFunction = process.env.INIT_FUNCTION;
  const initArgsRaw = process.env.INIT_ARGS;

  if (!contractName || !proxyAddress) {
    throw new Error("Missing required env vars: CONTRACT and PROXY_ADDRESS.");
  }

  if (!initFunction && initArgsRaw) {
    throw new Error("INIT_ARGS provided without INIT_FUNCTION.");
  }

  const initArgs = initFunction ? parseInitArgs(initArgsRaw) : [];
  const factory = await ethers.getContractFactory(contractName);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("\n" + "=".repeat(60));
  console.log("HARMONIA UUPS UPGRADE");
  console.log("=".repeat(60));
  console.log("Network:", network.name, `(chainId ${chainId})`);
  console.log("Contract:", contractName);
  console.log("Proxy:", proxyAddress);
  console.log("Mode:", mode);
  if (initFunction) {
    console.log("Init function:", initFunction);
    console.log("Init args:", initArgs);
  }
  console.log("=".repeat(60) + "\n");

  // Validate storage layout and upgrade safety.
  await upgrades.validateUpgrade(proxyAddress, factory, { kind: "uups" });

  if (mode === "prepare") {
    const implementation = await upgrades.prepareUpgrade(proxyAddress, factory, { kind: "uups" });

    const initData = initFunction
      ? factory.interface.encodeFunctionData(initFunction, initArgs)
      : "0x";
    const uupsInterface = new ethers.Interface([
      "function upgradeToAndCall(address newImplementation, bytes data)",
    ]);
    const upgradeCalldata = uupsInterface.encodeFunctionData("upgradeToAndCall", [
      implementation,
      initData,
    ]);

    console.log("Implementation deployed:", implementation);
    console.log("Multisig call target:", proxyAddress);
    console.log("Multisig calldata:", upgradeCalldata);
    return;
  }

  const call = initFunction ? { fn: initFunction, args: initArgs } : undefined;
  const upgraded = await upgrades.upgradeProxy(proxyAddress, factory, {
    kind: "uups",
    call,
  });
  await upgraded.waitForDeployment();

  const implementation = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log("Upgrade complete.");
  console.log("Implementation:", implementation);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
