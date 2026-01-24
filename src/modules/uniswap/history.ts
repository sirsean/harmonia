import { ethers } from "ethers";
import { UniswapV3Pool } from "./types";
import { tickToPriceWithDecimals, sqrtPriceX96ToPrice } from "../math/ticks";

export interface HistoricalPricePoint {
  timestamp: number;
  price: number; // Price in USD (or quote token)
  tick?: number;
  volumeUsd?: number; // Volume in USD for this swap (if available)
}

/**
 * Query Uniswap v3 pool swap events to get historical prices
 * Uses 10-block windows to work within free RPC tier limits
 *
 * @param poolAddress Uniswap v3 pool address
 * @param provider Ethers provider
 * @param days Number of days of history
 * @param token0Address Token0 address (to determine decimals)
 * @param token1Address Token1 address (to determine decimals)
 * @param onProgress Optional progress callback (current, total)
 * @returns Array of historical price points from swap events
 */
export async function fetchHistoricalPricesFromSwapEvents(
  poolAddress: string,
  provider: ethers.Provider,
  days: number,
  token0Address: string,
  token1Address: string,
  onProgress?: (current: number, total: number) => void
): Promise<HistoricalPricePoint[]> {
  const endBlock = await provider.getBlockNumber();
  const startTime = Math.floor(Date.now() / 1000) - days * 24 * 3600;

  // Uniswap V3 Pool Swap event signature
  const swapEventSignature = "Swap(address,address,int256,int256,uint160,uint128,int24)";
  const swapTopic = ethers.id(swapEventSignature);

  // Estimate blocks per day (Arbitrum ~1 block per second = ~86400 blocks/day)
  const blocksPerDay = 86400;
  const startBlock = Math.max(0, endBlock - days * blocksPerDay);

  // Use 10-block windows to work within free RPC tier limits
  const blockWindowSize = 10;
  const totalBlocks = endBlock - startBlock;
  const totalWindows = Math.ceil(totalBlocks / blockWindowSize);

  const pricePoints: HistoricalPricePoint[] = [];
  const seenTimestamps = new Set<number>();

  // Sample every N blocks to reduce data volume
  // For longer periods, use less frequent sampling to reduce query time
  // - Short periods (< 30 days): sample every hour (~3600 blocks)
  // - Medium periods (30-90 days): sample every 6 hours (~21600 blocks)
  // - Long periods (> 90 days): sample every 12 hours (~43200 blocks)
  let sampleInterval = 3600; // Default: hourly
  if (days > 90) {
    sampleInterval = 43200; // Every 12 hours for long periods
  } else if (days > 30) {
    sampleInterval = 21600; // Every 6 hours for medium periods
  }
  const windowsPerSample = Math.ceil(sampleInterval / blockWindowSize); // How many windows to skip

  // Get token decimals
  const { ERC20_ABI } = await import("../../utils/abis");
  const token0Contract = new ethers.Contract(token0Address, ERC20_ABI, provider);
  const token1Contract = new ethers.Contract(token1Address, ERC20_ABI, provider);
  const [token0Decimals, token1Decimals] = await Promise.all([
    token0Contract.decimals(),
    token1Contract.decimals(),
  ]);
  const token0Dec = Number(token0Decimals);
  const token1Dec = Number(token1Decimals);

  const iface = new ethers.Interface([
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  ]);

  try {
    // Query in 10-block windows, but only sample periodically
    for (let window = 0; window < totalWindows; window += windowsPerSample) {
      const windowStart = startBlock + window * blockWindowSize;
      const windowEnd = Math.min(windowStart + blockWindowSize - 1, endBlock);

      try {
        // Query swap events for this 10-block window
        const logs = await provider.getLogs({
          address: poolAddress,
          topics: [swapTopic],
          fromBlock: windowStart,
          toBlock: windowEnd,
        });

        if (logs.length > 0) {
          // Get block timestamps for these logs
          const blockNumbers = [...new Set(logs.map((log) => log.blockNumber))];
          const blocks = await Promise.all(
            blockNumbers.map((blockNum) => provider.getBlock(blockNum))
          );

          const blockMap = new Map(blocks.filter((b) => b !== null).map((b) => [b!.number, b!]));

          // Process logs - take the last swap in each block to get final price
          const blockSwaps = new Map<number, (typeof logs)[0]>();
          for (const log of logs) {
            const existing = blockSwaps.get(log.blockNumber);
            if (!existing || log.index > existing.index) {
              blockSwaps.set(log.blockNumber, log);
            }
          }

          for (const [blockNum, log] of blockSwaps) {
            const block = blockMap.get(blockNum);
            if (!block) continue;

            const timestamp = block.timestamp;
            if (timestamp < startTime) continue;
            if (seenTimestamps.has(timestamp)) continue;

            try {
              const decoded = iface.decodeEventLog("Swap", log.data, log.topics);
              const sqrtPriceX96 = decoded.sqrtPriceX96;
              const tick = Number(decoded.tick);
              const amount0 = decoded.amount0; // int256
              const amount1 = decoded.amount1; // int256

              // Convert sqrtPriceX96 to price using existing utility
              const price = sqrtPriceX96ToPrice(sqrtPriceX96, token0Dec, token1Dec);

              // Calculate swap volume in USD
              // amount0 and amount1 are in their native token units
              // We need to convert to USD value
              // For ETH/USDC: if token0 is WETH, amount0 is WETH, amount1 is USDC
              // Volume = abs(amount0) * price + abs(amount1) if token1 is USDC
              // Or we can use the larger of the two amounts converted to USD
              const absAmount0 = amount0 < 0n ? -amount0 : amount0;
              const absAmount1 = amount1 < 0n ? -amount1 : amount1;

              // Convert amounts to human-readable numbers
              const amount0Num = Number(absAmount0) / Math.pow(10, token0Dec);
              const amount1Num = Number(absAmount1) / Math.pow(10, token1Dec);

              // Calculate volume: use the "in" token value in USD
              // If amount0 is negative, we're selling token0, so volume is amount1 (USDC if token1 is USDC)
              // If amount1 is negative, we're selling token1, so volume is amount0 * price
              let volumeUsd = 0;
              if (amount0 < 0n) {
                // Selling token0, buying token1 - volume is amount1 in USD
                volumeUsd = amount1Num;
              } else {
                // Selling token1, buying token0 - volume is amount0 * price in USD
                volumeUsd = amount0Num * price;
              }

              pricePoints.push({
                timestamp,
                price,
                tick,
                volumeUsd,
              });

              seenTimestamps.add(timestamp);
            } catch (decodeError) {
              // Skip invalid logs
              continue;
            }
          }
        }
      } catch (windowError: any) {
        // If a window fails, log and continue
        if (windowError.message?.includes("block range")) {
          // This shouldn't happen with 10-block windows, but handle gracefully
          console.warn(`Skipping block window ${windowStart}-${windowEnd}: ${windowError.message}`);
        } else {
          throw windowError;
        }
      }

      // Report progress every 10 samples
      if (onProgress && (window / windowsPerSample) % 10 === 0) {
        const currentSample = Math.floor(window / windowsPerSample) + 1;
        const totalSamples = Math.ceil(totalWindows / windowsPerSample);
        onProgress(currentSample, totalSamples);
      }
    }

    // Sort by timestamp
    pricePoints.sort((a, b) => a.timestamp - b.timestamp);

    return pricePoints;
  } catch (error) {
    throw new Error(`Failed to fetch historical prices from swap events: ${error}`);
  }
}

/**
 * Fetch historical prices with automatic fallback
 * Tries swap events first (most accurate), falls back to CoinGecko
 *
 * @param poolAddress Uniswap v3 pool address
 * @param provider Ethers provider
 * @param days Number of days of history
 * @param token0Decimals Token0 decimals
 * @param token1Decimals Token1 decimals
 * @param coinGeckoTokenId CoinGecko token ID for fallback (e.g., "ethereum")
 * @param onProgress Optional progress callback for swap event queries
 * @returns Array of historical price points
 */
export async function fetchHistoricalPrices(
  poolAddress: string,
  provider: ethers.Provider,
  days: number,
  token0Decimals: number,
  token1Decimals: number,
  coinGeckoTokenId?: string,
  onProgress?: (current: number, total: number) => void
): Promise<HistoricalPricePoint[]> {
  // Try to get prices from swap events first (most accurate)
  try {
    const blocksPerDay = 86400;
    const endBlock = await provider.getBlockNumber();
    const startBlock = Math.max(0, endBlock - days * blocksPerDay);
    const totalBlocks = endBlock - startBlock;
    const totalWindows = Math.ceil(totalBlocks / 10);

    console.log(`Attempting to fetch ${days} days of historical prices from swap events...`);
    console.log(
      `Querying ${totalWindows.toLocaleString()} windows of 10 blocks each (this may take a while)...`
    );

    // Get token addresses from pool
    const { UNISWAP_POOL_ABI } = await import("../../utils/abis");
    const poolContract = new ethers.Contract(poolAddress, UNISWAP_POOL_ABI, provider);
    const [token0Address, token1Address] = await Promise.all([
      poolContract.token0(),
      poolContract.token1(),
    ]);

    const prices = await fetchHistoricalPricesFromSwapEvents(
      poolAddress,
      provider,
      days,
      token0Address,
      token1Address,
      onProgress
    );

    if (prices.length > 0) {
      console.log(`Successfully fetched ${prices.length} price points from swap events`);
      return prices;
    } else {
      console.warn("No price points found in swap events, falling back to CoinGecko...");
    }
  } catch (error) {
    console.warn(`Failed to fetch from swap events: ${error}`);
  }

  // Fallback to CoinGecko if available
  if (coinGeckoTokenId) {
    try {
      console.log(`Falling back to CoinGecko API for ${coinGeckoTokenId}...`);
      // Use the CoinGecko function directly
      const url = `https://api.coingecko.com/api/v3/coins/${coinGeckoTokenId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.statusText}`);
      }
      const data = await response.json();
      const prices = data.prices as [number, number][];
      const pricePoints = prices.map(([timestampMs, price]) => ({
        timestamp: Math.floor(timestampMs / 1000),
        price,
        tick: 0, // Not available from CoinGecko
      }));
      console.log(`Successfully fetched ${pricePoints.length} price points from CoinGecko`);
      return pricePoints;
    } catch (error) {
      console.warn(`Failed to fetch from CoinGecko: ${error}`);
    }
  }

  throw new Error(
    "Failed to fetch historical prices from all sources. Try providing coinGeckoTokenId for fallback."
  );
}
