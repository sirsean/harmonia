/**
 * Market Configuration
 *
 * This module defines market-specific configurations including pool parameters,
 * GMX market settings, and token pair information.
 */

import { NetworkAddresses } from "./addresses";

/**
 * Market configuration for a trading pair
 */
export interface MarketConfig {
  /** Base token address (e.g., WETH) */
  baseToken: string;
  /** Quote/collateral token address (e.g., USDC) */
  quoteToken: string;
  /** Uniswap V3 pool address */
  uniswapPool: string;
  /** Uniswap V3 pool fee tier (in basis points, e.g., 500 = 0.05%) */
  uniswapFeeTier: number;
  /** GMX market address */
  gmxMarket: string;
  /** Chainlink price feed address */
  chainlinkFeed: string;
  /** Base token decimals */
  baseTokenDecimals: number;
  /** Quote token decimals */
  quoteTokenDecimals: number;
}

/**
 * Get market configuration for a network
 * @param addresses Network addresses
 * @returns Market configuration
 */
export function getMarketConfig(addresses: NetworkAddresses): MarketConfig {
  return {
    baseToken: addresses.weth,
    quoteToken: addresses.usdc,
    uniswapPool: addresses.uniswapV3EthUsdcPool,
    uniswapFeeTier: 500, // 0.05% fee tier
    gmxMarket: addresses.gmxEthUsdMarket,
    chainlinkFeed: addresses.chainlinkEthUsdFeed,
    baseTokenDecimals: 18, // WETH
    quoteTokenDecimals: 6, // USDC
  };
}

/**
 * Helper function to get default range bounds for a given price
 * @param currentPrice Current price of the base token
 * @param rangeWidth Range width (as decimal, e.g., 0.2 = 20% total width)
 * @returns Object with lower and upper price bounds
 */
export function getDefaultRangeBounds(
  currentPrice: number,
  rangeWidth: number = 0.2
): { lower: number; upper: number } {
  const halfWidth = rangeWidth / 2;
  return {
    lower: currentPrice * (1 - halfWidth),
    upper: currentPrice * (1 + halfWidth),
  };
}

/**
 * Validate range width is within acceptable bounds
 * @param rangeWidth Range width to validate
 * @param minWidth Minimum allowed width
 * @param maxWidth Maximum allowed width
 * @returns true if valid, throws error if invalid
 */
export function validateRangeWidth(
  rangeWidth: number,
  minWidth: number = 0.1,
  maxWidth: number = 0.4
): boolean {
  if (rangeWidth < minWidth) {
    throw new Error(`Range width ${rangeWidth} is below minimum ${minWidth}`);
  }
  if (rangeWidth > maxWidth) {
    throw new Error(`Range width ${rangeWidth} is above maximum ${maxWidth}`);
  }
  return true;
}
