import { ethers } from "hardhat";

async function tryDecode(label: string, iface: ethers.Interface, data: string) {
  try {
    const parsed = iface.parseError(data);
    if (!parsed?.name) return false;
    console.log(`${label} decoded:`, parsed?.name, parsed?.args);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const data = process.env.REVERT_DATA;
  if (!data) {
    throw new Error("Set REVERT_DATA env var (hex string).");
  }

  const vault = await ethers.getContractFactory("DeltaNeutralVault");
  const lm = await ethers.getContractFactory("LiquidityManager");
  const hm = await ethers.getContractFactory("HedgeManager");
  const targets: Array<[string, ethers.Interface]> = [
    ["DeltaNeutralVault", vault.interface],
    ["LiquidityManager", lm.interface],
    ["HedgeManager", hm.interface],
  ];

  for (const [label, iface] of targets) {
    if (await tryDecode(label, iface, data)) return;
  }

  console.log("No matching custom error in known interfaces.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
