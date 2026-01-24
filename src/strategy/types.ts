import { DeltaResult } from "../modules/math/delta";

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

export interface MonitorConfig {
  deltaThreshold: number; // e.g. 0.05 for 5%
  minFeeThresholdUsd: bigint; // USD value (30 decimals)
  minRebalanceInterval: number;
  // Range adjustment configuration
  rangeAdjustmentThreshold: number; // e.g. 0.02 for 2% - adjust if within this % of range edge
  rangeCenterDriftThreshold: number; // e.g. 0.05 for 5% - adjust if price drifted > this % from center
  minRangeAdjustmentInterval: number; // Minimum seconds between range adjustments
}

export interface StrategyMonitor {
  check(): Promise<{ status: StrategyStatus; recommendation: Recommendation }>;
}
