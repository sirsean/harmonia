import { ethers } from "hardhat";

async function main() {
    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
    const asset = await ethers.getContractAt("IERC20", await vault.asset()); // USDC

    const balance = await asset.balanceOf(vaultAddress);
    console.log("Vault USDC Balance:", ethers.formatUnits(balance, 6));

    const totalAssets = await vault.totalAssets();
    console.log("Vault Total Assets:", ethers.formatUnits(totalAssets, 6));

    const lpValue = await vault.getLPValue();
    console.log("LP Value:", ethers.formatUnits(lpValue, 6));

    const hedgeValue = await vault.getHedgeValue();
    console.log("Hedge Value:", ethers.formatUnits(hedgeValue, 6));

    // Calculate required hedge
    // Assume Delta ~ LP Value * 0.5? No, calculate strictly.
    const liquidityManagerAddress = await vault.liquidityManager();
    const lm = await ethers.getContractAt("LiquidityManager", liquidityManagerAddress);
    const delta = await lm.getPositionDelta();
    console.log("LP Delta (18d):", ethers.formatUnits(delta, 18));
    
    const price = await lm.getOraclePrice();
    console.log("Price (18d):", ethers.formatUnits(price, 18));

    // Target Hedge = Delta * Price
    const targetHedge = (delta * price) / (10n ** 18n); // 18 decimals result
    // Convert to USD (6 decimals for comparison)
    // Actually Target Hedge is 30 decimals in logic.
    // Let's just approximation: Delta * Price
    // Delta (ETH) * Price (USD/ETH) = USD exposure.
    console.log("Target Hedge Exposure (approx USD):", ethers.formatUnits((delta * price) / 10n ** 18n, 18));

    // Required Collateral
    // 2x leverage.
    const requiredCollateral = ((delta * price) / 10n ** 18n) / 2n; // 18 dec
    console.log("Required Collateral (approx USD):", ethers.formatUnits(requiredCollateral, 18));

    // Check vs Balance
    const balance18 = balance * 10n ** 12n;
    if (balance18 < requiredCollateral) {
        console.log("WARNING: Insufficient Collateral!");
    } else {
        console.log("Collateral OK.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
