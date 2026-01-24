import { DeltaResult } from "../modules/math/delta";
import { StrategyConfig } from "../config/strategy";

export enum StrategyAction {
  REBALANCE = "REBALANCE",
  COMPOUND = "COMPOUND",
  ADJUST_RANGE = "ADJUST_RANGE",
  NONE = "NONE",
}

export interface StrategyStatus {
  uniswap: {
    tokenId: string;
    liquidity: bigint;
    tickLower: number;
    tickUpper: number;
    currentTick: number;
    sqrtPriceX96: bigint;
    priceLower: number;
    priceUpper: number;
    currentPrice: number;
    priceLabel: string;
    unclaimedFees: {
      amount0: bigint;
      amount1: bigint;
    };
    delta: DeltaResult;
  }[];
  totalLpDelta: bigint;
  gmx: {
    positionSizeTokens: bigint; // Negative for short
    collateralAmount: bigint;
    netValueUsd: bigint;
    pendingFundingRewards: bigint; // This might need refinement based on available data
    delta: bigint; // Usually -size for short
  };
  netDelta: bigint;
  deltaDrift: number; // Percentage
  timestamp: number;
}

export interface RebalanceData {
  targetDelta: bigint;
  currentHedge: bigint;
  adjustmentNeeded: bigint;
  targetSizeUsd: bigint;
  adjustmentNeededUsd: bigint;
}

export interface Recommendation {
  action: StrategyAction;
  reason: string;
  data?: RebalanceData | any;
}

/**
 * MonitorConfig is a subset of StrategyConfig used by DeltaNeutralMonitor
 * This interface is kept for backward compatibility but should use StrategyConfig directly
 * @deprecated Use StrategyConfig from config/strategy instead
 */
export interface MonitorConfig {
  deltaThreshold: number; // e.g. 0.05 for 5%
  minFeeThresholdUsd: bigint; // USD value (30 decimals)
  minRebalanceInterval: number;
  // Range adjustment configuration
  rangeAdjustmentThreshold: number; // e.g. 0.02 for 2% - adjust if within this % of range edge
  rangeCenterDriftThreshold: number; // e.g. 0.05 for 5% - adjust if price drifted > this % from center
  minRangeAdjustmentInterval: number; // Minimum seconds between range adjustments
}

/**
 * Convert StrategyConfig to MonitorConfig for backward compatibility
 */
export function strategyConfigToMonitorConfig(config: StrategyConfig): MonitorConfig {
  return {
    deltaThreshold: config.deltaThreshold,
    minFeeThresholdUsd: config.minFeeThresholdUsd,
    minRebalanceInterval: config.minRebalanceInterval,
    rangeAdjustmentThreshold: config.rangeAdjustmentThreshold,
    rangeCenterDriftThreshold: config.rangeCenterDriftThreshold,
    minRangeAdjustmentInterval: config.minRangeAdjustmentInterval,
  };
}

export interface StrategyMonitor {
  check(): Promise<{ status: StrategyStatus; recommendation: Recommendation }>;
}
