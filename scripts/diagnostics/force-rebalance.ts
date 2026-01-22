import { ethers } from "hardhat";

async function main() {
    console.log("Forcing rebalance...");

    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);

    // Call rebalance with target 0 (auto-calculate)
    // The vault will see deltaDrift > threshold (or out of range condition) and execute
    // Actually, vault.rebalance() takes a parameter for targetHedgeSize.
    // If we pass 0, it calculates based on current LP delta.
    
    // BUT: The LiquidityManager needs to adjust range first.
    // Vault.rebalance() calls internal _executeRebalance() which:
    // 1. Checks if LM is in range (it IS in range, just skewed).
    // 2. Wait, if it IS in range, it WON'T adjust the LP range automatically in the current logic?
    // Let's check LiquidityManager.isInRange().
    
    // Our check-range script said "In Range: YES".
    // So _executeRebalance might NOT trigger LM.adjustRange().
    
    // We might need to manually call adjustRange on the LiquidityManager first?
    // Or we can use the "RangeWidthMultiplier" to narrow the range and force it out?
    // Or we just update the rebalance logic to handle "skewed but in range".
    
    // For now, let's try calling rebalance(0) and see if the delta drift is enough.
    // Current delta ratio is very low (~0). Target is 0 (neutral). 
    // Wait, if net delta is 0 (because LP delta is 0 and Hedge is 0), the system thinks it's perfect!
    
    // Ah! If LP delta is 0, the system is delta neutral (0 + 0 = 0).
    // But we are not earning fees effectively if we are one-sided.
    // And we are not hedging anything.
    
    // The LiquidityManager needs to be forced to recenter.
    // We can manually call `liquidityManager.adjustRange(...)` via the vault/owner.
    // But adjustRange is `onlyVault`.
    
    // We need to verify if there is a way to force range adjustment.
    // rebalance() calls `_executeRebalance`.
    // inside `_executeRebalance`:
    // if (!inRange) -> adjustRange.
    
    // Since we are technically "in range" (barely), it won't trigger.
    
    // WORKAROUND:
    // Update the range multiplier to something very small (e.g., 1 tick) to force "out of range".
    // Then call rebalance.
    // Then set multiplier back.
    
    // Just call rebalance(0)
    console.log("Executing rebalance(0)...");
    const tx2 = await vault.rebalance(0); 
    console.log("Rebalance Tx:", tx2.hash);
    await tx2.wait();
    console.log("Rebalance complete.");
}

main().catch((error) => {
    console.error("Error executing rebalance:");
    console.error(error);
    if (error.data) {
        console.log("Error Data:", error.data);
    }
    process.exitCode = 1;
});
