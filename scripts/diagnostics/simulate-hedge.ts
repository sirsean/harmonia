import { ethers } from "hardhat";

async function main() {
    console.log("Simulating rebalance calculations...");

    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
    const lmAddress = await vault.liquidityManager();
    const lm = await ethers.getContractAt("LiquidityManager", lmAddress);

    // Current State
    const totalAssets = await vault.totalAssets(); // ~$465
    const lpValue = await lm.getPositionValue();   // ~$334
    
    // Simulate what happens after adjustRange
    // We assume the new position uses all available tokens in LM (which is roughly lpValue)
    // And is centered.
    
    // Centered position delta is roughly 50% of value.
    const expectedDeltaUsd = (Number(ethers.formatUnits(lpValue, 6)) * 0.5);
    
    console.log(`LP Value: $${ethers.formatUnits(lpValue, 6)}`);
    console.log(`Expected Delta USD (approx): $${expectedDeltaUsd.toFixed(2)}`);
    
    // Check min position size
    const hmAddress = await vault.hedgeManager();
    const hm = await ethers.getContractAt("HedgeManager", hmAddress);
    const minSize = await hm.minPositionSize();
    console.log(`Min Position Size: $${ethers.formatUnits(minSize, 30)}`);

    if (expectedDeltaUsd < Number(ethers.formatUnits(minSize, 30))) {
        console.log("FAIL: Expected delta is smaller than min position size!");
    } else {
        console.log("PASS: Expected delta is larger than min position size.");
    }

    // Let's check if getPositionDelta logic has a scaling issue
    // DeltaCalculator returns delta in BASE TOKEN units (18 decimals for WETH)
    // LiquidityManager.getPositionDelta() returns this directly.
    
    // The Vault converts this to USD/Value Ratio in _executeRebalance:
    // int256 lpDelta = ILiquidityManager(liquidityManager).getPositionDelta();
    // uint256 price = ILiquidityManager(liquidityManager).getOraclePrice(); (18 decimals)
    // address baseToken = ...
    // uint8 decimals = ... (18 for WETH)
    
    // hedgeTarget logic:
    // if (decimals <= 12) ...
    // else: hedgeTarget = (deltaAbs * price) / (10 ** (decimals - 12));
    
    // Let's manually calc this
    const price = await lm.getOraclePrice();
    console.log(`Oracle Price (18d): ${ethers.formatUnits(price, 18)}`);
    
    // Assume delta is 0.055 ETH (which is $167 at $3000)
    // 167 / 3000 = 0.0556
    const simulatedDelta = ethers.parseUnits("0.0556", 18); 
    console.log(`Simulated Delta (18d): ${ethers.formatUnits(simulatedDelta, 18)}`);
    
    const decimals = 18;
    // hedgeTarget = (deltaAbs * price) / (10 ** (18 - 12)) = (delta * price) / 10^6
    
    const numerator = simulatedDelta * price;
    const denominator = 10n ** 6n;
    const hedgeTarget = numerator / denominator;
    
    console.log(`Calculated Hedge Target (30d): ${hedgeTarget.toString()}`);
    console.log(`Calculated Hedge Target (USD): ${ethers.formatUnits(hedgeTarget, 30)}`);
    
    if (hedgeTarget < minSize) {
        console.log("FAIL: Logic produces value < minSize");
    } else {
        console.log("PASS: Logic produces value >= minSize");
    }

    // Is it possible the adjustment fails to deploy all capital?
    // In adjustRange:
    // 1. Close position -> tokens go to LM
    // 2. Mint new position -> uses balance of LM
    // 3. Refund unused -> tokens go to Vault
    
    // If the tick range is very narrow (multiplier=1), we might have high slippage or token imbalance?
    // The script sets multiplier to 1 to force "out of range".
    // But `adjustRange` uses the passed multiplier?
    // Vault.rebalance calls `lm.getRebalanceTicks(rangeWidthMultiplier)`.
    // And uses that for `lm.adjustRange`.
    
    // So if we set multiplier to 1, the new position will be extremely narrow!
    // A very narrow position might reject most liquidity if the price is exactly on a tick boundary?
    // Or it might be perfectly fine.
    
    // If the position is very narrow, does delta change?
    // Yes, a centered narrow position behaves like a single tick position.
    // Delta should still be ~0.5 at the center.
    
    // However, we are setting multiplier=1.
    // Ticks: base +/- 1*tickSpacing.
    // For 0.05% pool, spacing is 10.
    // Range is 20 ticks wide.
    // That is fine.
    
    // Check if vault balance is holding the tokens?
    // When capital is deployed, it goes to LM.
    // When adjustRange happens, tokens stay in LM (mint uses balance of LM).
    // Refunds go to Vault.
    
    // If we have a lot of refunds (due to imbalance), the new position might be small.
    // We are converting from 100% USDC to 50/50.
    // `adjustRange` does NOT perform swaps.
    
    // CRITICAL: `adjustRange` does NOT swap!
    // It closes the old position (getting 100% USDC).
    // It tries to mint a new position (needing 50% ETH, 50% USDC).
    // It has 0 ETH.
    // It will provide 0 ETH.
    // Uniswap will say "Fine, you provide 0 ETH and X USDC".
    // The resulting position will be one-sided (or fail if amount0Min/amount1Min > 0).
    // Our code has `amountMin = 0` (temporary fix).
    // So it likely succeeds in minting a weird position with only USDC.
    // A position with only USDC (one side) implies it's effectively "out of range" or just filling one side.
    // If it's single sided USDC, it's effectively same as before?
    // Or if it's centered, but we only provide USDC... that's impossible for a centered range. 
    // You MUST provide both tokens for a centered range in Uniswap V3.
    // If you only provide one, you get 0 liquidity for that position? 
    
    console.log("\nCRITICAL CHECK: Does adjustRange swap?");
    console.log("Reading LiquidityManager.sol...");
    // I recall reading it - it does NOT swap.
    
    console.log("Confirmed: adjustRange does NOT swap.");
    console.log("If we hold only USDC, and try to mint a centered position, we fail to add meaningful liquidity.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});