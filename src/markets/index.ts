/**
 * Harmonia Markets Module
 *
 * Provides configuration, discovery, and validation for multi-market
 * delta-neutral vaults.
 */

// Types
export {
  TokenConfig,
  UniswapPoolConfig,
  GMXMarketConfig,
  ChainlinkFeedConfig,
  MarketConfig,
  MarketValidationResult,
  MarketDiscoveryResult,
  calculateDecimalAdjustment,
  isBaseTokenToken0,
  priceToSqrtPriceX96,
  sqrtPriceX96ToPrice,
} from "./types";

// Registry
export {
  ARBITRUM_TOKENS,
  ARBITRUM_PROTOCOLS,
  TICK_SPACING,
  ETH_MARKET,
  BTC_MARKET,
  ARB_MARKET,
  LINK_MARKET,
  MARKET_REGISTRY,
  getMarketConfig,
  getAvailableMarkets,
  getMarketsByRiskLevel,
  getMarketsByLiquidity,
} from "./registry";

// Validator
export { MarketValidator, printValidationSummary } from "./validator";

// Discovery
export { MarketDiscovery, printDiscoveryResult, KNOWN_CHAINLINK_FEEDS } from "./discovery";
