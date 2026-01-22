import { ethers } from "hardhat";

const DEFAULT_VAULT = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || DEFAULT_VAULT;

  console.log("=== Verify LM Functions ===");
  console.log("Vault:", vaultAddress);
  console.log("");

  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
  const lmAddress = await vault.liquidityManager();
  console.log("LiquidityManager:", lmAddress);

  // Get LM contract
  const lm = await ethers.getContractAt("LiquidityManager", lmAddress);

  // Calculate function selectors
  const swapForLPSelector = ethers.id("swapForLP(address,uint256,int24,uint256)").slice(0, 10);
  const collectFeesSelector = ethers.id("collectFees()").slice(0, 10);
  const mintPositionSelector = ethers.id("mintPosition(int24,int24,uint256,uint256,uint256)").slice(0, 10);
  const increaseLiquiditySelector = ethers.id("increaseLiquidity(uint256,uint256,uint256)").slice(0, 10);

  console.log("\n=== Function Selectors ===");
  console.log("swapForLP:", swapForLPSelector);
  console.log("collectFees:", collectFeesSelector);
  console.log("mintPosition:", mintPositionSelector);
  console.log("increaseLiquidity:", increaseLiquiditySelector);

  // Get the bytecode at the implementation address
  // First, check if this is a proxy by looking at the implementation slot
  const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implData = await ethers.provider.getStorage(lmAddress, implSlot);
  const implAddress = "0x" + implData.slice(26);
  console.log("\n=== Proxy Info ===");
  console.log("Implementation address:", implAddress);

  // Get the bytecode from the implementation
  const implCode = await ethers.provider.getCode(implAddress);
  console.log("Implementation bytecode length:", implCode.length);

  // Check if function selectors are present in bytecode
  const swapForLPInCode = implCode.includes(swapForLPSelector.slice(2));
  const collectFeesInCode = implCode.includes(collectFeesSelector.slice(2));
  console.log("\n=== Selectors in Bytecode ===");
  console.log("swapForLP in bytecode:", swapForLPInCode);
  console.log("collectFees in bytecode:", collectFeesInCode);

  // Try calling functions with lower-level calls to see exact errors
  console.log("\n=== Testing Function Calls ===");

  // Build calldata for swapForLP with 0 amount
  const asset = await vault.asset();
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + 300n;
  const rangeMultiplier = await vault.rangeWidthMultiplier();

  // Encode swapForLP(address,uint256,int24,uint256)
  const swapForLPCalldata = lm.interface.encodeFunctionData("swapForLP", [
    asset,
    0n,
    rangeMultiplier,
    deadline,
  ]);
  console.log("swapForLP calldata:", swapForLPCalldata);

  // Try direct call to proxy
  console.log("\n=== Direct Call to Proxy ===");
  try {
    const result = await ethers.provider.call({
      to: lmAddress,
      data: swapForLPCalldata,
    });
    console.log("swapForLP call result:", result);
  } catch (e: any) {
    console.log("swapForLP call error:", e.message);
    if (e.data) console.log("Error data:", e.data);
  }

  // Try direct call to implementation (bypassing proxy)
  console.log("\n=== Direct Call to Implementation ===");
  try {
    const result = await ethers.provider.call({
      to: implAddress,
      data: swapForLPCalldata,
    });
    console.log("Direct impl call result:", result);
  } catch (e: any) {
    console.log("Direct impl call error:", e.message);
    if (e.data) console.log("Error data:", e.data);
  }

  // Check if there's a fallback function issue by calling a non-existent function
  console.log("\n=== Testing Non-existent Function ===");
  const fakeSelector = "0x12345678";
  try {
    await ethers.provider.call({
      to: lmAddress,
      data: fakeSelector + "0000000000000000000000000000000000000000000000000000000000000000",
    });
    console.log("Fake function call succeeded (unexpected)");
  } catch (e: any) {
    console.log("Fake function call error:", e.message);
  }

  // Compare the actual deployed implementation to compiled artifacts
  console.log("\n=== Comparing Artifacts ===");
  const LMFactory = await ethers.getContractFactory("LiquidityManager");
  const deployedBytecode = LMFactory.bytecode;
  console.log("Compiled bytecode length:", deployedBytecode.length);

  // Check if the deployed implementation has the expected functions
  // by looking at the first few function dispatches
  console.log("\n=== First Bytes Comparison ===");
  console.log("Deployed impl first 200 chars:", implCode.slice(0, 200));

  // Try accessing view functions to confirm LM is working
  console.log("\n=== View Function Tests ===");
  try {
    const tokenId = await lm.tokenId();
    console.log("tokenId:", tokenId.toString());
  } catch (e: any) {
    console.log("tokenId error:", e.message);
  }

  try {
    const vault_ = await lm.vault();
    console.log("vault:", vault_);
  } catch (e: any) {
    console.log("vault error:", e.message);
  }

  try {
    const pool = await lm.getPool();
    console.log("pool:", pool);
  } catch (e: any) {
    console.log("getPool error:", e.message);
  }

  try {
    const [tickLower, tickUpper] = await lm.getRebalanceTicks(rangeMultiplier);
    console.log("getRebalanceTicks:", tickLower, tickUpper);
  } catch (e: any) {
    console.log("getRebalanceTicks error:", e.message);
  }

  // Check if the issue is in DeltaCalculator.getSqrtRatioAtTick
  console.log("\n=== DeltaCalculator Check ===");
  // Let's see if the library is properly linked
  const DeltaCalcFactory = await ethers.getContractFactory("DeltaCalculator");
  console.log("DeltaCalculator is a library, checking if getSqrtRatioAtTick exists...");

  // Read the DeltaCalculator source to verify the function exists
  // For now, let's just check the rebalance ticks function which uses similar math
  try {
    const ticks = await lm.getRebalanceTicks(20);
    console.log("getRebalanceTicks(20):", ticks[0].toString(), ticks[1].toString());
    console.log("=> DeltaCalculator library appears to be linked correctly");
  } catch (e: any) {
    console.log("getRebalanceTicks failed:", e.message);
  }

  // Final test: call a function that uses the same modifiers but different logic
  console.log("\n=== Testing Similar Functions ===");

  // Try impersonating vault to call functions
  console.log("\nImpersonating vault to test...");
  try {
    await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
    const vaultSigner = await ethers.getSigner(vaultAddress);

    // Fund vault with ETH for gas
    const [funder] = await ethers.getSigners();
    await funder.sendTransaction({
      to: vaultAddress,
      value: ethers.parseEther("0.01"),
    });

    const lmFromVault = lm.connect(vaultSigner);

    // Test collectFees from vault context
    console.log("\ncollectFees from vault...");
    try {
      const tx = await lmFromVault.collectFees.staticCall();
      console.log("collectFees result:", tx);
    } catch (e: any) {
      console.log("collectFees error:", e.message);
    }

    // Test swapForLP with 0 from vault context
    console.log("\nswapForLP(0) from vault...");
    try {
      const result = await lmFromVault.swapForLP.staticCall(asset, 0n, rangeMultiplier, deadline);
      console.log("swapForLP(0) result:", result);
    } catch (e: any) {
      console.log("swapForLP(0) error:", e.message);
      if (e.data) console.log("Error data:", e.data);

      // Try with low-level call
      console.log("\nTrying low-level call from vault...");
      const tx = {
        to: lmAddress,
        data: swapForLPCalldata,
      };
      try {
        const result = await vaultSigner.call(tx);
        console.log("Low-level result:", result);
      } catch (e2: any) {
        console.log("Low-level error:", e2.message);
        if (e2.data) console.log("Low-level error data:", e2.data);
      }
    }

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);
  } catch (e: any) {
    console.log("Impersonation failed:", e.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
