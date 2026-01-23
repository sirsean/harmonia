import { ethers } from "ethers";
import * as gmxReader from "../modules/gmx/reader";
import * as uniswapReader from "../modules/uniswap/reader";
import { calculateDelta, DeltaResult } from "../modules/math/delta";
import { getSqrtRatioAtTick, sqrtPriceX96ToPrice } from "../modules/math/ticks";
import {
  MonitorConfig,
  Recommendation,
  StrategyAction,
  StrategyMonitor,
  StrategyStatus,
  RebalanceData,
} from "./types";
import { GMXPosition } from "../modules/gmx/types";
import { UniswapPosition } from "../modules/uniswap/types";

const ERC20_ABI = ["function decimals() view returns (uint8)"];

export class DeltaNeutralMonitor implements StrategyMonitor {
  constructor(
    private provider: ethers.Provider,
    private config: MonitorConfig,
    private context: {
      uniswap: {
        positionManager: string;
        pool: string;
        tokenIds?: bigint[];
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

    // 1. Fetch Uniswap Data for ALL positions
    const poolContract = uniswapReader.createPool(uniswap.pool, this.provider);
    const pmContract = uniswapReader.createPositionManager(uniswap.positionManager, this.provider);

    // Determine which positions to monitor
    let positionsToMonitor: { tokenId: bigint; position: UniswapPosition }[] = [];

    if (uniswap.tokenIds && uniswap.tokenIds.length > 0) {
      // Fetch specific positions
      for (const id of uniswap.tokenIds) {
        const position = await uniswapReader.getPositionWithFees(pmContract, id, gmx.account);
        if (position.liquidity > 0n) {
          positionsToMonitor.push({ tokenId: id, position });
        }
      }
    } else {
      // Auto-discover active positions
      positionsToMonitor = await uniswapReader.getActivePositionsForOwner(pmContract, gmx.account);
    }

    const poolState = await uniswapReader.getPoolState(poolContract);

    const poolToken0 = await poolContract.token0();
    const poolToken1 = await poolContract.token1();

    // Fetch decimals
    const token0Contract = new ethers.Contract(poolToken0, ERC20_ABI, this.provider);
    const token1Contract = new ethers.Contract(poolToken1, ERC20_ABI, this.provider);
    const [decimals0, decimals1] = await Promise.all([
      token0Contract.decimals(),
      token1Contract.decimals(),
    ]);

    // Determine Risk vs Stable (Collateral)
    // We assume the Collateral Token is the stable one (USDC)
    const isToken0Collateral = poolToken0.toLowerCase() === gmx.collateralToken.toLowerCase();
    const riskTokenDecimals = isToken0Collateral ? decimals1 : decimals0;

    // Calculate Price of Risk Token in Stable Token
    const rawPrice = sqrtPriceX96ToPrice(poolState.sqrtPriceX96, decimals0, decimals1);
    let riskTokenPrice = 0;

    if (isToken0Collateral) {
      // Token0 is Stable (USDC). Token1 is Risk (ETH).
      riskTokenPrice = rawPrice === 0 ? 0 : 1 / rawPrice;
    } else {
      // Token0 is Risk (ETH). Token1 is Stable (USDC).
      riskTokenPrice = rawPrice;
    }

    const uniswapPositions = [];
    let totalLpDelta = 0n;
    let totalFees0 = 0n;
    let totalFees1 = 0n;
    let anyOutOfRange = false;

    for (const { tokenId, position } of positionsToMonitor) {
      // Filter out positions that don't match our pool (token0/token1/fee)
      if (
        position.token0.toLowerCase() !== poolToken0.toLowerCase() ||
        position.token1.toLowerCase() !== poolToken1.toLowerCase()
      ) {
        continue; // Skip positions from other pools
      }

      const sqrtPaX96 = getSqrtRatioAtTick(position.tickLower);
      const sqrtPbX96 = getSqrtRatioAtTick(position.tickUpper);

      const deltaResult = calculateDelta(
        poolState.sqrtPriceX96,
        sqrtPaX96,
        sqrtPbX96,
        position.liquidity
      );

      uniswapPositions.push({
        tokenId: tokenId.toString(),
        liquidity: position.liquidity,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        currentTick: poolState.tick,
        sqrtPriceX96: poolState.sqrtPriceX96,
        unclaimedFees: {
          amount0: position.tokensOwed0,
          amount1: position.tokensOwed1,
        },
        delta: deltaResult,
      });

      totalLpDelta += deltaResult.delta;
      totalFees0 += position.tokensOwed0;
      totalFees1 += position.tokensOwed1;

      if (deltaResult.zone !== "in" && position.liquidity > 0n) {
        anyOutOfRange = true;
      }
    }

    // 2. Fetch GMX Data
    const gmxReaderContract = gmxReader.createReader(gmx.reader, this.provider);
    const gmxPosition = await gmxReader.getPosition(gmxReaderContract, gmx.dataStore, gmx.account, {
      market: gmx.market,
      collateralToken: gmx.collateralToken,
      isLong: false, // We assume short for hedging
    });

    // 3. Calculate GMX Delta
    const shortSizeTokens = gmxPosition ? gmxPosition.numbers.sizeInTokens : 0n;
    const gmxDelta = -shortSizeTokens;

    // 4. Calculate Net Delta and Drift
    const netDelta = totalLpDelta + gmxDelta;

    // Avoid division by zero if LP delta is 0
    let deltaDrift = 0;
    if (totalLpDelta !== 0n) {
      const absNetDelta = netDelta < 0n ? -netDelta : netDelta;
      deltaDrift = Number(absNetDelta) / Number(totalLpDelta);
    } else if (shortSizeTokens > 0n) {
      // If LP delta is 0 but we have a short, drift is effectively infinite/max
      deltaDrift = 1; // 100% drift relative to being "neutral" (which would be 0 short)
    }

    const pendingFunding = gmxPosition
      ? gmxPosition.numbers.shortTokenClaimableFundingAmountPerSize
      : 0n;

    const status: StrategyStatus = {
      uniswap: uniswapPositions,
      totalLpDelta,
      gmx: {
        positionSizeTokens: shortSizeTokens, // stored as positive int in struct
        pendingFundingRewards: pendingFunding,
        delta: gmxDelta,
      },
      netDelta,
      deltaDrift,
      timestamp: Date.now(),
    };

    let totalFeesUsd = 0n;
    if (isToken0Collateral) {
       // Token0 is Stable ($1). Token1 is Risk ($price).
       totalFeesUsd += this.calculateUsdValue(totalFees0, Number(decimals0), 1.0);
       totalFeesUsd += this.calculateUsdValue(totalFees1, Number(decimals1), riskTokenPrice);
    } else {
       // Token0 is Risk ($price). Token1 is Stable ($1).
       totalFeesUsd += this.calculateUsdValue(totalFees0, Number(decimals0), riskTokenPrice);
       totalFeesUsd += this.calculateUsdValue(totalFees1, Number(decimals1), 1.0);
    }

    const recommendation = this.generateRecommendation(
      status, 
      anyOutOfRange, 
      totalFeesUsd,
      riskTokenPrice,
      Number(riskTokenDecimals)
    );

    return { status, recommendation };
  }

  private calculateUsdValue(amount: bigint, decimals: number, price: number): bigint {
    if (amount === 0n) return 0n;
    const sign = amount < 0n ? -1n : 1n;
    const absAmount = amount < 0n ? -amount : amount;
    
    const amountStr = ethers.formatUnits(absAmount, decimals);
    const amountFloat = parseFloat(amountStr);
    const usdFloat = amountFloat * price;
    
    try {
        return sign * ethers.parseUnits(usdFloat.toFixed(18), 30); 
    } catch (e) {
        return sign * BigInt(Math.floor(usdFloat * 1e30)); 
    }
  }

  private generateRecommendation(
    status: StrategyStatus, 
    anyOutOfRange: boolean,
    totalFeesUsd: bigint,
    price: number,
    decimals: number
  ): Recommendation {
    // 1. Check for Range Adjustment
    if (anyOutOfRange) {
      return {
        action: StrategyAction.ADJUST_RANGE,
        reason: `One or more positions are out of range.`,
      };
    }

    // 2. Check for Rebalancing
    if (status.deltaDrift > this.config.deltaThreshold) {
      const targetDelta = status.totalLpDelta;
      const currentHedge = -status.gmx.delta;
      const adjustmentNeeded = status.netDelta;

      const data: RebalanceData = {
          targetDelta,
          currentHedge,
          adjustmentNeeded,
          targetSizeUsd: this.calculateUsdValue(targetDelta, decimals, price),
          adjustmentNeededUsd: this.calculateUsdValue(adjustmentNeeded, decimals, price),
      };

      return {
        action: StrategyAction.REBALANCE,
        reason: `Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds threshold ${(this.config.deltaThreshold * 100).toFixed(2)}%`,
        data
      };
    }

    // 3. Check for Compounding
    if (totalFeesUsd > this.config.minFeeThresholdUsd) {
      return {
        action: StrategyAction.COMPOUND,
        reason: `Unclaimed fees ($${ethers.formatUnits(totalFeesUsd, 30)}) exceed threshold ($${ethers.formatUnits(this.config.minFeeThresholdUsd, 30)})`,
      };
    }

    return {
      action: StrategyAction.NONE,
      reason: "Strategy is healthy",
    };
  }
}