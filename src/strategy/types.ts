import { DeltaResult } from "../modules/math/delta";

export enum StrategyAction {
  OPTIMIZE = "OPTIMIZE",
  HEDGE_ADJUST = "HEDGE_ADJUST",
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

export interface OptimizationData {
  /** Current delta drift percentage */
  deltaDrift: number;
  /** Whether any position is out of range */
  anyOutOfRange: boolean;
  /** Total unclaimed fees in USD (30 decimals) */
  totalFeesUsd: bigint;
  /** Time since last optimization in seconds (undefined if never optimized) */
  timeSinceLastOptimization?: number;
  /** Estimated gas cost in USD (30 decimals) */
  estimatedGasCostUsd?: bigint;
  /** Net benefit of optimizing (fees + delta correction value) in USD (30 decimals) */
  estimatedBenefitUsd?: bigint;
}

export interface RebalanceData {
  targetDelta: bigint;
  currentHedge: bigint;
  adjustmentNeeded: bigint;
  targetSizeUsd: bigint;
  adjustmentNeededUsd: bigint;
}

export interface HedgeAdjustmentData {
  /** Current GMX short size in tokens (18 decimals) */
  currentShortSizeTokens: bigint;
  /** Target GMX short size in tokens (should match LP delta) */
  targetShortSizeTokens: bigint;
  /** Adjustment size in USD (30 decimals), positive = increase short, negative = decrease */
  adjustmentSizeUsd: bigint;
  /** Current leverage of the GMX position */
  currentLeverage: number;
  /** Estimated leverage after hedge adjustment */
  estimatedLeverageAfter: number;
}

export interface Recommendation {
  action: StrategyAction;
  reason: string;
  data?: OptimizationData;
  hedgeData?: HedgeAdjustmentData;
}

export interface StrategyMonitor {
  check(): Promise<{ status: StrategyStatus; recommendation: Recommendation }>;
}
