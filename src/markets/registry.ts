/**
 * Market Registry
 *
 * Pre-configured market definitions for various token pairs on Arbitrum.
 * Each configuration contains all addresses and parameters needed to deploy
 * a delta-neutral vault for that market.
 */

import { MarketConfig, TokenConfig, calculateDecimalAdjustment, isBaseTokenToken0 } from "./types";

// =============================================================================
// Common Token Definitions (Arbitrum One)
// =============================================================================

export const ARBITRUM_TOKENS: Record<string, TokenConfig> = {
  WETH: {
    symbol: "WETH",
    address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    decimals: 18,
    isNativeWrapper: true,
  },
  USDC: {
    symbol: "USDC",
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6,
  },
  USDC_E: {
    symbol: "USDC.e",
    address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    decimals: 6,
  },
  WBTC: {
    symbol: "WBTC",
    address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    decimals: 8,
  },
  ARB: {
    symbol: "ARB",
    address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    decimals: 18,
  },
  LINK: {
    symbol: "LINK",
    address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    decimals: 18,
  },
  UNI: {
    symbol: "UNI",
    address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0",
    decimals: 18,
  },
  GMX: {
    symbol: "GMX",
    address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",
    decimals: 18,
  },
};

// =============================================================================
// Common Protocol Addresses (Arbitrum One)
// =============================================================================

export const ARBITRUM_PROTOCOLS = {
  // Uniswap V3
  UNISWAP_V3_FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  UNISWAP_V3_POSITION_MANAGER: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  UNISWAP_V3_SWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_V3_QUOTER: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",

  // GMX V2
  GMX_EXCHANGE_ROUTER: "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8",
  GMX_ORDER_VAULT: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  GMX_DATA_STORE: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
  GMX_READER: "0xf60becbba223EEA9495Da3f606753867eC10d139",
  GMX_REFERRAL_STORAGE: "0xe6fab3F0c7199b0d34d7FbE83394fc0e0D06e99d",

  // Chainlink
  CHAINLINK_AUTOMATION_REGISTRY: "0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1",
  CHAINLINK_FEED_REGISTRY: "0x0000000000000000000000000000000000000000", // Not available on Arbitrum
};

// =============================================================================
// Tick Spacing by Fee Tier
// =============================================================================

export const TICK_SPACING: Record<number, number> = {
  100: 1, // 0.01%
  500: 10, // 0.05%
  3000: 60, // 0.3%
  10000: 200, // 1%
};

// =============================================================================
// Market Configurations
// =============================================================================

/**
 * ETH Market Configuration
 * Primary market: WETH/USDC with ETH/USD hedge
 */
export const ETH_MARKET: MarketConfig = {
  id: "ETH",
  name: "Harmonia ETH",
  description: "Delta-neutral ETH yield vault using WETH/USDC LP and ETH/USD perpetual hedge",
  chainId: 42161,

  baseToken: ARBITRUM_TOKENS.WETH,
  quoteToken: ARBITRUM_TOKENS.USDC,

  uniswapPool: {
    address: "0xC6962004f452bE9203591991D15f6b388e09E8D0",
    feeTier: 500, // 0.05%
    tickSpacing: 10,
    token0: ARBITRUM_TOKENS.WETH, // WETH < USDC by address
    token1: ARBITRUM_TOKENS.USDC,
  },

  gmxMarket: {
    marketAddress: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
    indexToken: ARBITRUM_TOKENS.WETH.address,
    longToken: ARBITRUM_TOKENS.WETH.address,
    shortToken: ARBITRUM_TOKENS.USDC.address,
    name: "ETH/USD",
  },

  chainlinkFeed: {
    address: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
    description: "ETH / USD",
    decimals: 8,
    heartbeat: 3600, // 1 hour
  },

  baseTokenIsToken0: isBaseTokenToken0(ARBITRUM_TOKENS.WETH.address, ARBITRUM_TOKENS.USDC.address),

  decimalAdjustment: calculateDecimalAdjustment(
    ARBITRUM_TOKENS.WETH.decimals,
    ARBITRUM_TOKENS.USDC.decimals
  ),

  strategyParams: {
    defaultRangeWidth: 0.1, // ±10%
    rebalanceThreshold: 0.05, // 5% delta drift
    minLpRatio: 0.8, // 80% in LP minimum
    maxHedgeLeverage: 3, // 3x max
  },

  characteristics: {
    expectedFeeApy: [5, 20],
    volatilityLevel: "medium",
    liquidityRating: "high",
    riskLevel: "moderate",
  },
};

/**
 * BTC Market Configuration
 * Uses WBTC/USDC LP with BTC/USD perpetual hedge
 */
export const BTC_MARKET: MarketConfig = {
  id: "BTC",
  name: "Harmonia BTC",
  description: "Delta-neutral BTC yield vault using WBTC/USDC LP and BTC/USD perpetual hedge",
  chainId: 42161,

  baseToken: ARBITRUM_TOKENS.WBTC,
  quoteToken: ARBITRUM_TOKENS.USDC,

  uniswapPool: {
    address: "0x0E4831319A50228B9e450861297aB92dee15B44F", // WBTC/USDC 0.05%
    feeTier: 500, // 0.05%
    tickSpacing: 10,
    token0: ARBITRUM_TOKENS.WBTC, // WBTC < USDC by address
    token1: ARBITRUM_TOKENS.USDC,
  },

  gmxMarket: {
    marketAddress: "0x47c031236e19d024b42f8AE6780E44A573170703",
    indexToken: ARBITRUM_TOKENS.WBTC.address,
    longToken: ARBITRUM_TOKENS.WBTC.address,
    shortToken: ARBITRUM_TOKENS.USDC.address,
    name: "BTC/USD",
  },

  chainlinkFeed: {
    address: "0x6ce185860a4963106506C203335A2910525d22AD",
    description: "BTC / USD",
    decimals: 8,
    heartbeat: 3600, // 1 hour
  },

  baseTokenIsToken0: isBaseTokenToken0(ARBITRUM_TOKENS.WBTC.address, ARBITRUM_TOKENS.USDC.address),

  decimalAdjustment: calculateDecimalAdjustment(
    ARBITRUM_TOKENS.WBTC.decimals, // 8 decimals
    ARBITRUM_TOKENS.USDC.decimals // 6 decimals
  ),

  strategyParams: {
    defaultRangeWidth: 0.15, // ±15% (BTC can be more volatile in terms of $)
    rebalanceThreshold: 0.05,
    minLpRatio: 0.8,
    maxHedgeLeverage: 3,
  },

  characteristics: {
    expectedFeeApy: [3, 15],
    volatilityLevel: "medium",
    liquidityRating: "medium", // Lower than ETH/USDC
    riskLevel: "moderate",
  },
};

/**
 * ARB Market Configuration
 * Uses ARB/USDC LP with ARB/USD perpetual hedge
 * Higher risk due to ARB's higher volatility
 */
export const ARB_MARKET: MarketConfig = {
  id: "ARB",
  name: "Harmonia ARB",
  description: "Delta-neutral ARB yield vault using ARB/USDC LP and ARB/USD perpetual hedge",
  chainId: 42161,

  baseToken: ARBITRUM_TOKENS.ARB,
  quoteToken: ARBITRUM_TOKENS.USDC,

  uniswapPool: {
    address: "0xC6F780497A95e246EB9449f5e4770916DCd6396A", // ARB/USDC 0.3%
    feeTier: 3000, // 0.3%
    tickSpacing: 60,
    token0: ARBITRUM_TOKENS.USDC, // USDC < ARB by address (ARB starts with 0x9...)
    token1: ARBITRUM_TOKENS.ARB,
  },

  gmxMarket: {
    marketAddress: "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407",
    indexToken: ARBITRUM_TOKENS.ARB.address,
    longToken: ARBITRUM_TOKENS.ARB.address,
    shortToken: ARBITRUM_TOKENS.USDC.address,
    name: "ARB/USD",
  },

  chainlinkFeed: {
    address: "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6",
    description: "ARB / USD",
    decimals: 8,
    heartbeat: 3600,
  },

  baseTokenIsToken0: isBaseTokenToken0(ARBITRUM_TOKENS.ARB.address, ARBITRUM_TOKENS.USDC.address),

  decimalAdjustment: calculateDecimalAdjustment(
    ARBITRUM_TOKENS.USDC.decimals, // Note: USDC is token0 here
    ARBITRUM_TOKENS.ARB.decimals
  ),

  strategyParams: {
    defaultRangeWidth: 0.2, // ±20% (ARB is more volatile)
    rebalanceThreshold: 0.07, // 7% threshold (wider for volatile asset)
    minLpRatio: 0.75, // Slightly lower LP ratio
    maxHedgeLeverage: 2, // Lower leverage for volatile asset
  },

  characteristics: {
    expectedFeeApy: [10, 40], // Higher fees for higher volatility
    volatilityLevel: "high",
    liquidityRating: "medium",
    riskLevel: "aggressive",
  },
};

/**
 * LINK Market Configuration
 * Uses LINK/USDC LP with LINK/USD perpetual hedge
 */
export const LINK_MARKET: MarketConfig = {
  id: "LINK",
  name: "Harmonia LINK",
  description: "Delta-neutral LINK yield vault using LINK/USDC LP and LINK/USD perpetual hedge",
  chainId: 42161,

  baseToken: ARBITRUM_TOKENS.LINK,
  quoteToken: ARBITRUM_TOKENS.USDC,

  uniswapPool: {
    address: "0x655B739E0b3BB00D6b74BBCd5C9169aEb0aa2e68", // LINK/USDC pool
    feeTier: 3000,
    tickSpacing: 60,
    token0: ARBITRUM_TOKENS.USDC, // USDC < LINK by address
    token1: ARBITRUM_TOKENS.LINK,
  },

  gmxMarket: {
    marketAddress: "0x7f1fa204bb700853D36994DA19F830b6Ad18455C",
    indexToken: ARBITRUM_TOKENS.LINK.address,
    longToken: ARBITRUM_TOKENS.LINK.address,
    shortToken: ARBITRUM_TOKENS.USDC.address,
    name: "LINK/USD",
  },

  chainlinkFeed: {
    address: "0x86E53CF1B870786351Da77A57575e79CB55812CB",
    description: "LINK / USD",
    decimals: 8,
    heartbeat: 3600,
  },

  baseTokenIsToken0: isBaseTokenToken0(ARBITRUM_TOKENS.LINK.address, ARBITRUM_TOKENS.USDC.address),

  decimalAdjustment: calculateDecimalAdjustment(
    ARBITRUM_TOKENS.USDC.decimals,
    ARBITRUM_TOKENS.LINK.decimals
  ),

  strategyParams: {
    defaultRangeWidth: 0.15,
    rebalanceThreshold: 0.06,
    minLpRatio: 0.75,
    maxHedgeLeverage: 2.5,
  },

  characteristics: {
    expectedFeeApy: [8, 30],
    volatilityLevel: "high",
    liquidityRating: "medium",
    riskLevel: "aggressive",
  },
};

// =============================================================================
// Market Registry
// =============================================================================

export const MARKET_REGISTRY: Record<string, MarketConfig> = {
  ETH: ETH_MARKET,
  BTC: BTC_MARKET,
  ARB: ARB_MARKET,
  LINK: LINK_MARKET,
};

/**
 * Get a market configuration by ID
 */
export function getMarketConfig(marketId: string): MarketConfig | undefined {
  return MARKET_REGISTRY[marketId.toUpperCase()];
}

/**
 * Get all available market IDs
 */
export function getAvailableMarkets(): string[] {
  return Object.keys(MARKET_REGISTRY);
}

/**
 * Get markets filtered by characteristic
 */
export function getMarketsByRiskLevel(
  riskLevel: "conservative" | "moderate" | "aggressive"
): MarketConfig[] {
  return Object.values(MARKET_REGISTRY).filter(
    (market) => market.characteristics.riskLevel === riskLevel
  );
}

/**
 * Get markets filtered by liquidity rating
 */
export function getMarketsByLiquidity(rating: "low" | "medium" | "high"): MarketConfig[] {
  return Object.values(MARKET_REGISTRY).filter(
    (market) => market.characteristics.liquidityRating === rating
  );
}
