import { ethers } from "hardhat";

const DEFAULT_VAULT = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
const UPKEEP_TYPES: Record<number, string> = {
  0: "None",
  1: "Rebalance",
  2: "Compound",
  3: "Snapshot",
};

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

function decodeUpkeepType(performData: string): string {
  if (!performData || performData.length <= 2) return "None";
  try {
    const upkeepTypeId = Number(
      ethers.AbiCoder.defaultAbiCoder().decode(["uint8"], performData)[0]
    );
    return UPKEEP_TYPES[upkeepTypeId] ?? `Unknown(${upkeepTypeId})`;
  } catch {
    return "Unknown";
  }
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const { controllerAddress } = await resolveAddresses();
  const controller = await ethers.getContractAt("RebalanceController", controllerAddress);
  const vaultAddress = await controller.vault();

  const [upkeepNeeded, checkPerformData] = await controller.checkUpkeep("0x");
  const performData = process.env.PERFORM_DATA || checkPerformData || "0x";
  const upkeepType = decodeUpkeepType(performData);

  console.log("=== Chainlink Automation: performUpkeep ===");
  console.log("Network:", network.name, "Chain ID:", network.chainId.toString());
  console.log("Controller:", controllerAddress);
  console.log("Vault:", vaultAddress);
  console.log("Upkeep needed (checkUpkeep):", upkeepNeeded);
  console.log("Perform data:", performData);
  console.log("Decoded upkeep type:", upkeepType);

  const [signer] = await ethers.getSigners();
  const controllerWithSigner = controller.connect(signer);

  try {
    const gasEstimate = await controllerWithSigner.performUpkeep.estimateGas(performData);
    console.log("Estimated gas:", gasEstimate.toString());
  } catch (error: any) {
    console.error("Gas estimation failed:", error.message);
    if (error.data) console.log("Gas estimation error data:", error.data);
  }

  if (process.env.DRY_RUN === "1") {
    try {
      await controllerWithSigner.performUpkeep.staticCall(performData);
      console.log("Dry run: performUpkeep callStatic succeeded.");
    } catch (error: any) {
      console.error("Dry run: performUpkeep callStatic failed:", error.message);
      if (error.data) console.log("Dry run error data:", error.data);
    }
    return;
  }

  if (process.env.SEND !== "1") {
    console.log("Not sending transaction. Set SEND=1 to broadcast.");
    console.log("Tip: use DRY_RUN=1 to simulate without sending.");
    return;
  }

  const tx = await controllerWithSigner.performUpkeep(performData);
  console.log("Submitted tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block:", receipt?.blockNumber?.toString() ?? "n/a");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
