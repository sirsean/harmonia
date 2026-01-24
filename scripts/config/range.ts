/**
 * Range Configuration for Uniswap v3 LP Positions
 *
 * @deprecated This file is kept for backward compatibility.
 * Please use the new configuration system from src/config/ instead.
 *
 * This file re-exports from the centralized config module.
 */

import { DEFAULT_STRATEGY_CONFIG } from "../../src/config/strategy";
import {
  getDefaultRangeBounds as getDefaultRangeBoundsFromMarkets,
  validateRangeWidth as validateRangeWidthFromMarkets,
} from "../../src/config/markets";

/**
 * Range size configuration (backward compatibility)
 * @deprecated Use StrategyConfig from src/config/strategy instead
 */
export const RANGE_CONFIG = {
  // Default range width (as decimal, e.g., 0.2 = 20% total width = ±10% on each side)
  DEFAULT_RANGE_WIDTH: DEFAULT_STRATEGY_CONFIG.defaultRangeWidth,

  // Range size limits
  MIN_RANGE_WIDTH: DEFAULT_STRATEGY_CONFIG.minRangeWidth,
  MAX_RANGE_WIDTH: DEFAULT_STRATEGY_CONFIG.maxRangeWidth,

  // Range adjustment thresholds
  RANGE_ADJUSTMENT_THRESHOLD: DEFAULT_STRATEGY_CONFIG.rangeAdjustmentThreshold,
  RANGE_CENTER_DRIFT_THRESHOLD: DEFAULT_STRATEGY_CONFIG.rangeCenterDriftThreshold,
  MIN_RANGE_ADJUSTMENT_INTERVAL: DEFAULT_STRATEGY_CONFIG.minRangeAdjustmentInterval,
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
  return getDefaultRangeBoundsFromMarkets(currentPrice, rangeWidth);
}

/**
 * Validate range width is within acceptable bounds
 * @param rangeWidth Range width to validate
 * @returns true if valid, throws error if invalid
 */
export function validateRangeWidth(rangeWidth: number): boolean {
  return validateRangeWidthFromMarkets(
    rangeWidth,
    RANGE_CONFIG.MIN_RANGE_WIDTH,
    RANGE_CONFIG.MAX_RANGE_WIDTH
  );
}
