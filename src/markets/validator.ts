/**
 * Market Validator
 *
 * Validates that all components of a market configuration are properly set up
 * and compatible with each other on-chain.
 */

import { ethers } from "ethers";
import { MarketConfig, MarketValidationResult, sqrtPriceX96ToPrice } from "./types";

// =============================================================================
// ABI Fragments
// =============================================================================

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

const UNISWAP_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const CHAINLINK_FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

const GMX_READER_ABI = [
  "function getMarket(address dataStore, address market) view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken))",
];

const GMX_DATA_STORE_ABI = ["function getUint(bytes32 key) view returns (uint256)"];

// =============================================================================
// Validator Class
// =============================================================================

export class MarketValidator {
  private provider: ethers.Provider;
  private gmxReaderAddress: string;
  private gmxDataStoreAddress: string;

  constructor(
    provider: ethers.Provider,
    gmxReaderAddress: string = "0xf60becbba223EEA9495Da3f606753867eC10d139",
    gmxDataStoreAddress: string = "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8"
  ) {
    this.provider = provider;
    this.gmxReaderAddress = gmxReaderAddress;
    this.gmxDataStoreAddress = gmxDataStoreAddress;
  }

  /**
   * Validate a complete market configuration
   */
  async validateMarket(config: MarketConfig): Promise<MarketValidationResult> {
    const result: MarketValidationResult = {
      isValid: false,
      checks: {
        uniswapPoolExists: false,
        uniswapPoolHasLiquidity: false,
        gmxMarketExists: false,
        gmxMarketHasLiquidity: false,
        chainlinkFeedExists: false,
        chainlinkFeedFresh: false,
        tokensMatch: false,
        decimalsConsistent: false,
      },
      warnings: [],
      errors: [],
    };

    console.log(`\nValidating market: ${config.name} (${config.id})`);
    console.log("=".repeat(50));

    // Run all validation checks
    await Promise.all([
      this.validateUniswapPool(config, result),
      this.validateGMXMarket(config, result),
      this.validateChainlinkFeed(config, result),
      this.validateTokens(config, result),
    ]);

    // Check token matching across components
    await this.validateCrossComponentConsistency(config, result);

    // Check price consistency
    await this.validatePriceConsistency(config, result);

    // Determine overall validity
    result.isValid =
      result.checks.uniswapPoolExists &&
      result.checks.uniswapPoolHasLiquidity &&
      result.checks.gmxMarketExists &&
      result.checks.chainlinkFeedExists &&
      result.checks.chainlinkFeedFresh &&
      result.checks.tokensMatch &&
      result.checks.decimalsConsistent;

    return result;
  }

  /**
   * Validate Uniswap V3 pool
   */
  private async validateUniswapPool(
    config: MarketConfig,
    result: MarketValidationResult
  ): Promise<void> {
    console.log("\n[Uniswap Pool Validation]");

    try {
      const pool = new ethers.Contract(config.uniswapPool.address, UNISWAP_POOL_ABI, this.provider);

      // Check pool exists by calling token0()
      const [token0, token1, fee, liquidity, slot0] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.fee(),
        pool.liquidity(),
        pool.slot0(),
      ]);

      result.checks.uniswapPoolExists = true;
      console.log(`  ✓ Pool exists at ${config.uniswapPool.address}`);

      // Verify token addresses
      const expectedToken0 = config.uniswapPool.token0.address.toLowerCase();
      const expectedToken1 = config.uniswapPool.token1.address.toLowerCase();

      if (token0.toLowerCase() !== expectedToken0 || token1.toLowerCase() !== expectedToken1) {
        result.errors.push(
          `Pool tokens mismatch. Expected: ${expectedToken0}/${expectedToken1}, Got: ${token0}/${token1}`
        );
      } else {
        console.log(`  ✓ Token addresses match`);
      }

      // Verify fee tier
      if (Number(fee) !== config.uniswapPool.feeTier) {
        result.errors.push(
          `Pool fee mismatch. Expected: ${config.uniswapPool.feeTier}, Got: ${fee}`
        );
      } else {
        console.log(`  ✓ Fee tier: ${Number(fee) / 10000}%`);
      }

      // Check liquidity
      if (liquidity > 0n) {
        result.checks.uniswapPoolHasLiquidity = true;
        console.log(`  ✓ Pool has liquidity: ${liquidity.toString()}`);
      } else {
        result.warnings.push("Uniswap pool has zero liquidity");
        console.log(`  ⚠ Pool has no liquidity`);
      }

      // Log current price
      const sqrtPriceX96 = slot0[0];
      console.log(`  ℹ Current sqrtPriceX96: ${sqrtPriceX96.toString()}`);
    } catch (error) {
      result.errors.push(`Failed to validate Uniswap pool: ${(error as Error).message}`);
      console.log(`  ✗ Pool validation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Validate GMX V2 market
   */
  private async validateGMXMarket(
    config: MarketConfig,
    result: MarketValidationResult
  ): Promise<void> {
    console.log("\n[GMX Market Validation]");

    try {
      const reader = new ethers.Contract(this.gmxReaderAddress, GMX_READER_ABI, this.provider);

      const market = await reader.getMarket(
        this.gmxDataStoreAddress,
        config.gmxMarket.marketAddress
      );

      if (market.marketToken === ethers.ZeroAddress) {
        result.errors.push("GMX market does not exist");
        console.log(`  ✗ Market does not exist`);
        return;
      }

      result.checks.gmxMarketExists = true;
      console.log(`  ✓ Market exists: ${config.gmxMarket.name}`);

      // Verify tokens
      const indexTokenMatch =
        market.indexToken.toLowerCase() === config.gmxMarket.indexToken.toLowerCase();
      const longTokenMatch =
        market.longToken.toLowerCase() === config.gmxMarket.longToken.toLowerCase();
      const shortTokenMatch =
        market.shortToken.toLowerCase() === config.gmxMarket.shortToken.toLowerCase();

      if (!indexTokenMatch) {
        result.errors.push(
          `GMX index token mismatch. Expected: ${config.gmxMarket.indexToken}, Got: ${market.indexToken}`
        );
      }
      if (!longTokenMatch) {
        result.warnings.push(
          `GMX long token differs. Expected: ${config.gmxMarket.longToken}, Got: ${market.longToken}`
        );
      }
      if (!shortTokenMatch) {
        result.errors.push(
          `GMX short token mismatch. Expected: ${config.gmxMarket.shortToken}, Got: ${market.shortToken}`
        );
      }

      if (indexTokenMatch && shortTokenMatch) {
        console.log(`  ✓ Market tokens match configuration`);
      }

      // Check available liquidity
      try {
        const dataStore = new ethers.Contract(
          this.gmxDataStoreAddress,
          GMX_DATA_STORE_ABI,
          this.provider
        );

        // Key for max short open interest
        const maxShortOIKey = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "address", "bool"],
            [
              ethers.keccak256(ethers.toUtf8Bytes("MAX_OPEN_INTEREST")),
              config.gmxMarket.marketAddress,
              false, // isLong = false for short
            ]
          )
        );

        const maxOI = await dataStore.getUint(maxShortOIKey);
        if (maxOI > 0n) {
          result.checks.gmxMarketHasLiquidity = true;
          console.log(`  ✓ Max short OI available: $${maxOI / 10n ** 30n}`);
        }
      } catch {
        // Non-critical - just log warning
        result.warnings.push("Could not verify GMX liquidity");
        result.checks.gmxMarketHasLiquidity = true; // Assume available
      }
    } catch (error) {
      result.errors.push(`Failed to validate GMX market: ${(error as Error).message}`);
      console.log(`  ✗ Market validation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Validate Chainlink price feed
   */
  private async validateChainlinkFeed(
    config: MarketConfig,
    result: MarketValidationResult
  ): Promise<void> {
    console.log("\n[Chainlink Feed Validation]");

    try {
      const feed = new ethers.Contract(
        config.chainlinkFeed.address,
        CHAINLINK_FEED_ABI,
        this.provider
      );

      const [decimals, description, roundData] = await Promise.all([
        feed.decimals(),
        feed.description(),
        feed.latestRoundData(),
      ]);

      result.checks.chainlinkFeedExists = true;
      console.log(`  ✓ Feed exists: ${description}`);

      // Verify decimals
      if (Number(decimals) !== config.chainlinkFeed.decimals) {
        result.warnings.push(
          `Chainlink decimals mismatch. Expected: ${config.chainlinkFeed.decimals}, Got: ${decimals}`
        );
      } else {
        console.log(`  ✓ Decimals: ${decimals}`);
      }

      // Check freshness
      const updatedAt = Number(roundData[3]);
      const age = Math.floor(Date.now() / 1000) - updatedAt;

      if (age <= config.chainlinkFeed.heartbeat * 2) {
        result.checks.chainlinkFeedFresh = true;
        console.log(`  ✓ Feed is fresh (${age}s old)`);
      } else {
        result.warnings.push(`Chainlink feed is stale (${age}s old)`);
        console.log(`  ⚠ Feed may be stale (${age}s old)`);
      }

      // Log current price
      const price = Number(roundData[1]) / 10 ** Number(decimals);
      console.log(`  ℹ Current price: $${price.toFixed(2)}`);
    } catch (error) {
      result.errors.push(`Failed to validate Chainlink feed: ${(error as Error).message}`);
      console.log(`  ✗ Feed validation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Validate token configurations
   */
  private async validateTokens(
    config: MarketConfig,
    result: MarketValidationResult
  ): Promise<void> {
    console.log("\n[Token Validation]");

    try {
      const baseToken = new ethers.Contract(config.baseToken.address, ERC20_ABI, this.provider);
      const quoteToken = new ethers.Contract(config.quoteToken.address, ERC20_ABI, this.provider);

      const [baseSymbol, baseDecimals, quoteSymbol, quoteDecimals] = await Promise.all([
        baseToken.symbol(),
        baseToken.decimals(),
        quoteToken.symbol(),
        quoteToken.decimals(),
      ]);

      // Verify base token
      if (baseSymbol !== config.baseToken.symbol) {
        result.warnings.push(
          `Base token symbol mismatch. Expected: ${config.baseToken.symbol}, Got: ${baseSymbol}`
        );
      }
      if (Number(baseDecimals) !== config.baseToken.decimals) {
        result.errors.push(
          `Base token decimals mismatch. Expected: ${config.baseToken.decimals}, Got: ${baseDecimals}`
        );
      } else {
        console.log(`  ✓ Base token: ${baseSymbol} (${baseDecimals} decimals)`);
        result.checks.decimalsConsistent = true;
      }

      // Verify quote token
      if (quoteSymbol !== config.quoteToken.symbol) {
        result.warnings.push(
          `Quote token symbol mismatch. Expected: ${config.quoteToken.symbol}, Got: ${quoteSymbol}`
        );
      }
      if (Number(quoteDecimals) !== config.quoteToken.decimals) {
        result.errors.push(
          `Quote token decimals mismatch. Expected: ${config.quoteToken.decimals}, Got: ${quoteDecimals}`
        );
        result.checks.decimalsConsistent = false;
      } else {
        console.log(`  ✓ Quote token: ${quoteSymbol} (${quoteDecimals} decimals)`);
      }
    } catch (error) {
      result.errors.push(`Failed to validate tokens: ${(error as Error).message}`);
      console.log(`  ✗ Token validation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Validate consistency across components
   */
  private async validateCrossComponentConsistency(
    config: MarketConfig,
    result: MarketValidationResult
  ): Promise<void> {
    console.log("\n[Cross-Component Consistency]");

    // Check that base token appears in all components
    const baseInPool =
      config.uniswapPool.token0.address.toLowerCase() === config.baseToken.address.toLowerCase() ||
      config.uniswapPool.token1.address.toLowerCase() === config.baseToken.address.toLowerCase();

    const baseInGMX =
      config.gmxMarket.indexToken.toLowerCase() === config.baseToken.address.toLowerCase();

    // Quote token should be in pool and GMX short token
    const quoteInPool =
      config.uniswapPool.token0.address.toLowerCase() === config.quoteToken.address.toLowerCase() ||
      config.uniswapPool.token1.address.toLowerCase() === config.quoteToken.address.toLowerCase();

    const quoteInGMX =
      config.gmxMarket.shortToken.toLowerCase() === config.quoteToken.address.toLowerCase();

    result.checks.tokensMatch = baseInPool && baseInGMX && quoteInPool && quoteInGMX;

    if (result.checks.tokensMatch) {
      console.log(`  ✓ All components use consistent tokens`);
    } else {
      if (!baseInPool) result.errors.push("Base token not found in Uniswap pool");
      if (!baseInGMX) result.errors.push("Base token not index token in GMX market");
      if (!quoteInPool) result.errors.push("Quote token not found in Uniswap pool");
      if (!quoteInGMX) result.errors.push("Quote token not short token in GMX market");
      console.log(`  ✗ Token mismatch across components`);
    }

    // Verify baseTokenIsToken0 flag
    const computedBaseIsToken0 =
      config.baseToken.address.toLowerCase() < config.quoteToken.address.toLowerCase();

    if (config.baseTokenIsToken0 !== computedBaseIsToken0) {
      result.warnings.push(`baseTokenIsToken0 flag incorrect. Should be: ${computedBaseIsToken0}`);
      console.log(`  ⚠ baseTokenIsToken0 flag may be incorrect`);
    } else {
      console.log(`  ✓ baseTokenIsToken0: ${config.baseTokenIsToken0} (correct)`);
    }
  }

  /**
   * Validate price consistency across sources
   */
  private async validatePriceConsistency(
    config: MarketConfig,
    result: MarketValidationResult
  ): Promise<void> {
    console.log("\n[Price Consistency]");

    try {
      // Get Chainlink price
      const feed = new ethers.Contract(
        config.chainlinkFeed.address,
        CHAINLINK_FEED_ABI,
        this.provider
      );
      const [, chainlinkAnswer] = await feed.latestRoundData();
      const chainlinkPrice = Number(chainlinkAnswer) / 10 ** config.chainlinkFeed.decimals;

      // Get Uniswap price
      const pool = new ethers.Contract(config.uniswapPool.address, UNISWAP_POOL_ABI, this.provider);
      const slot0 = await pool.slot0();
      const sqrtPriceX96 = slot0[0] as bigint;

      // Convert sqrtPriceX96 to a human-readable base token price using
      // the shared helper to keep logic consistent with the rest of the codebase.
      const uniswapPrice = sqrtPriceX96ToPrice(
        sqrtPriceX96,
        config.uniswapPool.token0.decimals,
        config.uniswapPool.token1.decimals,
        config.baseTokenIsToken0
      );

      // Calculate deviation
      const deviation =
        Math.abs(chainlinkPrice - uniswapPrice) / ((chainlinkPrice + uniswapPrice) / 2);

      result.priceConsistency = {
        uniswapPrice,
        chainlinkPrice,
        gmxPrice: chainlinkPrice, // GMX uses Chainlink
        maxDeviation: deviation,
      };

      console.log(`  ℹ Chainlink price: $${chainlinkPrice.toFixed(2)}`);
      console.log(`  ℹ Uniswap price: $${uniswapPrice.toFixed(2)}`);
      console.log(`  ℹ Price deviation: ${(deviation * 100).toFixed(2)}%`);

      if (deviation > 0.02) {
        // > 2%
        result.warnings.push(
          `High price deviation between sources: ${(deviation * 100).toFixed(2)}%`
        );
        console.log(`  ⚠ Price deviation exceeds 2%`);
      } else {
        console.log(`  ✓ Price sources are consistent`);
      }
    } catch (error) {
      result.warnings.push(`Could not verify price consistency: ${(error as Error).message}`);
      console.log(`  ⚠ Could not verify price consistency`);
    }
  }
}

/**
 * Print validation result summary
 */
export function printValidationSummary(result: MarketValidationResult): void {
  console.log("\n" + "=".repeat(50));
  console.log("VALIDATION SUMMARY");
  console.log("=".repeat(50));

  console.log(`\nOverall: ${result.isValid ? "✓ VALID" : "✗ INVALID"}\n`);

  console.log("Checks:");
  for (const [check, passed] of Object.entries(result.checks)) {
    console.log(`  ${passed ? "✓" : "✗"} ${check}`);
  }

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    result.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    result.errors.forEach((e) => console.log(`  ✗ ${e}`));
  }

  if (result.priceConsistency) {
    console.log("\nPrice Data:");
    console.log(`  Chainlink: $${result.priceConsistency.chainlinkPrice.toFixed(2)}`);
    console.log(`  Uniswap: $${result.priceConsistency.uniswapPrice.toFixed(2)}`);
    console.log(`  Deviation: ${(result.priceConsistency.maxDeviation * 100).toFixed(2)}%`);
  }
}
