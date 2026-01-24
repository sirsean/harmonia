/**
 * Range Configuration for Uniswap v3 LP Positions
 *
 * This file contains configuration parameters for managing Uniswap v3
 * concentrated liquidity position ranges in the delta-neutral strategy.
 */

/**
 * Range size configuration
 */
export const RANGE_CONFIG = {
  // Default range width (as decimal, e.g., 0.2 = 20% total width = ±10% on each side)
  DEFAULT_RANGE_WIDTH: 0.2, // 20% total width (±10% on each side)

  // Range size limits
  MIN_RANGE_WIDTH: 0.1, // 10% minimum (±5%)
  MAX_RANGE_WIDTH: 0.4, // 40% maximum (±20%)

  // Range adjustment thresholds
  RANGE_ADJUSTMENT_THRESHOLD: 0.02, // Adjust if within 2% of range edge
  RANGE_CENTER_DRIFT_THRESHOLD: 0.05, // Adjust if >5% from center
  MIN_RANGE_ADJUSTMENT_INTERVAL: 3600, // 1 hour minimum between adjustments (seconds)
};

/**
 * Get default range bounds for a given price
 * @param currentPrice Current price of the risk token
 * @param rangeWidth Optional range width (defaults to DEFAULT_RANGE_WIDTH)
 * @returns Object with lower and upper price bounds
 */
export function getDefaultRangeBounds(
  currentPrice: number,
  rangeWidth: number = RANGE_CONFIG.DEFAULT_RANGE_WIDTH
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
 * @returns true if valid, throws error if invalid
 */
export function validateRangeWidth(rangeWidth: number): boolean {
  if (rangeWidth < RANGE_CONFIG.MIN_RANGE_WIDTH) {
    throw new Error(`Range width ${rangeWidth} is below minimum ${RANGE_CONFIG.MIN_RANGE_WIDTH}`);
  }
  if (rangeWidth > RANGE_CONFIG.MAX_RANGE_WIDTH) {
    throw new Error(`Range width ${rangeWidth} is above maximum ${RANGE_CONFIG.MAX_RANGE_WIDTH}`);
  }
  return true;
}
