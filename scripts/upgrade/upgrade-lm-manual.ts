/**
 * Manual upgrade for LiquidityManager.
 * Deploys a new implementation and calls upgradeToAndCall on the proxy.
 */

import { ethers, network } from "hardhat";

const LM_PROXY = "0x0aa77E5CE038c878A5d2704A6C18b53cD7d855De";

async function main() {
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

  console.log("=== Manual LiquidityManager Upgrade ===");
  console.log("Network:", network.name);
  console.log("Proxy:", LM_PROXY);
  console.log("Mode:", dryRun ? "DRY RUN" : "LIVE");
  console.log("");

  // Get current implementation
  const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const currentImplData = await ethers.provider.getStorage(LM_PROXY, implSlot);
  const currentImpl = "0x" + currentImplData.slice(26);
  console.log("Current implementation:", currentImpl);

  // Check current bytecode for swapForLP
  const currentCode = await ethers.provider.getCode(currentImpl);
  const swapForLPSelector = ethers.id("swapForLP(address,uint256,int24,uint256)").slice(2, 10);
  console.log("swapForLP selector:", swapForLPSelector);
  console.log("swapForLP in current impl:", currentCode.includes(swapForLPSelector));
  console.log("");

  // Deploy new implementation
  console.log("Deploying new LiquidityManager implementation...");
  const LMFactory = await ethers.getContractFactory("LiquidityManager");

  if (dryRun) {
    console.log("DRY RUN - would deploy new implementation");
    console.log("Bytecode length:", LMFactory.bytecode.length);
    console.log("swapForLP in compiled bytecode:", LMFactory.bytecode.includes(swapForLPSelector));
    return;
  }

  const newImpl = await LMFactory.deploy();
  await newImpl.waitForDeployment();
  const newImplAddress = await newImpl.getAddress();
  console.log("New implementation deployed:", newImplAddress);

  // Verify new implementation has swapForLP
  const newCode = await ethers.provider.getCode(newImplAddress);
  console.log("swapForLP in new impl:", newCode.includes(swapForLPSelector));

  if (!newCode.includes(swapForLPSelector)) {
    throw new Error("New implementation does not have swapForLP - aborting");
  }

  // Upgrade the proxy
  console.log("\nUpgrading proxy...");
  const proxy = await ethers.getContractAt("LiquidityManager", LM_PROXY);

  // For UUPS, we call upgradeToAndCall on the proxy
  const tx = await proxy.upgradeToAndCall(newImplAddress, "0x");
  console.log("Upgrade tx:", tx.hash);
  await tx.wait();
  console.log("Upgrade complete!");

  // Verify upgrade
  const finalImplData = await ethers.provider.getStorage(LM_PROXY, implSlot);
  const finalImpl = "0x" + finalImplData.slice(26);
  console.log("\nFinal implementation:", finalImpl);

  const finalCode = await ethers.provider.getCode(finalImpl);
  console.log("swapForLP in final impl:", finalCode.includes(swapForLPSelector));

  // Test swapForLP call
  console.log("\n=== Testing swapForLP ===");
  try {
    const vault = await proxy.vault();
    const asset = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // USDC
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 300n;

    // Try static call (will fail due to onlyVault, but should not revert with empty data)
    await proxy.swapForLP.staticCall(asset, 0n, 20, deadline);
    console.log("swapForLP(0) staticCall: SUCCESS");
  } catch (e: any) {
    console.log("swapForLP test error:", e.message);
    // Check if it's the expected OnlyVault error
    if (e.message.includes("OnlyVault")) {
      console.log("=> Got OnlyVault error - this means swapForLP is now accessible!");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
