// Test constants and utilities for Harmonia tests
// NOTE: For market-specific configuration, prefer using src/markets/registry.ts
// This file provides backward-compatible constants and token-agnostic utilities.

export const Q96 = BigInt(2) ** BigInt(96);
export const PRECISION = BigInt(10) ** BigInt(18);

// =============================================================================
// Protocol Addresses (Chain Infrastructure - not token-specific)
// =============================================================================

export const PROTOCOL_ADDRESSES = {
  // Uniswap V3 (same for all markets on Arbitrum)
  UNISWAP_V3_FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  UNISWAP_V3_POSITION_MANAGER: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  UNISWAP_V3_SWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_V3_QUOTER: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",

  // GMX V2 (same for all markets on Arbitrum)
  GMX_EXCHANGE_ROUTER: "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8",
  GMX_ORDER_VAULT: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  GMX_DATA_STORE: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
  GMX_READER: "0xf60becbba223EEA9495Da3f606753867eC10d139",

  // Chainlink Automation
  CHAINLINK_AUTOMATION_REGISTRY: "0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1",
};

// =============================================================================
// Backward-compatible ADDRESSES export (use PROTOCOL_ADDRESSES + market configs)
// =============================================================================

export const ADDRESSES = {
  ...PROTOCOL_ADDRESSES,
  // Legacy ETH-specific addresses for backward compatibility
  UNISWAP_V3_ETH_USDC_005_POOL: "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443",
  GMX_ETH_USD_MARKET: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
  CHAINLINK_ETH_USD_FEED: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};

// =============================================================================
// Token Configurations (for dynamic market testing)
// =============================================================================

export interface TokenConfig {
  symbol: string;
  address: string;
  decimals: number;
}

export const TOKENS: Record<string, TokenConfig> = {
  WETH: { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
  USDC: { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  WBTC: { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8 },
  ARB: { symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
  LINK: { symbol: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18 },
};

// =============================================================================
// Market Configurations (for parameterized testing)
// =============================================================================

export interface MarketTestConfig {
  id: string;
  name: string;
  baseToken: TokenConfig;
  quoteToken: TokenConfig;
  uniswapPool: string;
  gmxMarket: string;
  chainlinkFeed: string;
  baseTokenIsToken0: boolean;
}

export const MARKET_CONFIGS: Record<string, MarketTestConfig> = {
  ETH: {
    id: "ETH",
    name: "ETH/USDC",
    baseToken: TOKENS.WETH,
    quoteToken: TOKENS.USDC,
    uniswapPool: "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443",
    gmxMarket: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
    chainlinkFeed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
    baseTokenIsToken0: true, // WETH address < USDC address
  },
  BTC: {
    id: "BTC",
    name: "WBTC/USDC",
    baseToken: TOKENS.WBTC,
    quoteToken: TOKENS.USDC,
    uniswapPool: "0xac70bD92F89e6739B3a08Db9B6081a923912f73D",
    gmxMarket: "0x47c031236e19d024b42f8AE6780E44A573170703",
    chainlinkFeed: "0x6ce185860a4963106506C203335A2910525d22AD",
    baseTokenIsToken0: true, // WBTC address < USDC address
  },
  ARB: {
    id: "ARB",
    name: "ARB/USDC",
    baseToken: TOKENS.ARB,
    quoteToken: TOKENS.USDC,
    uniswapPool: "0xC6F780497A95e246EB9449f5e4770916DCd6396A",
    gmxMarket: "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407",
    chainlinkFeed: "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6",
    baseTokenIsToken0: false, // ARB address (0x91...) > USDC address (0xaf...)
  },
};

// Historical blocks for scenario testing
export const HISTORICAL_BLOCKS = {
  // Typical market conditions - stable period
  STABLE_MARKET: 273000000,
  // High volatility period
  HIGH_VOLATILITY: 200000000,
  // Recent block
  RECENT: 290000000,
};

// Scenario definitions for historical testing
export const TEST_SCENARIOS = {
  // Bull market scenario - ETH trending up
  BULL_MARKET: {
    name: "Bull Market",
    description: "ETH price trending upward, positive funding rates",
    expectedFunding: "positive",
    volatility: "medium",
  },
  // Bear market scenario - ETH trending down
  BEAR_MARKET: {
    name: "Bear Market",
    description: "ETH price trending downward, negative funding rates",
    expectedFunding: "negative",
    volatility: "high",
  },
  // Sideways market - range bound
  SIDEWAYS: {
    name: "Sideways Market",
    description: "ETH price range bound, mixed funding rates",
    expectedFunding: "mixed",
    volatility: "low",
  },
  // Flash crash scenario
  FLASH_CRASH: {
    name: "Flash Crash",
    description: "Rapid price decline followed by recovery",
    expectedFunding: "volatile",
    volatility: "extreme",
  },
};

/**
 * Convert tick to sqrtPriceX96
 * @param tick The tick value
 * @returns sqrtPriceX96 as bigint
 */
export function tickToSqrtPriceX96(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

/**
 * Convert sqrtPriceX96 to tick
 * @param sqrtPriceX96 The sqrt price in Q64.96 format
 * @returns tick as number
 */
export function sqrtPriceX96ToTick(sqrtPriceX96: bigint): number {
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  // tick = 2 * log(sqrtPrice) / log(1.0001)
  return Math.floor((2 * Math.log(sqrtPrice)) / Math.log(1.0001));
}

/**
 * Convert price to sqrtPriceX96 for any token pair
 * @param price Price of base token in quote token units
 * @param token0Decimals Decimals of token0
 * @param token1Decimals Decimals of token1
 * @param baseIsToken0 Whether the base (priced) token is token0
 * @returns sqrtPriceX96 as bigint
 */
export function priceToSqrtPriceX96Generic(
  price: number,
  token0Decimals: number,
  token1Decimals: number,
  baseIsToken0: boolean
): bigint {
  // Pool price = token1/token0 with decimal adjustment
  // Decimal adjustment = 10^(token0Decimals - token1Decimals)
  const decimalDiff = token0Decimals - token1Decimals;
  const decimalMultiplier = Math.pow(10, decimalDiff);

  let poolPrice: number;
  if (baseIsToken0) {
    // Base is token0, quote is token1
    // poolPrice = quote/base = price * decimalMultiplier
    poolPrice = price * decimalMultiplier;
  } else {
    // Base is token1, quote is token0
    // poolPrice = quote/base = (1/price) * decimalMultiplier
    poolPrice = decimalMultiplier / price;
  }

  const sqrtPrice = Math.sqrt(poolPrice);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

/**
 * Convert price to sqrtPriceX96 for ETH/USDC pool (backward compatible)
 * @deprecated Use priceToSqrtPriceX96Generic for new code
 * @param priceUsdPerEth Price in USD per ETH
 * @param wethIsToken0 Whether WETH is token0 in the pool
 * @returns sqrtPriceX96 as bigint
 */
export function priceToSqrtPriceX96(priceUsdPerEth: number, wethIsToken0: boolean = true): bigint {
  // WETH: 18 decimals, USDC: 6 decimals
  return priceToSqrtPriceX96Generic(priceUsdPerEth, 18, 6, wethIsToken0);
}

/**
 * Convert sqrtPriceX96 to human-readable price for any token pair
 * @param sqrtPriceX96 The sqrt price
 * @param token0Decimals Decimals of token0
 * @param token1Decimals Decimals of token1
 * @param baseIsToken0 Whether the base (priced) token is token0
 * @returns Price of base token in quote token units
 */
export function sqrtPriceX96ToPriceGeneric(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
  baseIsToken0: boolean
): number {
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const poolPrice = sqrtPrice * sqrtPrice;

  const decimalDiff = token0Decimals - token1Decimals;
  const decimalMultiplier = Math.pow(10, decimalDiff);

  if (baseIsToken0) {
    // Base is token0, quote is token1
    // price = poolPrice / decimalMultiplier
    return poolPrice / decimalMultiplier;
  } else {
    // Base is token1, quote is token0
    // price = decimalMultiplier / poolPrice
    return decimalMultiplier / poolPrice;
  }
}

/**
 * Convert sqrtPriceX96 to human-readable ETH price (backward compatible)
 * @deprecated Use sqrtPriceX96ToPriceGeneric for new code
 * @param sqrtPriceX96 The sqrt price
 * @param wethIsToken0 Whether WETH is token0
 * @returns Price in USD per ETH
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, wethIsToken0: boolean = true): number {
  // WETH: 18 decimals, USDC: 6 decimals
  return sqrtPriceX96ToPriceGeneric(sqrtPriceX96, 18, 6, wethIsToken0);
}

/**
 * Calculate the range width in percentage
 * @param tickLower Lower tick
 * @param tickUpper Upper tick
 * @returns Range width as percentage (e.g., 0.1 for 10%)
 */
export function calculateRangeWidth(tickLower: number, tickUpper: number): number {
  const priceLower = Math.pow(1.0001, tickLower);
  const priceUpper = Math.pow(1.0001, tickUpper);
  return (priceUpper - priceLower) / priceLower;
}

/**
 * Calculate ticks for a given price range (generic version)
 * @param currentPrice Current price of base token in quote token units
 * @param rangePercent Range percentage (e.g., 0.1 for ±10%)
 * @param tickSpacing Pool tick spacing
 * @param token0Decimals Decimals of token0
 * @param token1Decimals Decimals of token1
 * @param baseIsToken0 Whether base token is token0
 * @returns Object with tickLower and tickUpper
 */
export function calculateTickRangeGeneric(
  currentPrice: number,
  rangePercent: number,
  tickSpacing: number,
  token0Decimals: number,
  token1Decimals: number,
  baseIsToken0: boolean
): { tickLower: number; tickUpper: number } {
  const priceLower = currentPrice * (1 - rangePercent);
  const priceUpper = currentPrice * (1 + rangePercent);

  const decimalDiff = token0Decimals - token1Decimals;
  const decimalMultiplier = Math.pow(10, decimalDiff);

  // Convert prices to pool prices
  let poolPriceLower: number;
  let poolPriceUpper: number;

  if (baseIsToken0) {
    // Pool price = quote/base * decimalMultiplier
    poolPriceLower = priceLower * decimalMultiplier;
    poolPriceUpper = priceUpper * decimalMultiplier;
  } else {
    // Pool price = 1/base_price * decimalMultiplier (inverted)
    poolPriceLower = decimalMultiplier / priceUpper; // Note: inverted
    poolPriceUpper = decimalMultiplier / priceLower;
  }

  // Convert pool prices to ticks
  // tick = log(poolPrice) / log(1.0001)
  const tickLowerRaw = Math.log(poolPriceLower) / Math.log(1.0001);
  const tickUpperRaw = Math.log(poolPriceUpper) / Math.log(1.0001);

  // Round to tick spacing
  const tickLower = Math.floor(tickLowerRaw / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil(tickUpperRaw / tickSpacing) * tickSpacing;

  return { tickLower, tickUpper };
}

/**
 * Calculate ticks for a given price range (ETH/USDC backward compatible)
 * @deprecated Use calculateTickRangeGeneric for new code
 * @param currentPrice Current ETH price
 * @param rangePercent Range percentage (e.g., 0.1 for ±10%)
 * @param tickSpacing Pool tick spacing
 * @returns Object with tickLower and tickUpper
 */
export function calculateTickRange(
  currentPrice: number,
  rangePercent: number,
  tickSpacing: number
): { tickLower: number; tickUpper: number } {
  // WETH: 18 decimals, USDC: 6 decimals, WETH is token0
  return calculateTickRangeGeneric(currentPrice, rangePercent, tickSpacing, 18, 6, true);
}

/**
 * Format a BigInt value with decimals for display
 * @param value The value to format
 * @param decimals Number of decimals
 * @returns Formatted string
 */
export function formatUnits(value: bigint, decimals: number): string {
  const divisor = BigInt(10) ** BigInt(decimals);
  const integerPart = value / divisor;
  const fractionalPart = value % divisor;

  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
  return `${integerPart}.${fractionalStr}`;
}

/**
 * Parse a string value to BigInt with decimals
 * @param value The value to parse
 * @param decimals Number of decimals
 * @returns BigInt value
 */
export function parseUnits(value: string, decimals: number): bigint {
  const [integerPart, fractionalPart = ""] = value.split(".");
  const fractionalPadded = fractionalPart.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(integerPart + fractionalPadded);
}

// =============================================================================
// Market-aware helper functions
// =============================================================================

/**
 * Get token decimals for a market configuration
 */
export function getMarketDecimals(market: MarketTestConfig): {
  token0Decimals: number;
  token1Decimals: number;
} {
  if (market.baseTokenIsToken0) {
    return {
      token0Decimals: market.baseToken.decimals,
      token1Decimals: market.quoteToken.decimals,
    };
  } else {
    return {
      token0Decimals: market.quoteToken.decimals,
      token1Decimals: market.baseToken.decimals,
    };
  }
}

/**
 * Convert price to sqrtPriceX96 using a market configuration
 */
export function priceToSqrtPriceX96ForMarket(price: number, market: MarketTestConfig): bigint {
  const { token0Decimals, token1Decimals } = getMarketDecimals(market);
  return priceToSqrtPriceX96Generic(
    price,
    token0Decimals,
    token1Decimals,
    market.baseTokenIsToken0
  );
}

/**
 * Convert sqrtPriceX96 to price using a market configuration
 */
export function sqrtPriceX96ToPriceForMarket(
  sqrtPriceX96: bigint,
  market: MarketTestConfig
): number {
  const { token0Decimals, token1Decimals } = getMarketDecimals(market);
  return sqrtPriceX96ToPriceGeneric(
    sqrtPriceX96,
    token0Decimals,
    token1Decimals,
    market.baseTokenIsToken0
  );
}

/**
 * Calculate tick range using a market configuration
 */
export function calculateTickRangeForMarket(
  currentPrice: number,
  rangePercent: number,
  tickSpacing: number,
  market: MarketTestConfig
): { tickLower: number; tickUpper: number } {
  const { token0Decimals, token1Decimals } = getMarketDecimals(market);
  return calculateTickRangeGeneric(
    currentPrice,
    rangePercent,
    tickSpacing,
    token0Decimals,
    token1Decimals,
    market.baseTokenIsToken0
  );
}

/**
 * Get the current test market from environment or default to ETH
 */
export function getTestMarket(): MarketTestConfig {
  const marketId = process.env.TEST_MARKET || "ETH";
  const market = MARKET_CONFIGS[marketId.toUpperCase()];
  if (!market) {
    throw new Error(
      `Unknown test market: ${marketId}. Available: ${Object.keys(MARKET_CONFIGS).join(", ")}`
    );
  }
  return market;
}
