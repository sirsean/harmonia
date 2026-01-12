// Test constants and utilities for Harmonia tests

export const Q96 = BigInt(2) ** BigInt(96);
export const PRECISION = BigInt(10) ** BigInt(18);

// Arbitrum contract addresses
export const ADDRESSES = {
  // Uniswap V3
  UNISWAP_V3_FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  UNISWAP_V3_POSITION_MANAGER: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  UNISWAP_V3_SWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_V3_ETH_USDC_005_POOL: "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443",

  // GMX V2
  GMX_EXCHANGE_ROUTER: "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8",
  GMX_ORDER_VAULT: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  GMX_DATA_STORE: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
  GMX_ETH_USD_MARKET: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",

  // Chainlink
  CHAINLINK_ETH_USD_FEED: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  CHAINLINK_AUTOMATION_REGISTRY: "0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1",

  // Tokens
  USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
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
 * Convert price to sqrtPriceX96 for ETH/USDC pool
 * Assumes WETH is token0 (18 decimals) and USDC is token1 (6 decimals)
 * @param priceUsdPerEth Price in USD per ETH
 * @param wethIsToken0 Whether WETH is token0 in the pool
 * @returns sqrtPriceX96 as bigint
 */
export function priceToSqrtPriceX96(priceUsdPerEth: number, wethIsToken0: boolean = true): bigint {
  // Pool price = token1/token0 with decimal adjustment
  // If WETH is token0: poolPrice = (USDC/10^6) / (WETH/10^18) = USDC_per_ETH * 10^12
  // sqrtPriceX96 = sqrt(poolPrice) * 2^96

  let poolPrice: number;
  if (wethIsToken0) {
    poolPrice = priceUsdPerEth * 1e12;
  } else {
    poolPrice = 1e12 / priceUsdPerEth;
  }

  const sqrtPrice = Math.sqrt(poolPrice);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

/**
 * Convert sqrtPriceX96 to human-readable ETH price
 * @param sqrtPriceX96 The sqrt price
 * @param wethIsToken0 Whether WETH is token0
 * @returns Price in USD per ETH
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, wethIsToken0: boolean = true): number {
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const poolPrice = sqrtPrice * sqrtPrice;

  if (wethIsToken0) {
    return poolPrice / 1e12;
  } else {
    return 1e12 / poolPrice;
  }
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
 * Calculate ticks for a given price range
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
  const priceLower = currentPrice * (1 - rangePercent);
  const priceUpper = currentPrice * (1 + rangePercent);

  // Convert prices to ticks (assuming WETH is token0)
  // tick = log(price * 10^12) / log(1.0001)
  const tickLowerRaw = Math.log(priceLower * 1e12) / Math.log(1.0001);
  const tickUpperRaw = Math.log(priceUpper * 1e12) / Math.log(1.0001);

  // Round to tick spacing
  const tickLower = Math.floor(tickLowerRaw / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil(tickUpperRaw / tickSpacing) * tickSpacing;

  return { tickLower, tickUpper };
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
