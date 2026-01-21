import { ethers } from "hardhat";

const DEFAULT_VAULT = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
const UPKEEP_TYPES: Record<number, string> = {
  0: "None",
  1: "Rebalance",
  2: "Compound",
  3: "Snapshot",
};

function formatPercent18(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${ethers.formatUnits(abs, 16)}%`;
}

function formatDuration(seconds: number): string {
  if (seconds < 0) return "n/a";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

async function resolveAddresses() {
  const controllerEnv = process.env.REBALANCE_CONTROLLER || process.env.CONTROLLER_ADDRESS;
  const vaultEnv = process.env.VAULT_ADDRESS || process.env.VAULT;
  const vaultAddress = vaultEnv || DEFAULT_VAULT;

  if (controllerEnv) {
    return { vaultAddress, controllerAddress: controllerEnv };
  }

  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
  const controllerAddress = await vault.rebalanceController();
  return { vaultAddress, controllerAddress };
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const block = await ethers.provider.getBlock("latest");
  const now = block?.timestamp ?? Math.floor(Date.now() / 1000);

  const { controllerAddress } = await resolveAddresses();
  const controller = await ethers.getContractAt("RebalanceController", controllerAddress);
  const vaultAddress = await controller.vault();
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);

  const [upkeepNeeded, performData] = await controller.checkUpkeep("0x");
  const upkeepTypeId =
    performData.length > 2
      ? Number(ethers.AbiCoder.defaultAbiCoder().decode(["uint8"], performData)[0])
      : 0;
  const upkeepType = UPKEEP_TYPES[upkeepTypeId] ?? `Unknown(${upkeepTypeId})`;

  const [
    deltaRatio,
    threshold,
    lastRebalanceTime,
    minRebalanceInterval,
    maxRebalanceInterval,
    minCompoundInterval,
    minSnapshotInterval,
    lastCompoundTime,
    lastSnapshotTime,
  ] = await Promise.all([
    vault.getDeltaRatio(),
    vault.deltaThreshold(),
    vault.lastRebalanceTime(),
    controller.minRebalanceInterval(),
    controller.maxRebalanceInterval(),
    controller.minCompoundInterval(),
    controller.minSnapshotInterval(),
    controller.lastCompoundTime(),
    controller.lastSnapshotTime(),
  ]);

  const timeSinceRebalance = lastRebalanceTime === 0n ? -1 : Number(now - Number(lastRebalanceTime));
  const timeSinceCompound = lastCompoundTime === 0n ? -1 : Number(now - Number(lastCompoundTime));
  const timeSinceSnapshot = lastSnapshotTime === 0n ? -1 : Number(now - Number(lastSnapshotTime));

  console.log("=== Chainlink Automation: checkUpkeep ===");
  console.log("Network:", network.name, "Chain ID:", network.chainId.toString());
  console.log("Controller:", controllerAddress);
  console.log("Vault:", vaultAddress);
  console.log("Block time:", new Date(now * 1000).toISOString());
  console.log("");
  console.log("Upkeep needed:", upkeepNeeded);
  console.log("Upkeep type:", upkeepType);
  console.log("Perform data:", performData);
  console.log("");
  console.log("Delta ratio:", formatPercent18(deltaRatio));
  console.log("Delta threshold:", `${ethers.formatUnits(threshold, 16)}%`);
  console.log("Last rebalance:", lastRebalanceTime.toString());
  console.log("Time since rebalance:", formatDuration(timeSinceRebalance));
  console.log("Min rebalance interval:", formatDuration(Number(minRebalanceInterval)));
  console.log("Max rebalance interval:", formatDuration(Number(maxRebalanceInterval)));
  console.log("Last compound:", lastCompoundTime.toString());
  console.log("Time since compound:", formatDuration(timeSinceCompound));
  console.log("Min compound interval:", formatDuration(Number(minCompoundInterval)));
  console.log("Last snapshot:", lastSnapshotTime.toString());
  console.log("Time since snapshot:", formatDuration(timeSinceSnapshot));
  console.log("Min snapshot interval:", formatDuration(Number(minSnapshotInterval)));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
