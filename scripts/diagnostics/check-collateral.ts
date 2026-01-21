import { ethers } from "hardhat";

async function main() {
    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
    const asset = await ethers.getContractAt("IERC20", await vault.asset()); // USDC

    const liquidityManagerAddress = await vault.liquidityManager();
    const lm = await ethers.getContractAt("LiquidityManager", liquidityManagerAddress);
    const hedgeManagerAddress = await vault.hedgeManager();
    const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);

    const baseTokenAddress = await lm.baseToken();
    const quoteTokenAddress = await lm.quoteToken();
    const baseToken = await ethers.getContractAt("IERC20", baseTokenAddress);
    const quoteToken = await ethers.getContractAt("IERC20", quoteTokenAddress);

    console.log("--- Vault Balances ---");
    const vaultUsdcBalance = await quoteToken.balanceOf(vaultAddress);
    const vaultWethBalance = await baseToken.balanceOf(vaultAddress);
    console.log(`Vault USDC: ${ethers.formatUnits(vaultUsdcBalance, 6)}`);
    console.log(`Vault WETH: ${ethers.formatUnits(vaultWethBalance, 18)}`);

    console.log("\n--- Liquidity Manager Balances ---");
    const lmUsdcBalance = await quoteToken.balanceOf(liquidityManagerAddress);
    const lmWethBalance = await baseToken.balanceOf(liquidityManagerAddress);
    console.log(`LM USDC: ${ethers.formatUnits(lmUsdcBalance, 6)}`);
    console.log(`LM WETH: ${ethers.formatUnits(lmWethBalance, 18)}`);

    console.log("\n--- Vault State ---");
    const totalAssets = await vault.totalAssets();
    console.log("Vault Total Assets:", ethers.formatUnits(totalAssets, 6));

    const lpValue = await vault.getLPValue();
    console.log("LP Value:", ethers.formatUnits(lpValue, 6));

    const hedgeValue = await vault.getHedgeValue();
    console.log("Hedge Value:", ethers.formatUnits(hedgeValue, 6));

    // Calculate required hedge
    const delta = await lm.getPositionDelta();
    console.log("\n--- Strategy State ---");
    console.log("LP Delta (18d):", ethers.formatUnits(delta, 18));
    
    const price = await lm.getOraclePrice();
    console.log("Price (18d):", ethers.formatUnits(price, 18));

    // Target Hedge = Delta * Price
    // Delta (ETH) * Price (USD/ETH) = USD exposure.
    console.log("Target Hedge Exposure (approx USD):", ethers.formatUnits((delta * price) / 10n ** 18n, 18));

    // Required Collateral
    // 2x leverage.
    const requiredCollateral = ((delta * price) / 10n ** 18n) / 2n; // 18 dec
    console.log("Required Collateral (approx USD):", ethers.formatUnits(requiredCollateral, 18));

    const balance18 = vaultUsdcBalance * 10n ** 12n;
    if (balance18 < requiredCollateral) {
        console.log("WARNING: Insufficient Collateral!");
    } else {
        console.log("Collateral OK.");
    }

    console.log("\n--- Hedge Manager State ---");
    try {
        const hmUsdcBalance = await quoteToken.balanceOf(hedgeManagerAddress);
        const hmWethBalance = await baseToken.balanceOf(hedgeManagerAddress);
        console.log(`HM USDC: ${ethers.formatUnits(hmUsdcBalance, 6)}`);
        console.log(`HM WETH: ${ethers.formatUnits(hmWethBalance, 18)}`);

        const lastOrderKey = await hm.lastOrderKey();
        console.log("Last Order Key:", lastOrderKey);
        
        const hasPosition = await hm.hasPosition();
        console.log("Has Position:", hasPosition);

        const minPosSize = await hm.minPositionSize();
        console.log("Min Position Size (30d):", ethers.formatUnits(minPosSize, 30));
        
        if (hasPosition) {
            const sizeUsd = await hm.getPositionSizeUsd();
            const collateral = await hm.getCollateralAmount();
            console.log("Position Size USD (30d):", ethers.formatUnits(sizeUsd, 30));
            console.log("Position Collateral:", ethers.formatUnits(collateral, 6)); // Assuming USDC
        }
    } catch (e) {
        console.log("Error reading HedgeManager state:", e.message);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
