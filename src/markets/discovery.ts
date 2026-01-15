/**
 * Market Discovery
 *
 * Discovers and evaluates potential markets for delta-neutral vaults.
 * Searches for compatible Uniswap pools, GMX markets, and Chainlink feeds.
 */

import { ethers } from "ethers";
import { MarketDiscoveryResult, TokenConfig, MarketConfig } from "./types";
import { ARBITRUM_TOKENS, ARBITRUM_PROTOCOLS, TICK_SPACING } from "./registry";

// =============================================================================
// ABI Fragments
// =============================================================================

const UNISWAP_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
];

const UNISWAP_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const GMX_READER_ABI = [
  "function getMarkets(address dataStore, uint256 start, uint256 end) view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken)[])",
];

const CHAINLINK_FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

// =============================================================================
// Known Chainlink Feeds (Arbitrum)
// =============================================================================

export const KNOWN_CHAINLINK_FEEDS: Record<
  string,
  { address: string; heartbeat: number }
> = {
  ETH: { address: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", heartbeat: 3600 },
  BTC: { address: "0x6ce185860a4963106506C203335A2910525d22AD", heartbeat: 3600 },
  ARB: { address: "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6", heartbeat: 3600 },
  LINK: {
    address: "0x86E53CF1B870786351Da77A57575e79CB55812CB",
    heartbeat: 3600,
  },
  UNI: { address: "0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720", heartbeat: 3600 },
  GMX: { address: "0xDB98056FecFff59D032aB628337A4887110df3dB", heartbeat: 3600 },
  SOL: { address: "0x24ceA4b8ce57cdA5058b924B9B9987992450590c", heartbeat: 3600 },
  AAVE: {
    address: "0xaD1d5344AaDE45F43E596773Bcc4c423EAbdD034",
    heartbeat: 3600,
  },
  CRV: { address: "0xaebDA2c976cfd1eE1977Eac079B4382acb849325", heartbeat: 3600 },
  DOGE: {
    address: "0x9A7FB1b3950837a8D9b40517626E11D4127C098C",
    heartbeat: 3600,
  },
  AVAX: {
    address: "0x8bf61728eeDCE2F32c456454d87B5d6eD6150208",
    heartbeat: 3600,
  },
  MATIC: {
    address: "0x52099D4523531f678Dfc568a7B1e5038aadcE1d6",
    heartbeat: 3600,
  },
  OP: { address: "0x205aaD468a11fd5D34fA7211bC6Bad5b3deB9b98", heartbeat: 3600 },
  PEPE: {
    address: "0x02DEd5a7EDDA750E3Eb240c0F79674fD8f3DAf6C",
    heartbeat: 86400,
  },
  WIF: { address: "0x4Cf57DC9028187b9DAaF773c8ecA941036989238", heartbeat: 86400 },
};

// =============================================================================
// Discovery Class
// =============================================================================

export class MarketDiscovery {
  private provider: ethers.Provider;
  private uniswapFactory: ethers.Contract;
  private gmxReader: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
    this.uniswapFactory = new ethers.Contract(
      ARBITRUM_PROTOCOLS.UNISWAP_V3_FACTORY,
      UNISWAP_FACTORY_ABI,
      provider
    );
    this.gmxReader = new ethers.Contract(
      ARBITRUM_PROTOCOLS.GMX_READER,
      GMX_READER_ABI,
      provider
    );
  }

  /**
   * Discover all components needed for a market given a base token
   */
  async discoverMarket(
    baseToken: TokenConfig,
    quoteToken: TokenConfig = ARBITRUM_TOKENS.USDC
  ): Promise<MarketDiscoveryResult> {
    console.log(
      `\nDiscovering market for ${baseToken.symbol}/${quoteToken.symbol}`
    );
    console.log("=".repeat(50));

    const result: MarketDiscoveryResult = {
      uniswapPools: [],
      gmxMarkets: [],
      chainlinkFeeds: [],
    };

    // Discover Uniswap pools
    await this.discoverUniswapPools(baseToken, quoteToken, result);

    // Discover GMX markets
    await this.discoverGMXMarkets(baseToken, result);

    // Discover Chainlink feeds
    await this.discoverChainlinkFeeds(baseToken, result);

    // Generate recommended config if all components found
    if (
      result.uniswapPools.length > 0 &&
      result.gmxMarkets.length > 0 &&
      result.chainlinkFeeds.length > 0
    ) {
      result.recommendedConfig = this.generateRecommendedConfig(
        baseToken,
        quoteToken,
        result
      );
    }

    return result;
  }

  /**
   * Discover Uniswap V3 pools for a token pair
   */
  private async discoverUniswapPools(
    baseToken: TokenConfig,
    quoteToken: TokenConfig,
    result: MarketDiscoveryResult
  ): Promise<void> {
    console.log("\n[Discovering Uniswap Pools]");

    const feeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

    for (const fee of feeTiers) {
      try {
        const poolAddress = await this.uniswapFactory.getPool(
          baseToken.address,
          quoteToken.address,
          fee
        );

        if (poolAddress !== ethers.ZeroAddress) {
          const pool = new ethers.Contract(
            poolAddress,
            UNISWAP_POOL_ABI,
            this.provider
          );

          const liquidity = await pool.liquidity();

          result.uniswapPools.push({
            address: poolAddress,
            feeTier: fee,
            liquidity: liquidity,
            volume24h: 0n, // Would need subgraph for this
          });

          console.log(
            `  ✓ Found ${fee / 10000}% pool: ${poolAddress} (liquidity: ${liquidity})`
          );
        }
      } catch {
        // Pool doesn't exist for this fee tier
      }
    }

    if (result.uniswapPools.length === 0) {
      console.log(`  ✗ No Uniswap pools found`);
    }
  }

  /**
   * Discover GMX V2 markets for a token
   */
  private async discoverGMXMarkets(
    baseToken: TokenConfig,
    result: MarketDiscoveryResult
  ): Promise<void> {
    console.log("\n[Discovering GMX Markets]");

    try {
      // Get all markets (fetch first 100)
      const markets = await this.gmxReader.getMarkets(
        ARBITRUM_PROTOCOLS.GMX_DATA_STORE,
        0,
        100
      );

      for (const market of markets) {
        // Check if this market's index token matches our base token
        if (
          market.indexToken.toLowerCase() === baseToken.address.toLowerCase()
        ) {
          result.gmxMarkets.push({
            address: market.marketToken,
            indexToken: market.indexToken,
            openInterest: 0n, // Would need additional calls
            availableLiquidity: 0n,
          });

          console.log(`  ✓ Found GMX market: ${market.marketToken}`);
          console.log(`    Index: ${market.indexToken}`);
          console.log(`    Long: ${market.longToken}`);
          console.log(`    Short: ${market.shortToken}`);
        }
      }

      if (result.gmxMarkets.length === 0) {
        console.log(`  ✗ No GMX markets found for ${baseToken.symbol}`);
      }
    } catch (error) {
      console.log(`  ✗ Failed to query GMX markets: ${(error as Error).message}`);
    }
  }

  /**
   * Discover Chainlink price feeds for a token
   */
  private async discoverChainlinkFeeds(
    baseToken: TokenConfig,
    result: MarketDiscoveryResult
  ): Promise<void> {
    console.log("\n[Discovering Chainlink Feeds]");

    // Check known feeds
    const knownFeed = KNOWN_CHAINLINK_FEEDS[baseToken.symbol];

    if (knownFeed) {
      try {
        const feed = new ethers.Contract(
          knownFeed.address,
          CHAINLINK_FEED_ABI,
          this.provider
        );

        const [decimals, description, roundData] = await Promise.all([
          feed.decimals(),
          feed.description(),
          feed.latestRoundData(),
        ]);

        result.chainlinkFeeds.push({
          address: knownFeed.address,
          description: description,
          decimals: Number(decimals),
          latestPrice: roundData[1],
          updatedAt: Number(roundData[3]),
        });

        const price = Number(roundData[1]) / 10 ** Number(decimals);
        console.log(`  ✓ Found feed: ${description}`);
        console.log(`    Address: ${knownFeed.address}`);
        console.log(`    Price: $${price.toFixed(2)}`);
      } catch (error) {
        console.log(
          `  ✗ Failed to verify Chainlink feed: ${(error as Error).message}`
        );
      }
    } else {
      console.log(
        `  ✗ No known Chainlink feed for ${baseToken.symbol}`
      );
      console.log(`    Consider adding to KNOWN_CHAINLINK_FEEDS if one exists`);
    }
  }

  /**
   * Generate a recommended configuration based on discovered components
   */
  private generateRecommendedConfig(
    baseToken: TokenConfig,
    quoteToken: TokenConfig,
    discovery: MarketDiscoveryResult
  ): Partial<MarketConfig> {
    // Select best Uniswap pool (highest liquidity in a reasonable fee tier)
    const sortedPools = [...discovery.uniswapPools].sort((a, b) => {
      // Prefer 0.05% and 0.3% tiers, then sort by liquidity
      const tierPref = (tier: number) =>
        tier === 500 ? 0 : tier === 3000 ? 1 : 2;
      const prefDiff = tierPref(a.feeTier) - tierPref(b.feeTier);
      if (prefDiff !== 0) return prefDiff;
      return Number(b.liquidity - a.liquidity);
    });

    const bestPool = sortedPools[0];
    const bestGMX = discovery.gmxMarkets[0];
    const bestFeed = discovery.chainlinkFeeds[0];

    const baseIsToken0 =
      baseToken.address.toLowerCase() < quoteToken.address.toLowerCase();

    return {
      id: baseToken.symbol,
      name: `Harmonia ${baseToken.symbol}`,
      description: `Delta-neutral ${baseToken.symbol} yield vault`,
      chainId: 42161,

      baseToken,
      quoteToken,

      uniswapPool: {
        address: bestPool.address,
        feeTier: bestPool.feeTier,
        tickSpacing: TICK_SPACING[bestPool.feeTier],
        token0: baseIsToken0 ? baseToken : quoteToken,
        token1: baseIsToken0 ? quoteToken : baseToken,
      },

      gmxMarket: {
        marketAddress: bestGMX.address,
        indexToken: bestGMX.indexToken,
        longToken: baseToken.address,
        shortToken: quoteToken.address,
        name: `${baseToken.symbol}/USD`,
      },

      chainlinkFeed: {
        address: bestFeed.address,
        description: bestFeed.description,
        decimals: bestFeed.decimals,
        heartbeat:
          KNOWN_CHAINLINK_FEEDS[baseToken.symbol]?.heartbeat || 3600,
      },

      baseTokenIsToken0: baseIsToken0,
    };
  }

  /**
   * Scan all known tokens to find viable markets
   */
  async scanAllMarkets(): Promise<Map<string, MarketDiscoveryResult>> {
    console.log("\n" + "=".repeat(60));
    console.log("SCANNING ALL POTENTIAL MARKETS");
    console.log("=".repeat(60));

    const results = new Map<string, MarketDiscoveryResult>();

    // Tokens to scan (exclude stablecoins)
    const tokensToScan = Object.entries(ARBITRUM_TOKENS).filter(
      ([symbol]) => !["USDC", "USDC_E"].includes(symbol)
    );

    for (const [symbol, token] of tokensToScan) {
      try {
        const result = await this.discoverMarket(token);
        results.set(symbol, result);
      } catch (error) {
        console.log(`\nFailed to scan ${symbol}: ${(error as Error).message}`);
      }
    }

    // Print summary
    this.printScanSummary(results);

    return results;
  }

  /**
   * Print summary of scan results
   */
  private printScanSummary(results: Map<string, MarketDiscoveryResult>): void {
    console.log("\n" + "=".repeat(60));
    console.log("SCAN SUMMARY");
    console.log("=".repeat(60));

    const viable: string[] = [];
    const partial: string[] = [];
    const missing: string[] = [];

    for (const [symbol, result] of results) {
      const hasPool = result.uniswapPools.length > 0;
      const hasGMX = result.gmxMarkets.length > 0;
      const hasFeed = result.chainlinkFeeds.length > 0;

      if (hasPool && hasGMX && hasFeed) {
        viable.push(symbol);
      } else if (hasPool || hasGMX || hasFeed) {
        partial.push(
          `${symbol} (pool: ${hasPool ? "✓" : "✗"}, GMX: ${hasGMX ? "✓" : "✗"}, feed: ${hasFeed ? "✓" : "✗"})`
        );
      } else {
        missing.push(symbol);
      }
    }

    console.log(`\n✓ Viable Markets (${viable.length}):`);
    viable.forEach((s) => console.log(`  - ${s}`));

    console.log(`\n⚠ Partial Markets (${partial.length}):`);
    partial.forEach((s) => console.log(`  - ${s}`));

    console.log(`\n✗ No Components (${missing.length}):`);
    missing.forEach((s) => console.log(`  - ${s}`));
  }
}

/**
 * Print detailed discovery result
 */
export function printDiscoveryResult(result: MarketDiscoveryResult): void {
  console.log("\n" + "=".repeat(50));
  console.log("DISCOVERY RESULT");
  console.log("=".repeat(50));

  console.log(`\nUniswap Pools: ${result.uniswapPools.length}`);
  result.uniswapPools.forEach((pool) => {
    console.log(`  - ${pool.feeTier / 10000}% fee: ${pool.address}`);
    console.log(`    Liquidity: ${pool.liquidity}`);
  });

  console.log(`\nGMX Markets: ${result.gmxMarkets.length}`);
  result.gmxMarkets.forEach((market) => {
    console.log(`  - ${market.address}`);
  });

  console.log(`\nChainlink Feeds: ${result.chainlinkFeeds.length}`);
  result.chainlinkFeeds.forEach((feed) => {
    console.log(`  - ${feed.description}: ${feed.address}`);
  });

  if (result.recommendedConfig) {
    console.log(`\n✓ Recommended configuration generated`);
  } else {
    console.log(`\n✗ Insufficient components for configuration`);
  }
}
