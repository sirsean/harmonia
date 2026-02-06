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
  /** Delta drift threshold to trigger optimization (as decimal, e.g., 0.10 = 10%) */
  optimizationDeltaThreshold: number;
  /** Emergency delta drift threshold - always optimize (as decimal, e.g., 0.20 = 20%) */
  emergencyDeltaThreshold: number;

  // Timing intervals (in seconds)
  /** Minimum time between optimizations */
  minOptimizationInterval: number;
  /** Maximum time between forced optimizations (even if conditions aren't ideal) */
  maxOptimizationInterval: number;

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
  /** Minimum fee threshold in USD to make optimization worthwhile (30 decimals) */
  minOptimizationFeeThresholdUsd: bigint;
  /** Default execution fee for GMX orders (in ETH, 18 decimals) */
  defaultExecutionFee: bigint;
  /** Estimated gas cost for optimization in USD (30 decimals) - used for cost/benefit analysis */
  estimatedOptimizationGasCostUsd: bigint;

  // Range adjustment parameters (used by optimization)
  /** Range adjustment threshold - optimize if within this % of range edge (as decimal, e.g., 0.02 = 2%) */
  rangeAdjustmentThreshold: number;
  /** Range center drift threshold - optimize if price drifted > this % from center (as decimal, e.g., 0.05 = 5%) */
  rangeCenterDriftThreshold: number;

  // Range size parameters
  /** Default range width (as decimal, e.g., 0.15 = 15% total width = ±7.5% on each side) */
  defaultRangeWidth: number;
  /** Minimum range width (as decimal, e.g., 0.1 = 10% minimum = ±5%) */
  minRangeWidth: number;
  /** Maximum range width (as decimal, e.g., 0.4 = 40% maximum = ±20%) */
  maxRangeWidth: number;

  // Optimization parameters
  /** Target leverage for GMX positions (as multiplier, e.g., 3.0 = 3x) */
  targetLeverage: number;
  /** Minimum benefit/cost ratio to optimize (e.g., 2.0 = benefit must be 2x the cost) */
  minOptimizationBenefitRatio: number;

  // Hedge adjustment parameters
  /** Delta drift threshold to trigger hedge adjustment (as decimal, e.g., 0.05 = 5%) */
  hedgeDeltaThreshold: number;
  /** Minimum time between hedge adjustments in seconds */
  minHedgeInterval: number;
  /** Minimum hedge adjustment size in USD (30 decimals) to avoid dust orders */
  minHedgeAdjustmentUsd: bigint;
  /** Maximum leverage allowed after a hedge adjustment (safety guard) */
  maxHedgeLeverage: number;
}

/**
 * Default strategy configuration values
 */
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  // Delta thresholds
  optimizationDeltaThreshold: 0.1, // 10% - higher threshold to avoid being too eager
  emergencyDeltaThreshold: 0.2, // 20%

  // Timing intervals
  minOptimizationInterval: 3600, // 1 hour - minimum time between optimizations
  maxOptimizationInterval: 86400, // 24 hours - force optimization even if conditions aren't ideal

  // Position limits
  maxLeverage: 3.0, // 3x
  minPositionSizeUsd: BigInt(100) * PRECISION.GMX_USD, // $100 in 30 decimals
  maxPositionSizeUsd: BigInt(500) * PRECISION.GMX_USD, // $500 default max (30 decimals)

  // Slippage and fees
  maxSlippage: 0.01, // 1%
  slippageBuffer: 0.005, // 0.5%
  minOptimizationFeeThresholdUsd: BigInt(5) * PRECISION.GMX_USD, // $5 in 30 decimals - lower threshold since we compound during optimization
  defaultExecutionFee: BigInt("1000000000000000"), // 0.001 ETH
  estimatedOptimizationGasCostUsd: BigInt(2) * PRECISION.GMX_USD, // ~$2 in gas costs (30 decimals)

  // Range adjustment parameters
  rangeAdjustmentThreshold: 0.15, // Trigger when price is within 15% of range span from either edge
  rangeCenterDriftThreshold: 0.02, // Trigger when price drifts 2% from center (proactive for 6% width)

  // Range size parameters
  defaultRangeWidth: 0.06, // 6% total width (±3% on each side) - tighter range for higher capital efficiency
  minRangeWidth: 0.04, // 4% minimum (±2%)
  maxRangeWidth: 0.4, // 40% maximum (±20%)

  // Optimization parameters
  targetLeverage: 3.0, // 3x
  minOptimizationBenefitRatio: 1.5, // Benefit must be at least 1.5x the cost

  // Hedge adjustment parameters
  hedgeDeltaThreshold: 0.05, // 5% - lighter threshold for hedge adjustments
  minHedgeInterval: 300, // 5 minutes between hedge adjustments
  minHedgeAdjustmentUsd: BigInt(5) * PRECISION.GMX_USD, // $5 minimum to avoid dust orders
  maxHedgeLeverage: 10.0, // Safety guard - skip hedge if leverage would exceed 10x
};

/**
 * Load strategy configuration with environment variable overrides
 */
export function loadStrategyConfig(overrides?: Partial<StrategyConfig>): StrategyConfig {
  const config = { ...DEFAULT_STRATEGY_CONFIG };

  // Apply environment variable overrides
  if (process.env.OPTIMIZATION_DELTA_THRESHOLD) {
    config.optimizationDeltaThreshold = parseFloat(process.env.OPTIMIZATION_DELTA_THRESHOLD);
  }
  if (process.env.EMERGENCY_DELTA_THRESHOLD) {
    config.emergencyDeltaThreshold = parseFloat(process.env.EMERGENCY_DELTA_THRESHOLD);
  }
  if (process.env.MIN_OPTIMIZATION_INTERVAL) {
    config.minOptimizationInterval = parseInt(process.env.MIN_OPTIMIZATION_INTERVAL, 10);
  }
  if (process.env.MAX_OPTIMIZATION_INTERVAL) {
    config.maxOptimizationInterval = parseInt(process.env.MAX_OPTIMIZATION_INTERVAL, 10);
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
  if (process.env.MIN_OPTIMIZATION_FEE_THRESHOLD_USD) {
    const minFee = parseFloat(process.env.MIN_OPTIMIZATION_FEE_THRESHOLD_USD);
    config.minOptimizationFeeThresholdUsd =
      (BigInt(Math.floor(minFee * 1e6)) * PRECISION.GMX_USD) / BigInt(10 ** 6);
  }
  if (process.env.ESTIMATED_OPTIMIZATION_GAS_COST_USD) {
    const gasCost = parseFloat(process.env.ESTIMATED_OPTIMIZATION_GAS_COST_USD);
    config.estimatedOptimizationGasCostUsd =
      (BigInt(Math.floor(gasCost * 1e6)) * PRECISION.GMX_USD) / BigInt(10 ** 6);
  }
  if (process.env.MIN_OPTIMIZATION_BENEFIT_RATIO) {
    config.minOptimizationBenefitRatio = parseFloat(process.env.MIN_OPTIMIZATION_BENEFIT_RATIO);
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
  if (process.env.HEDGE_DELTA_THRESHOLD) {
    config.hedgeDeltaThreshold = parseFloat(process.env.HEDGE_DELTA_THRESHOLD);
  }
  if (process.env.MIN_HEDGE_INTERVAL) {
    config.minHedgeInterval = parseInt(process.env.MIN_HEDGE_INTERVAL, 10);
  }
  if (process.env.MIN_HEDGE_ADJUSTMENT_USD) {
    const minHedge = parseFloat(process.env.MIN_HEDGE_ADJUSTMENT_USD);
    config.minHedgeAdjustmentUsd =
      (BigInt(Math.floor(minHedge * 1e6)) * PRECISION.GMX_USD) / BigInt(10 ** 6);
  }
  if (process.env.MAX_HEDGE_LEVERAGE) {
    config.maxHedgeLeverage = parseFloat(process.env.MAX_HEDGE_LEVERAGE);
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
  if (config.optimizationDeltaThreshold <= 0 || config.optimizationDeltaThreshold >= 1) {
    throw new Error(
      `optimizationDeltaThreshold must be between 0 and 1, got ${config.optimizationDeltaThreshold}`
    );
  }
  if (config.emergencyDeltaThreshold <= 0 || config.emergencyDeltaThreshold >= 1) {
    throw new Error(
      `emergencyDeltaThreshold must be between 0 and 1, got ${config.emergencyDeltaThreshold}`
    );
  }
  if (config.emergencyDeltaThreshold <= config.optimizationDeltaThreshold) {
    throw new Error(
      `emergencyDeltaThreshold (${config.emergencyDeltaThreshold}) must be greater than optimizationDeltaThreshold (${config.optimizationDeltaThreshold})`
    );
  }

  // Validate intervals
  if (config.minOptimizationInterval <= 0) {
    throw new Error(
      `minOptimizationInterval must be positive, got ${config.minOptimizationInterval}`
    );
  }
  if (config.maxOptimizationInterval <= config.minOptimizationInterval) {
    throw new Error(
      `maxOptimizationInterval (${config.maxOptimizationInterval}) must be greater than minOptimizationInterval (${config.minOptimizationInterval})`
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
  if (config.rangeAdjustmentThreshold >= 0.5) {
    throw new Error(
      `rangeAdjustmentThreshold (${config.rangeAdjustmentThreshold}) must be less than 0.5 (distance-to-edge ratio)`
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
  if (config.maxRangeWidth >= 1) {
    throw new Error(`maxRangeWidth must be less than 1, got ${config.maxRangeWidth}`);
  }
  if (config.rangeCenterDriftThreshold >= config.defaultRangeWidth / 2) {
    throw new Error(
      `rangeCenterDriftThreshold (${config.rangeCenterDriftThreshold}) must be less than half of defaultRangeWidth (${config.defaultRangeWidth / 2})`
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
  if (config.minOptimizationFeeThresholdUsd <= 0n) {
    throw new Error(
      `minOptimizationFeeThresholdUsd must be positive, got ${config.minOptimizationFeeThresholdUsd}`
    );
  }
  if (config.estimatedOptimizationGasCostUsd <= 0n) {
    throw new Error(
      `estimatedOptimizationGasCostUsd must be positive, got ${config.estimatedOptimizationGasCostUsd}`
    );
  }
  if (config.minOptimizationBenefitRatio <= 0) {
    throw new Error(
      `minOptimizationBenefitRatio must be positive, got ${config.minOptimizationBenefitRatio}`
    );
  }
  if (config.defaultExecutionFee <= 0n) {
    throw new Error(`defaultExecutionFee must be positive, got ${config.defaultExecutionFee}`);
  }

  // Validate hedge parameters
  if (config.hedgeDeltaThreshold <= 0 || config.hedgeDeltaThreshold >= 1) {
    throw new Error(
      `hedgeDeltaThreshold must be between 0 and 1, got ${config.hedgeDeltaThreshold}`
    );
  }
  if (config.hedgeDeltaThreshold >= config.optimizationDeltaThreshold) {
    throw new Error(
      `hedgeDeltaThreshold (${config.hedgeDeltaThreshold}) must be less than optimizationDeltaThreshold (${config.optimizationDeltaThreshold})`
    );
  }
  if (config.minHedgeInterval <= 0) {
    throw new Error(`minHedgeInterval must be positive, got ${config.minHedgeInterval}`);
  }
  if (config.minHedgeInterval >= config.minOptimizationInterval) {
    throw new Error(
      `minHedgeInterval (${config.minHedgeInterval}) must be less than minOptimizationInterval (${config.minOptimizationInterval})`
    );
  }
  if (config.minHedgeAdjustmentUsd <= 0n) {
    throw new Error(`minHedgeAdjustmentUsd must be positive, got ${config.minHedgeAdjustmentUsd}`);
  }
  if (config.maxHedgeLeverage <= config.targetLeverage) {
    throw new Error(
      `maxHedgeLeverage (${config.maxHedgeLeverage}) must be greater than targetLeverage (${config.targetLeverage})`
    );
  }
}
