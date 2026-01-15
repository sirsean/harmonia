/**
 * Market Configuration Types
 *
 * Defines the structure for configuring different token pair markets
 * to enable harmonia-ETH, harmonia-BTC, harmonia-ARB, etc.
 */

/**
 * Token configuration with all necessary metadata
 */
export interface TokenConfig {
  /** Token symbol (e.g., "WETH", "WBTC", "ARB") */
  symbol: string;
  /** Token contract address */
  address: string;
  /** Token decimals */
  decimals: number;
  /** Whether this is the native gas token wrapper (WETH on Arbitrum) */
  isNativeWrapper?: boolean;
}

/**
 * Uniswap V3 pool configuration
 */
export interface UniswapPoolConfig {
  /** Pool contract address */
  address: string;
  /** Fee tier in basis points (500 = 0.05%, 3000 = 0.3%, 10000 = 1%) */
  feeTier: number;
  /** Tick spacing for this fee tier */
  tickSpacing: number;
  /** Token0 configuration (lower address) */
  token0: TokenConfig;
  /** Token1 configuration (higher address) */
  token1: TokenConfig;
}

/**
 * GMX V2 perpetual market configuration
 */
export interface GMXMarketConfig {
  /** Market token address (the market identifier) */
  marketAddress: string;
  /** Index token (the asset being traded, e.g., WETH for ETH/USD perp) */
  indexToken: string;
  /** Long collateral token */
  longToken: string;
  /** Short collateral token (typically USDC) */
  shortToken: string;
  /** Human-readable name (e.g., "ETH/USD") */
  name: string;
}

/**
 * Chainlink price feed configuration
 */
export interface ChainlinkFeedConfig {
  /** Price feed contract address */
  address: string;
  /** Feed description (e.g., "ETH / USD") */
  description: string;
  /** Price feed decimals (typically 8) */
  decimals: number;
  /** Maximum staleness in seconds (heartbeat) */
  heartbeat: number;
}

/**
 * Complete market configuration for a delta-neutral vault
 */
export interface MarketConfig {
  /** Market identifier (e.g., "ETH", "BTC", "ARB") */
  id: string;
  /** Human-readable market name */
  name: string;
  /** Market description */
  description: string;

  /** Chain ID this configuration is valid for */
  chainId: number;

  /** The base/volatile token (what we're hedging) */
  baseToken: TokenConfig;
  /** The quote/stable token (what users deposit) */
  quoteToken: TokenConfig;

  /** Uniswap V3 pool configuration */
  uniswapPool: UniswapPoolConfig;

  /** GMX V2 market configuration */
  gmxMarket: GMXMarketConfig;

  /** Chainlink price feed configuration */
  chainlinkFeed: ChainlinkFeedConfig;

  /** Whether base token is token0 in the Uniswap pool */
  baseTokenIsToken0: boolean;

  /** Decimal adjustment factor: 10^(token0Decimals - token1Decimals) */
  decimalAdjustment: bigint;

  /** Recommended strategy parameters */
  strategyParams: {
    /** Recommended range width (e.g., 0.10 for ±10%) */
    defaultRangeWidth: number;
    /** Delta threshold for rebalancing (e.g., 0.05 for 5%) */
    rebalanceThreshold: number;
    /** Minimum LP allocation ratio */
    minLpRatio: number;
    /** Maximum leverage for perp hedge */
    maxHedgeLeverage: number;
  };

  /** Expected characteristics */
  characteristics: {
    /** Expected fee APY range [min, max] */
    expectedFeeApy: [number, number];
    /** Typical volatility level */
    volatilityLevel: "low" | "medium" | "high" | "extreme";
    /** Liquidity depth rating */
    liquidityRating: "low" | "medium" | "high";
    /** Risk level */
    riskLevel: "conservative" | "moderate" | "aggressive";
  };
}

/**
 * Market validation result
 */
export interface MarketValidationResult {
  /** Overall validity */
  isValid: boolean;
  /** Individual check results */
  checks: {
    uniswapPoolExists: boolean;
    uniswapPoolHasLiquidity: boolean;
    gmxMarketExists: boolean;
    gmxMarketHasLiquidity: boolean;
    chainlinkFeedExists: boolean;
    chainlinkFeedFresh: boolean;
    tokensMatch: boolean;
    decimalsConsistent: boolean;
  };
  /** Warning messages */
  warnings: string[];
  /** Error messages */
  errors: string[];
  /** Liquidity metrics */
  liquidity?: {
    uniswapTvl: bigint;
    uniswap24hVolume: bigint;
    gmxOpenInterest: bigint;
    gmxAvailableLiquidity: bigint;
  };
  /** Price consistency check */
  priceConsistency?: {
    uniswapPrice: number;
    chainlinkPrice: number;
    gmxPrice: number;
    maxDeviation: number;
  };
}

/**
 * Market discovery result
 */
export interface MarketDiscoveryResult {
  /** Discovered Uniswap pools for a token pair */
  uniswapPools: Array<{
    address: string;
    feeTier: number;
    liquidity: bigint;
    volume24h: bigint;
  }>;
  /** Discovered GMX markets */
  gmxMarkets: Array<{
    address: string;
    indexToken: string;
    openInterest: bigint;
    availableLiquidity: bigint;
  }>;
  /** Discovered Chainlink feeds */
  chainlinkFeeds: Array<{
    address: string;
    description: string;
    decimals: number;
    latestPrice: bigint;
    updatedAt: number;
  }>;
  /** Recommended configuration if all components found */
  recommendedConfig?: Partial<MarketConfig>;
}

/**
 * Helper to calculate decimal adjustment between two tokens
 */
export function calculateDecimalAdjustment(
  token0Decimals: number,
  token1Decimals: number
): bigint {
  const diff = token0Decimals - token1Decimals;
  if (diff >= 0) {
    return BigInt(10) ** BigInt(diff);
  } else {
    // When token1 has more decimals, we need to divide
    // Store as negative power indicator - caller handles division
    return BigInt(10) ** BigInt(-diff);
  }
}

/**
 * Helper to determine if base token is token0 in a Uniswap pool
 * Token0 is always the lower address
 */
export function isBaseTokenToken0(
  baseTokenAddress: string,
  quoteTokenAddress: string
): boolean {
  return baseTokenAddress.toLowerCase() < quoteTokenAddress.toLowerCase();
}

/**
 * Convert a price to sqrtPriceX96 format with proper decimal handling
 */
export function priceToSqrtPriceX96(
  price: number,
  token0Decimals: number,
  token1Decimals: number,
  baseIsToken0: boolean
): bigint {
  const Q96 = BigInt(2) ** BigInt(96);

  // Pool price is token1/token0 with decimal adjustment
  // If base is token0: poolPrice = price * 10^(token0Decimals - token1Decimals)
  // If base is token1: poolPrice = (1/price) * 10^(token0Decimals - token1Decimals)
  const decimalDiff = token0Decimals - token1Decimals;
  const decimalMultiplier = Math.pow(10, decimalDiff);

  let poolPrice: number;
  if (baseIsToken0) {
    poolPrice = price * decimalMultiplier;
  } else {
    poolPrice = decimalMultiplier / price;
  }

  const sqrtPrice = Math.sqrt(poolPrice);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

/**
 * Convert sqrtPriceX96 to human-readable price
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
  baseIsToken0: boolean
): number {
  const Q96 = BigInt(2) ** BigInt(96);
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const poolPrice = sqrtPrice * sqrtPrice;

  const decimalDiff = token0Decimals - token1Decimals;
  const decimalMultiplier = Math.pow(10, decimalDiff);

  if (baseIsToken0) {
    return poolPrice / decimalMultiplier;
  } else {
    return decimalMultiplier / poolPrice;
  }
}
