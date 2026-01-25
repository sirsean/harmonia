/**
 * Strategy Configuration Parameters
 *
 * This module centralizes all strategy parameters for the delta-neutral
 * yield strategy, including thresholds, intervals, limits, and tolerances.
 */

/**
 * Precision constants used throughout the system
 */
export const PRECISION = {
  /** Standard precision (18 decimals) for percentages and ratios */
  STANDARD: BigInt(10 ** 18),
  /** GMX USD precision (30 decimals) */
  GMX_USD: BigInt(10 ** 30),
  /** Uniswap price precision (Q96 format) */
  Q96: BigInt(2) ** BigInt(96),
};

/**
 * Token decimal constants
 */
export const DECIMALS = {
  USDC: 6,
  WETH: 18,
  CHAINLINK: 8,
  GMX_PRICE: 12,
};

/**
 * Default strategy parameters
 */
export interface StrategyConfig {
  // Delta thresholds
  /** Delta drift threshold to trigger rebalance (as decimal, e.g., 0.05 = 5%) */
  deltaThreshold: number;
  /** Emergency delta drift threshold (as decimal, e.g., 0.20 = 20%) */
  emergencyThreshold: number;

  // Timing intervals (in seconds)
  /** Minimum time between rebalances */
  minRebalanceInterval: number;
  /** Maximum time between forced rebalances */
  maxRebalanceInterval: number;
  /** Minimum time between compound operations */
  minCompoundInterval: number;
  /** Minimum time between range adjustments */
  minRangeAdjustmentInterval: number;

  // Position limits
  /** Maximum leverage for GMX positions (as multiplier, e.g., 3.0 = 3x) */
  maxLeverage: number;
  /** Minimum position size in USD (30 decimals) */
  minPositionSizeUsd: bigint;
  /** Maximum total position size in USD (30 decimals) - includes LP + GMX collateral */
  maxPositionSizeUsd: bigint;

  // Slippage and fees
  /** Maximum acceptable slippage (as decimal, e.g., 0.01 = 1%) */
  maxSlippage: number;
  /** Slippage buffer for rebalancing (as decimal, e.g., 0.005 = 0.5%) */
  slippageBuffer: number;
  /** Minimum fee threshold in USD to trigger compound (30 decimals) */
  minFeeThresholdUsd: bigint;
  /** Default execution fee for GMX orders (in ETH, 18 decimals) */
  defaultExecutionFee: bigint;

  // Range adjustment parameters
  /** Range adjustment threshold - adjust if within this % of range edge (as decimal, e.g., 0.02 = 2%) */
  rangeAdjustmentThreshold: number;
  /** Range center drift threshold - adjust if price drifted > this % from center (as decimal, e.g., 0.05 = 5%) */
  rangeCenterDriftThreshold: number;

  // Range size parameters
  /** Default range width (as decimal, e.g., 0.15 = 15% total width = ±7.5% on each side) */
  defaultRangeWidth: number;
  /** Minimum range width (as decimal, e.g., 0.1 = 10% minimum = ±5%) */
  minRangeWidth: number;
  /** Maximum range width (as decimal, e.g., 0.4 = 40% maximum = ±20%) */
  maxRangeWidth: number;

  // Rebalancing parameters
  /** Target leverage for GMX positions (as multiplier, e.g., 3.0 = 3x) */
  targetLeverage: number;
}

/**
 * Default strategy configuration values
 */
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  // Delta thresholds
  deltaThreshold: 0.05, // 5%
  emergencyThreshold: 0.2, // 20%

  // Timing intervals
  minRebalanceInterval: 3600, // 1 hour
  maxRebalanceInterval: 86400, // 24 hours
  minCompoundInterval: 86400, // 24 hours
  minRangeAdjustmentInterval: 3600, // 1 hour

  // Position limits
  maxLeverage: 3.0, // 3x
  minPositionSizeUsd: BigInt(100) * PRECISION.GMX_USD, // $100 in 30 decimals
  maxPositionSizeUsd: BigInt(500) * PRECISION.GMX_USD, // $500 default max (30 decimals)

  // Slippage and fees
  maxSlippage: 0.01, // 1%
  slippageBuffer: 0.005, // 0.5%
  minFeeThresholdUsd: BigInt(10) * PRECISION.GMX_USD, // $10 in 30 decimals
  defaultExecutionFee: BigInt("1000000000000000"), // 0.001 ETH

  // Range adjustment parameters
  rangeAdjustmentThreshold: 0.02, // 2%
  rangeCenterDriftThreshold: 0.05, // 5%

  // Range size parameters
  defaultRangeWidth: 0.15, // 15% total width (±7.5% on each side) - optimized for balanced yield vs operational costs
  minRangeWidth: 0.1, // 10% minimum (±5%)
  maxRangeWidth: 0.4, // 40% maximum (±20%)

  // Rebalancing parameters
  targetLeverage: 3.0, // 3x
};

/**
 * Load strategy configuration with environment variable overrides
 */
export function loadStrategyConfig(overrides?: Partial<StrategyConfig>): StrategyConfig {
  const config = { ...DEFAULT_STRATEGY_CONFIG };

  // Apply environment variable overrides
  if (process.env.DELTA_THRESHOLD) {
    config.deltaThreshold = parseFloat(process.env.DELTA_THRESHOLD);
  }
  if (process.env.EMERGENCY_THRESHOLD) {
    config.emergencyThreshold = parseFloat(process.env.EMERGENCY_THRESHOLD);
  }
  if (process.env.MIN_REBALANCE_INTERVAL) {
    config.minRebalanceInterval = parseInt(process.env.MIN_REBALANCE_INTERVAL, 10);
  }
  if (process.env.MAX_REBALANCE_INTERVAL) {
    config.maxRebalanceInterval = parseInt(process.env.MAX_REBALANCE_INTERVAL, 10);
  }
  if (process.env.MIN_COMPOUND_INTERVAL) {
    config.minCompoundInterval = parseInt(process.env.MIN_COMPOUND_INTERVAL, 10);
  }
  if (process.env.MIN_RANGE_ADJUSTMENT_INTERVAL) {
    config.minRangeAdjustmentInterval = parseInt(process.env.MIN_RANGE_ADJUSTMENT_INTERVAL, 10);
  }
  if (process.env.MAX_LEVERAGE) {
    config.maxLeverage = parseFloat(process.env.MAX_LEVERAGE);
  }
  if (process.env.MIN_POSITION_SIZE_USD) {
    const minSize = parseFloat(process.env.MIN_POSITION_SIZE_USD);
    config.minPositionSizeUsd = BigInt(Math.floor(minSize)) * PRECISION.GMX_USD;
  }
  if (process.env.MAX_POSITION_SIZE_USD) {
    const maxSize = parseFloat(process.env.MAX_POSITION_SIZE_USD);
    config.maxPositionSizeUsd = BigInt(Math.floor(maxSize)) * PRECISION.GMX_USD;
  }
  if (process.env.MAX_SLIPPAGE) {
    config.maxSlippage = parseFloat(process.env.MAX_SLIPPAGE);
  }
  if (process.env.SLIPPAGE_BUFFER) {
    config.slippageBuffer = parseFloat(process.env.SLIPPAGE_BUFFER);
  }
  if (process.env.MIN_FEE_THRESHOLD_USD) {
    const minFee = parseFloat(process.env.MIN_FEE_THRESHOLD_USD);
    config.minFeeThresholdUsd =
      (BigInt(Math.floor(minFee * 1e6)) * PRECISION.GMX_USD) / BigInt(10 ** 6);
  }
  if (process.env.DEFAULT_EXECUTION_FEE) {
    config.defaultExecutionFee = BigInt(process.env.DEFAULT_EXECUTION_FEE);
  }
  if (process.env.RANGE_ADJUSTMENT_THRESHOLD) {
    config.rangeAdjustmentThreshold = parseFloat(process.env.RANGE_ADJUSTMENT_THRESHOLD);
  }
  if (process.env.RANGE_CENTER_DRIFT_THRESHOLD) {
    config.rangeCenterDriftThreshold = parseFloat(process.env.RANGE_CENTER_DRIFT_THRESHOLD);
  }
  if (process.env.DEFAULT_RANGE_WIDTH) {
    config.defaultRangeWidth = parseFloat(process.env.DEFAULT_RANGE_WIDTH);
  }
  if (process.env.MIN_RANGE_WIDTH) {
    config.minRangeWidth = parseFloat(process.env.MIN_RANGE_WIDTH);
  }
  if (process.env.MAX_RANGE_WIDTH) {
    config.maxRangeWidth = parseFloat(process.env.MAX_RANGE_WIDTH);
  }
  if (process.env.TARGET_LEVERAGE) {
    config.targetLeverage = parseFloat(process.env.TARGET_LEVERAGE);
  }

  // Apply programmatic overrides
  if (overrides) {
    Object.assign(config, overrides);
  }

  return config;
}

/**
 * Validate strategy configuration
 * @throws Error if configuration is invalid
 */
export function validateStrategyConfig(config: StrategyConfig): void {
  // Validate thresholds
  if (config.deltaThreshold <= 0 || config.deltaThreshold >= 1) {
    throw new Error(`deltaThreshold must be between 0 and 1, got ${config.deltaThreshold}`);
  }
  if (config.emergencyThreshold <= 0 || config.emergencyThreshold >= 1) {
    throw new Error(`emergencyThreshold must be between 0 and 1, got ${config.emergencyThreshold}`);
  }
  if (config.emergencyThreshold <= config.deltaThreshold) {
    throw new Error(
      `emergencyThreshold (${config.emergencyThreshold}) must be greater than deltaThreshold (${config.deltaThreshold})`
    );
  }

  // Validate intervals
  if (config.minRebalanceInterval <= 0) {
    throw new Error(`minRebalanceInterval must be positive, got ${config.minRebalanceInterval}`);
  }
  if (config.maxRebalanceInterval <= config.minRebalanceInterval) {
    throw new Error(
      `maxRebalanceInterval (${config.maxRebalanceInterval}) must be greater than minRebalanceInterval (${config.minRebalanceInterval})`
    );
  }
  if (config.minCompoundInterval <= 0) {
    throw new Error(`minCompoundInterval must be positive, got ${config.minCompoundInterval}`);
  }
  if (config.minRangeAdjustmentInterval <= 0) {
    throw new Error(
      `minRangeAdjustmentInterval must be positive, got ${config.minRangeAdjustmentInterval}`
    );
  }

  // Validate leverage
  if (config.maxLeverage <= 0 || config.maxLeverage > 50) {
    throw new Error(`maxLeverage must be between 0 and 50, got ${config.maxLeverage}`);
  }
  if (config.targetLeverage <= 0 || config.targetLeverage > config.maxLeverage) {
    throw new Error(
      `targetLeverage (${config.targetLeverage}) must be between 0 and maxLeverage (${config.maxLeverage})`
    );
  }

  // Validate slippage
  if (config.maxSlippage <= 0 || config.maxSlippage >= 1) {
    throw new Error(`maxSlippage must be between 0 and 1, got ${config.maxSlippage}`);
  }
  if (config.slippageBuffer < 0 || config.slippageBuffer >= 1) {
    throw new Error(`slippageBuffer must be between 0 and 1, got ${config.slippageBuffer}`);
  }

  // Validate range parameters
  if (config.rangeAdjustmentThreshold <= 0 || config.rangeAdjustmentThreshold >= 1) {
    throw new Error(
      `rangeAdjustmentThreshold must be between 0 and 1, got ${config.rangeAdjustmentThreshold}`
    );
  }
  if (config.rangeCenterDriftThreshold <= 0 || config.rangeCenterDriftThreshold >= 1) {
    throw new Error(
      `rangeCenterDriftThreshold must be between 0 and 1, got ${config.rangeCenterDriftThreshold}`
    );
  }
  if (config.defaultRangeWidth <= 0 || config.defaultRangeWidth >= 1) {
    throw new Error(`defaultRangeWidth must be between 0 and 1, got ${config.defaultRangeWidth}`);
  }
  if (config.minRangeWidth <= 0 || config.minRangeWidth >= config.defaultRangeWidth) {
    throw new Error(
      `minRangeWidth (${config.minRangeWidth}) must be positive and less than defaultRangeWidth (${config.defaultRangeWidth})`
    );
  }
  if (config.maxRangeWidth <= config.defaultRangeWidth) {
    throw new Error(
      `maxRangeWidth (${config.maxRangeWidth}) must be greater than defaultRangeWidth (${config.defaultRangeWidth})`
    );
  }

  // Validate bigint values
  if (config.minPositionSizeUsd <= 0n) {
    throw new Error(`minPositionSizeUsd must be positive, got ${config.minPositionSizeUsd}`);
  }
  if (config.maxPositionSizeUsd <= 0n) {
    throw new Error(`maxPositionSizeUsd must be positive, got ${config.maxPositionSizeUsd}`);
  }
  if (config.maxPositionSizeUsd < config.minPositionSizeUsd) {
    throw new Error(
      `maxPositionSizeUsd (${config.maxPositionSizeUsd}) must be >= minPositionSizeUsd (${config.minPositionSizeUsd})`
    );
  }
  if (config.minFeeThresholdUsd <= 0n) {
    throw new Error(`minFeeThresholdUsd must be positive, got ${config.minFeeThresholdUsd}`);
  }
  if (config.defaultExecutionFee <= 0n) {
    throw new Error(`defaultExecutionFee must be positive, got ${config.defaultExecutionFee}`);
  }
}
