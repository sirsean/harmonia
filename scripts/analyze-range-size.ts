import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../src/config/addresses";
import { createPool, getPoolState } from "../src/modules/uniswap/reader";
import { getLatestPrice } from "../src/modules/chainlink/price";
import {
  analyzeRangeWidth,
  simulatePriceMovements,
  RangeAnalysis,
  PricePoint,
} from "../src/modules/strategy/range-analysis";
import { fetchHistoricalPrices } from "../src/modules/uniswap/history";
import { ERC20_ABI } from "../src/utils/abis";

/**
 * Range Size Analysis Script
 *
 * Analyzes optimal Uniswap v3 range sizes for delta-neutral yield strategy.
 * Calculates:
 * - Expected out-of-range frequency
 * - Expected fee yield
 * - Expected gas costs
 * - Net APY (yield - gas costs)
 *
 * Usage:
 *   npx hardhat run scripts/analyze-range-size.ts --network arbitrum
 *
 * Environment variables:
 *   DAYS=30          # Number of days to analyze (default: 30)
 *   POSITION_SIZE=100000  # Position size in USD (default: 100000)
 *   POOL_FEE=500     # Pool fee tier in basis points (default: 500 = 0.05%)
 */

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("UNISWAP V3 RANGE SIZE ANALYSIS");
  console.log("=".repeat(70) + "\n");

  const days = Number(process.env.DAYS || "30");
  const positionSizeUsd = Number(process.env.POSITION_SIZE || "100000");
  const poolFeeBps = Number(process.env.POOL_FEE || "500");

  console.log(`Analysis Parameters:`);
  console.log(`  Days to analyze: ${days}`);
  console.log(`  Position size: $${positionSizeUsd.toLocaleString()}`);
  const feePercent = poolFeeBps / 10000;
  console.log(`  Pool fee: ${poolFeeBps} bps (${feePercent}%)`);
  console.log();

  // Get current price
  const chainlinkFeed = ARBITRUM_MAINNET.chainlinkEthUsdFeed;
  let currentPrice: number;

  try {
    const priceResult = await getLatestPrice(chainlinkFeed, ethers.provider);
    // Chainlink returns price with 8 decimals, convert to USD
    currentPrice = Number(priceResult.price) / 1e8;
    console.log(`Current ETH/USD price: $${currentPrice.toFixed(2)}`);
  } catch (error) {
    console.warn("Could not fetch Chainlink price, using default $3000");
    currentPrice = 3000;
  }

  // Get pool state for volume estimation and token addresses
  const poolAddress = ARBITRUM_MAINNET.uniswapV3EthUsdcPool;
  const pool = createPool(poolAddress, ethers.provider);

  let dailyVolumeUsd = 10_000_000; // Default estimate: $10M daily volume
  let token0Address: string;
  let token1Address: string;
  try {
    const poolState = await getPoolState(pool);
    // In production, fetch actual volume from subgraph or API
    // For now, use a reasonable default
    console.log(`Pool tick: ${poolState.tick}`);
    console.log(`Using estimated daily volume: $${dailyVolumeUsd.toLocaleString()}`);

    // Get token addresses
    [token0Address, token1Address] = await Promise.all([pool.token0(), pool.token1()]);
  } catch (error) {
    console.warn("Could not fetch pool state, using default volume estimate");
    // Fallback: use known addresses
    token0Address = ARBITRUM_MAINNET.weth;
    token1Address = ARBITRUM_MAINNET.usdc;
  }

  console.log();

  // Fetch historical price data
  let pricePoints: PricePoint[] = [];
  const useHistoricalData = process.env.USE_HISTORICAL !== "false"; // Default to true

  if (useHistoricalData) {
    try {
      console.log(`Fetching ${days} days of historical price data...`);

      // Progress indicator for swap event queries
      let lastProgressUpdate = 0;
      const progressCallback = (current: number, total: number) => {
        const percent = Math.floor((current / total) * 100);
        // Update every 5% to avoid spam
        if (percent >= lastProgressUpdate + 5) {
          console.log(`  Progress: ${percent}% (${current}/${total} windows)`);
          lastProgressUpdate = percent;
        }
      };

      // Get token decimals for fetchHistoricalPrices
      const token0Contract = new ethers.Contract(token0Address, ERC20_ABI, ethers.provider);
      const token1Contract = new ethers.Contract(token1Address, ERC20_ABI, ethers.provider);
      const [token0Decimals, token1Decimals] = await Promise.all([
        token0Contract.decimals(),
        token1Contract.decimals(),
      ]);

      const historicalPrices = await fetchHistoricalPrices(
        poolAddress,
        ethers.provider,
        days,
        Number(token0Decimals),
        Number(token1Decimals),
        "ethereum", // CoinGecko token ID for fallback
        progressCallback
      );

      // Convert to PricePoint format and ensure price is in USD (USDC per WETH)
      // Check which token is USDC to determine if we need to invert
      const isToken0Usdc = token0Address.toLowerCase() === ARBITRUM_MAINNET.usdc.toLowerCase();
      const isToken1Usdc = token1Address.toLowerCase() === ARBITRUM_MAINNET.usdc.toLowerCase();

      pricePoints = historicalPrices.map((hp) => {
        let priceUsd = hp.price;
        // If token0 is USDC and token1 is WETH, price is WETH/USDC, so invert to get USDC/WETH
        if (isToken0Usdc && !isToken1Usdc) {
          priceUsd = 1 / hp.price;
        }
        // If token1 is USDC and token0 is WETH, price is already USDC/WETH
        return {
          timestamp: hp.timestamp,
          price: priceUsd,
          volumeUsd: hp.volumeUsd,
        };
      });

      if (pricePoints.length > 0) {
        console.log(`Successfully fetched ${pricePoints.length} historical price points`);
        // Use the most recent price as current price for analysis
        currentPrice = pricePoints[pricePoints.length - 1].price;
        console.log(
          `Using historical price range: $${pricePoints[0].price.toFixed(2)} - $${currentPrice.toFixed(2)}`
        );
      } else {
        throw new Error("No historical prices fetched");
      }
    } catch (error) {
      console.warn(`Failed to fetch historical data: ${error}`);
      console.log("Falling back to simulated price movements...");
      const volatility = 0.8; // 80% annual volatility
      pricePoints = simulatePriceMovements(currentPrice, volatility, days, 24);
    }
  } else {
    // Simulate price movements
    const volatility = 0.8; // 80% annual volatility
    console.log(`Simulating price movements (${volatility * 100}% annual volatility)...`);
    pricePoints = simulatePriceMovements(currentPrice, volatility, days, 24);
  }

  // Analyze different range sizes
  const rangeWidths = [0.02, 0.06, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4]; // 2%, 6%, 10%, 15%, 20%, 25%, 30%, 40% (±1%, ±3%, ±5%, etc.)
  const analyses: RangeAnalysis[] = [];

  console.log(`\nAnalyzing ${rangeWidths.length} range sizes...\n`);

  // Use range adjustment thresholds from config
  const rangeAdjustmentThreshold = 0.02; // 2% - adjust if within this % of edge
  const rangeCenterDriftThreshold = 0.05; // 5% - adjust if drifted from center

  for (const width of rangeWidths) {
    const analysis = analyzeRangeWidth(
      width,
      pricePoints,
      currentPrice,
      poolFeeBps,
      dailyVolumeUsd,
      positionSizeUsd,
      3600, // 1 hour minimum between adjustments
      rangeAdjustmentThreshold,
      rangeCenterDriftThreshold
    );
    analyses.push(analysis);
  }

  // Display results
  console.log("=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));
  console.log();

  // Sort by net APY (descending)
  analyses.sort((a, b) => b.netAPY - a.netAPY);

  console.log("Range Size Comparison (sorted by Net APY):");
  console.log();
  console.log(
    `${"Range".padEnd(12)} | ${"Out Range".padEnd(10)} | ${"Adj/Mo".padEnd(8)} | ${"Fee APY".padEnd(10)} | ${"Fees Earned".padEnd(12)} | ${"Gas APY".padEnd(10)} | ${"Net APY".padEnd(10)}`
  );
  console.log("-".repeat(85));

  for (const analysis of analyses) {
    const rangeStr = `±${(analysis.rangeWidthPercent / 2).toFixed(1)}%`.padEnd(12);
    const outRangeStr = `${analysis.outOfRangePercent.toFixed(1)}%`.padEnd(10);
    const adjStr = analysis.expectedAdjustmentsPerMonth.toFixed(1).padEnd(8);
    const feeStr = `${analysis.estimatedFeeYieldAPY.toFixed(2)}%`.padEnd(10);
    const feesEarnedStr =
      analysis.actualFeeIncomeUsd > 0
        ? `$${analysis.actualFeeIncomeUsd.toFixed(2)}`.padEnd(12)
        : "N/A".padEnd(12);
    const gasStr = `${analysis.estimatedGasCostAPY.toFixed(2)}%`.padEnd(10);
    const netStr = `${analysis.netAPY.toFixed(2)}%`.padEnd(10);

    console.log(
      `${rangeStr} | ${outRangeStr} | ${adjStr} | ${feeStr} | ${feesEarnedStr} | ${gasStr} | ${netStr}`
    );
  }

  console.log();
  console.log("=".repeat(70));
  console.log("RECOMMENDATIONS");
  console.log("=".repeat(70));
  console.log();

  const best = analyses[0];
  console.log(`Best Net APY: ${best.rangeWidthPercent}% range (±${best.rangeWidthPercent / 2}%)`);
  console.log(`  Net APY: ${best.netAPY.toFixed(2)}%`);
  console.log(`  Fee Yield: ${best.estimatedFeeYieldAPY.toFixed(2)}%`);
  if (best.actualFeeIncomeUsd > 0) {
    console.log(
      `  Fees earned (${best.daysAnalyzed.toFixed(1)} days): $${best.actualFeeIncomeUsd.toFixed(2)}`
    );
  }
  console.log(`  Gas Cost: ${best.estimatedGasCostAPY.toFixed(2)}%`);
  console.log(`  Expected adjustments: ${best.expectedAdjustmentsPerMonth.toFixed(1)}/month`);
  console.log(`  Out of range: ${best.outOfRangePercent.toFixed(1)}% of time`);

  console.log();
  console.log("Notes:");
  if (useHistoricalData && pricePoints.length > 0) {
    console.log(`- This analysis uses ${pricePoints.length} actual historical price points`);
    console.log("- Prices fetched from Uniswap swap events (or CoinGecko fallback)");
  } else {
    console.log("- This analysis uses simulated price data based on volatility");
    console.log("- Set USE_HISTORICAL=true to use actual historical price data");
  }
  console.log("- Fee yield estimates are simplified - actual yields depend on");
  console.log("  liquidity distribution and trading volume patterns");
  console.log("- Gas costs assume Arbitrum gas prices (~0.1 gwei)");
  console.log("- Consider your risk tolerance and monitoring capabilities");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
