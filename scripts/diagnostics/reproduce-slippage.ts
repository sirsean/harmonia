import { ethers, upgrades, network } from "hardhat";

async function main() {
    console.log("=== Reproducing Slippage Issue with Fork ===");
    
    // Addresses
    const hedgeManagerAddress = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
    const controllerAddress = "0xC6c1aC4e3fbDfbFA2d5554C77A081BaE178aac86";
    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";

    // 1. Impersonate Owner to Upgrade HedgeManager
    const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);
    const owner = await hm.owner();
    console.log("Impersonating HedgeManager owner:", owner);
    
    await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [owner],
    });
    
    // Fund the owner
    const ownerSigner = await ethers.getSigner(owner);
    await network.provider.send("hardhat_setBalance", [
        owner,
        "0x1000000000000000000", // 1 ETH
    ]);

    // 2. Upgrade HedgeManager to local version (with 8 decimals fix)
    console.log("Upgrading HedgeManager...");
    const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager", ownerSigner);
    
    // Force import to ensure openzeppelin knows about the proxy
    await upgrades.forceImport(hedgeManagerAddress, HedgeManagerFactory);
    
    // Deploy new implementation and upgrade
    const upgradedHm = await upgrades.upgradeProxy(hedgeManagerAddress, HedgeManagerFactory);
    await upgradedHm.waitForDeployment();
    console.log("HedgeManager upgraded.");

    // 3. Set Slippage Tolerance (if needed, but default 1% should work if decimals are correct)
    // Let's set it to 5% just to be safe, like we tried before
    await upgradedHm.setSlippageTolerance(50000000000000000n); // 5%
    console.log("Slippage tolerance set to 5%.");

    // 4. Impersonate Keeper to call performUpkeep
    // Or just use any signer since performUpkeep is public (usually checked by AutomationRegistry, but contract might allow anyone or specific forwarder)
    // RebalanceController checks nothing? It's AutomationCompatible.
    // Let's check RebalanceController logic. It doesn't restrict msg.sender for performUpkeep.
    
    const [signer] = await ethers.getSigners();
    const controller = await ethers.getContractAt("RebalanceController", controllerAddress, signer);

    console.log("Calling performUpkeep...");
    // performData for Rebalance is encoded "1" (0x...01)
    const performData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]); // Rebalance
    
    try {
        const tx = await controller.performUpkeep(performData);
        console.log("Transaction submitted:", tx.hash);
        const receipt = await tx.wait();
        console.log("Transaction confirmed in block:", receipt?.blockNumber);
        console.log("SUCCESS: Upkeep performed without revert.");
    } catch (error: any) {
        console.error("FAILURE: Upkeep reverted.");
        if (error.data) {
             console.error("Revert data:", error.data);
        } else {
             console.error("Error message:", error.message);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
