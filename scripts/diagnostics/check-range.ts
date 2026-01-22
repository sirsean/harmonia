import { ethers } from "hardhat";

async function main() {
    const vaultAddress = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
    const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
    const lmAddress = await vault.liquidityManager();
    const lm = await ethers.getContractAt("LiquidityManager", lmAddress);
    
    // Get Pool Info
    const poolAddress = await lm.getPool();
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddress);
    const slot0 = await pool.slot0();
    const currentTick = Number(slot0.tick);
    const sqrtPriceX96 = slot0.sqrtPriceX96;

    // Get Position Info
    const { _tickLower, _tickUpper } = await lm.getPositionInfo();
    const tickLower = Number(_tickLower);
    const tickUpper = Number(_tickUpper);

    console.log("--- Range Analysis ---");
    console.log(`Current Tick: ${currentTick}`);
    console.log(`Position Range: [${tickLower}, ${tickUpper}]`);
    
    const inRange = currentTick >= tickLower && currentTick < tickUpper;
    console.log(`In Range: ${inRange ? "YES" : "NO"}`);

    // Calculate Prices
    // Price = 1.0001^tick * 10^(decimals0 - decimals1) = 1.0001^tick * 10^(18 - 6) = 1.0001^tick * 10^12
    // Wait, raw price P = amount1 / amount0.
    // 1 USDC (1e6) / 1 WETH (1e18) = 1e-12.
    // If real price is 3000, P = 3000 * 1e-12.
    // So to get Real Price from P, we multiply P by 1e12.
    // And P = 1.0001^tick.
    const tickToPrice = (tick: number) => {
        return (1.0001 ** tick) * (10 ** 12);
    };

    const currentPrice = tickToPrice(currentTick);
    const lowerPrice = tickToPrice(tickLower);
    const upperPrice = tickToPrice(tickUpper);

    // Note: WETH/USDC pool (token0=WETH, token1=USDC) usually quotes as USDC per WETH
    // But the tick price is actually token1/token0 if token0 is WETH.
    // If token0 is USDC, price is WETH/USDC.
    // Let's check token order.
    const token0 = await pool.token0();
    const token1 = await pool.token1();
    
    // Standard Arbitrum: WETH is token0?
    // WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
    // USDC: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
    // 0x82... < 0xaf... so WETH is token0.
    // Price = token1/token0 = USDC per WETH.
    
    console.log(`\n--- Prices (USDC per WETH) ---
`);
    console.log(`Current Price: $${currentPrice.toFixed(2)}`);
    console.log(`Lower Bound:   $${lowerPrice.toFixed(2)}`);
    console.log(`Upper Bound:   $${upperPrice.toFixed(2)}`);

    // Calculate skew
    const rangeTotal = tickUpper - tickLower;
    const distanceToUpper = tickUpper - currentTick;
    const percentToUpper = (distanceToUpper / rangeTotal) * 100;
    
    console.log(`\n--- Position Skew ---
`);
    console.log(`Distance to Top of Range: ${percentToUpper.toFixed(2)}%`);
    
    if (percentToUpper < 10) {
        console.log("=> Position is skewed heavily towards USDC (Upper Bound).");
        console.log("   As price rises (tick increases), we sell WETH for USDC.");
    } else if (percentToUpper > 90) {
        console.log("=> Position is skewed heavily towards WETH (Lower Bound).");
    } else {
        console.log("=> Position is relatively centered.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
