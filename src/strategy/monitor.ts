import { ethers } from "ethers";
import * as gmxReader from "../modules/gmx/reader";
import * as uniswapReader from "../modules/uniswap/reader";
import { calculateDelta, DeltaResult } from "../modules/math/delta";
import { getSqrtRatioAtTick } from "../modules/math/ticks";
import {
  MonitorConfig,
  Recommendation,
  StrategyAction,
  StrategyMonitor,
  StrategyStatus,
} from "./types";
import { GMXPosition } from "../modules/gmx/types";

export class DeltaNeutralMonitor implements StrategyMonitor {
  constructor(
    private provider: ethers.Provider,
    private config: MonitorConfig,
    private context: {
      uniswap: {
        positionManager: string;
        pool: string;
        tokenId: bigint;
      };
      gmx: {
        reader: string;
        dataStore: string;
        account: string;
        market: string;
        collateralToken: string;
      };
    }
  ) {}

  async check(): Promise<{ status: StrategyStatus; recommendation: Recommendation }> {
    const { uniswap, gmx } = this.context;

    // 1. Fetch Uniswap Data
    const poolContract = uniswapReader.createPool(uniswap.pool, this.provider);
    const pmContract = uniswapReader.createPositionManager(uniswap.positionManager, this.provider);

    const [poolState, position] = await Promise.all([
      uniswapReader.getPoolState(poolContract),
      uniswapReader.getPosition(pmContract, uniswap.tokenId),
    ]);

    // 2. Fetch GMX Data
    const gmxReaderContract = gmxReader.createReader(gmx.reader, this.provider);
    const gmxPosition = await gmxReader.getPosition(gmxReaderContract, gmx.dataStore, gmx.account, {
      market: gmx.market,
      collateralToken: gmx.collateralToken,
      isLong: false, // We assume short for hedging
    });

    // 3. Calculate Uniswap Delta
    const sqrtPaX96 = getSqrtRatioAtTick(position.tickLower);
    const sqrtPbX96 = getSqrtRatioAtTick(position.tickUpper);

    const lpDeltaResult: DeltaResult = calculateDelta(
      poolState.sqrtPriceX96,
      sqrtPaX96,
      sqrtPbX96,
      position.liquidity
    );

    // 4. Calculate GMX Delta
    // Short position delta is negative of the size in tokens
    const shortSizeTokens = gmxPosition ? gmxPosition.numbers.sizeInTokens : 0n;
    const gmxDelta = -shortSizeTokens;

    // 5. Calculate Net Delta and Drift
    const netDelta = lpDeltaResult.delta + gmxDelta;

    // Avoid division by zero if LP delta is 0
    let deltaDrift = 0;
    if (lpDeltaResult.delta !== 0n) {
      // drift = abs(netDelta) / lpDelta
      const absNetDelta = netDelta < 0n ? -netDelta : netDelta;
      // using number for ratio calculation (careful with precision loss, but acceptable for percentage check)
      deltaDrift = Number(absNetDelta) / Number(lpDeltaResult.delta);
    } else if (shortSizeTokens > 0n) {
      // If LP delta is 0 but we have a short, drift is effectively infinite/max
      deltaDrift = 1; // 100% drift relative to being "neutral" (which would be 0 short)
    }

    // 6. Check Fees
    // For Uniswap, fees are in tokensOwed0 and tokensOwed1
    // We might want to normalize to USD value, but for now let's just use raw amounts or checking if > 0
    const pendingFees0 = position.tokensOwed0;
    const pendingFees1 = position.tokensOwed1;

    // For GMX, checking claimable funding
    // Note: The reader returns 'numbers' which includes claimable funding per size.
    // However, exact claimable amount logic might be complex.
    // For now, we use what's available or 0 if position doesn't exist.
    const pendingFunding = gmxPosition
      ? gmxPosition.numbers.shortTokenClaimableFundingAmountPerSize
      : 0n;

    const status: StrategyStatus = {
      uniswap: {
        tokenId: uniswap.tokenId.toString(),
        liquidity: position.liquidity,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        currentTick: poolState.tick,
        sqrtPriceX96: poolState.sqrtPriceX96,
        unclaimedFees: {
          amount0: pendingFees0,
          amount1: pendingFees1,
        },
        delta: lpDeltaResult,
      },
      gmx: {
        positionSizeTokens: shortSizeTokens, // stored as positive int in struct
        pendingFundingRewards: pendingFunding,
        delta: gmxDelta,
      },
      netDelta,
      deltaDrift,
      timestamp: Date.now(),
    };

    const recommendation = this.generateRecommendation(status);

    return { status, recommendation };
  }

  private generateRecommendation(status: StrategyStatus): Recommendation {
    // 1. Check for Range Adjustment
    if (status.uniswap.delta.zone !== "in") {
      return {
        action: StrategyAction.ADJUST_RANGE,
        reason: `Price is ${status.uniswap.delta.zone} range. LP Delta is ${status.uniswap.delta.delta}`,
      };
    }

    // 2. Check for Rebalancing
    if (status.deltaDrift > this.config.deltaThreshold) {
      return {
        action: StrategyAction.REBALANCE,
        reason: `Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds threshold ${(this.config.deltaThreshold * 100).toFixed(2)}%`,
        data: {
          targetDelta: status.uniswap.delta.delta,
          currentHedge: -status.gmx.delta,
          adjustmentNeeded: status.netDelta, // If positive, we are long -> need to sell (increase short). If negative, we are short -> need to buy (decrease short).
        },
      };
    }

    // 3. Check for Compounding
    // Simple check: if fees > minFeeThreshold (simplified check on amount0 for now, ideally value in USD)
    if (
      status.uniswap.unclaimedFees.amount0 > this.config.minFeeThreshold ||
      status.uniswap.unclaimedFees.amount1 > this.config.minFeeThreshold
    ) {
      return {
        action: StrategyAction.COMPOUND,
        reason: "Unclaimed fees exceed threshold",
      };
    }

    return {
      action: StrategyAction.NONE,
      reason: "Strategy is healthy",
    };
  }
}
