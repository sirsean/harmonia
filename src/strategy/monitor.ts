import { ethers } from "ethers";
import * as gmxReader from "../modules/gmx/reader";
import * as uniswapReader from "../modules/uniswap/reader";
import { calculateDelta, DeltaResult } from "../modules/math/delta";
import {
  getSqrtRatioAtTick,
  sqrtPriceX96ToPrice,
  tickToPriceWithDecimals,
} from "../modules/math/ticks";
import {
  Recommendation,
  StrategyAction,
  StrategyMonitor,
  StrategyStatus,
  OptimizationData,
} from "./types";
import { StrategyConfig } from "../config/strategy";
import { GMXPosition } from "../modules/gmx/types";
import { UniswapPosition } from "../modules/uniswap/types";
import { ERC20_ABI } from "../utils/abis";
import { MonitoringDatabase } from "../utils/database";

export class DeltaNeutralMonitor implements StrategyMonitor {
  constructor(
    private provider: ethers.Provider,
    private config: StrategyConfig,
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
    },
    private database?: MonitoringDatabase
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

    // Fetch decimals and symbols
    const token0Contract = new ethers.Contract(poolToken0, ERC20_ABI, this.provider);
    const token1Contract = new ethers.Contract(poolToken1, ERC20_ABI, this.provider);
    const [decimals0, decimals1, symbol0, symbol1] = await Promise.all([
      token0Contract.decimals(),
      token1Contract.decimals(),
      token0Contract.symbol(),
      token1Contract.symbol(),
    ]);

    // Determine Risk vs Stable (Collateral)
    // We assume the Collateral Token is the stable one (USDC)
    const isToken0Collateral = poolToken0.toLowerCase() === gmx.collateralToken.toLowerCase();
    const riskTokenDecimals = isToken0Collateral ? decimals1 : decimals0;
    const stableSymbol = isToken0Collateral ? symbol0 : symbol1;
    const riskSymbol = isToken0Collateral ? symbol1 : symbol0;
    const priceLabel = `${stableSymbol}/${riskSymbol}`;

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

      // Price calculations
      const rawCurrent = tickToPriceWithDecimals(poolState.tick, decimals0, decimals1);
      const rawLower = tickToPriceWithDecimals(position.tickLower, decimals0, decimals1);
      const rawUpper = tickToPriceWithDecimals(position.tickUpper, decimals0, decimals1);

      const currentPrice = isToken0Collateral ? 1 / rawCurrent : rawCurrent;
      let priceLower = isToken0Collateral ? 1 / rawUpper : rawLower;
      let priceUpper = isToken0Collateral ? 1 / rawLower : rawUpper;

      // Ensure lower < upper (inversion can flip them)
      if (priceLower > priceUpper) {
        [priceLower, priceUpper] = [priceUpper, priceLower];
      }

      uniswapPositions.push({
        tokenId: tokenId.toString(),
        liquidity: position.liquidity,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        currentTick: poolState.tick,
        sqrtPriceX96: poolState.sqrtPriceX96,
        currentPrice,
        priceLower,
        priceUpper,
        priceLabel,
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

    // Estimate GMX Net Value
    let gmxNetValue = 0n;
    let gmxCollateralAmount = 0n;

    if (gmxPosition) {
      gmxCollateralAmount = gmxPosition.numbers.collateralAmount;
      // Collateral Value (assuming stable USDC $1)
      // CollateralAmount is 6 decimals. NetValue needs 30 decimals.
      // val = amount * 10^24.
      // We should check collateral decimals. We fetch 'decimals0/1' for Uniswap.
      // We assume gmx.collateralToken matches one of them.
      const collDecimals =
        gmx.collateralToken.toLowerCase() === poolToken0.toLowerCase() ? decimals0 : decimals1;
      const collateralValue30 = this.calculateUsdValue(
        gmxCollateralAmount,
        Number(collDecimals),
        1.0
      );

      // PnL Calculation
      const sizeTokens = gmxPosition.numbers.sizeInTokens;
      if (sizeTokens > 0n) {
        // Entry Price (30 dec) = sizeInUsd (30) / sizeInTokens (18?)
        // We know riskTokenDecimals.
        // But simpler: PnL = EntryValue - CurrentValue (for Long).
        // For Short: PnL = EntryValue - CurrentValue ? No.
        // Short PnL = (EntryPrice - MarkPrice) * SizeTokens.
        // EntryValue = SizeInUsd.
        // CurrentValue = SizeTokens * MarkPrice.
        const entryValue = gmxPosition.numbers.sizeInUsd;
        const currentValue = this.calculateUsdValue(
          sizeTokens,
          Number(riskTokenDecimals),
          riskTokenPrice
        );

        // Short PnL = EntryValue - CurrentValue
        const pnl = entryValue - currentValue;
        gmxNetValue = collateralValue30 + pnl;
      } else {
        gmxNetValue = collateralValue30;
      }
    }

    const status: StrategyStatus = {
      uniswap: uniswapPositions,
      totalLpDelta,
      gmx: {
        positionSizeTokens: shortSizeTokens, // stored as positive int in struct
        collateralAmount: gmxCollateralAmount,
        netValueUsd: gmxNetValue,
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

    // Get last optimization time from database if available
    let lastOptimizationTime: number | undefined;
    if (this.database) {
      const lastTime = this.database.getLastOptimizationTime(gmx.account);
      if (lastTime !== undefined) {
        lastOptimizationTime = lastTime;
      }
    }

    const recommendation = this.shouldOptimize(
      status,
      anyOutOfRange,
      totalFeesUsd,
      riskTokenPrice,
      Number(riskTokenDecimals),
      lastOptimizationTime
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

  /**
   * Determines if we should optimize right now based on multiple factors:
   * 1. Critical: Positions out of range (always optimize)
   * 2. Time since last optimization (min/max intervals)
   * 3. Delta drift (higher threshold to avoid being too eager)
   * 4. Cost/benefit analysis (fees vs gas costs)
   * 5. Range position (near edges or drifted from center)
   */
  private shouldOptimize(
    status: StrategyStatus,
    anyOutOfRange: boolean,
    totalFeesUsd: bigint,
    price: number,
    decimals: number,
    lastOptimizationTime?: number
  ): Recommendation {
    const now = Date.now();
    const timeSinceLastOptimization =
      lastOptimizationTime !== undefined ? (now - lastOptimizationTime) / 1000 : undefined;

    // Calculate estimated benefit (fees + value of delta correction)
    const gasCostUsd = this.config.estimatedOptimizationGasCostUsd;
    const estimatedBenefitUsd = this.estimateOptimizationBenefit(
      status,
      totalFeesUsd,
      price,
      decimals
    );

    const optimizationData: OptimizationData = {
      deltaDrift: status.deltaDrift,
      anyOutOfRange,
      totalFeesUsd,
      timeSinceLastOptimization,
      estimatedGasCostUsd: gasCostUsd,
      estimatedBenefitUsd,
    };

    // Priority 1: CRITICAL - Positions are out of range (always optimize)
    if (anyOutOfRange) {
      return {
        action: StrategyAction.OPTIMIZE,
        reason: "One or more positions are out of range - immediate optimization required",
        data: optimizationData,
      };
    }

    // Priority 2: Check minimum interval (rate limiting)
    if (timeSinceLastOptimization !== undefined) {
      if (timeSinceLastOptimization < this.config.minOptimizationInterval) {
        const minutesSince = Math.floor(timeSinceLastOptimization / 60);
        const minMinutes = Math.floor(this.config.minOptimizationInterval / 60);
        return {
          action: StrategyAction.NONE,
          reason: `Too soon since last optimization (${minutesSince}min < ${minMinutes}min minimum interval)`,
          data: optimizationData,
        };
      }
    }

    // Priority 3: Emergency delta drift (always optimize regardless of other factors)
    if (status.deltaDrift >= this.config.emergencyDeltaThreshold) {
      return {
        action: StrategyAction.OPTIMIZE,
        reason: `Emergency: Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds emergency threshold ${(this.config.emergencyDeltaThreshold * 100).toFixed(2)}%`,
        data: optimizationData,
      };
    }

    // Priority 4: Max interval reached (force optimization even if conditions aren't ideal)
    if (timeSinceLastOptimization !== undefined) {
      if (timeSinceLastOptimization >= this.config.maxOptimizationInterval) {
        const hoursSince = (timeSinceLastOptimization / 3600).toFixed(1);
        return {
          action: StrategyAction.OPTIMIZE,
          reason: `Max interval reached (${hoursSince}h since last optimization) - periodic optimization required`,
          data: optimizationData,
        };
      }
    }

    // Priority 5: Delta drift exceeds threshold AND cost/benefit is favorable
    if (status.deltaDrift >= this.config.optimizationDeltaThreshold) {
      // Check cost/benefit ratio
      if (estimatedBenefitUsd > 0n && gasCostUsd > 0n) {
        const benefitRatio = Number(estimatedBenefitUsd) / Number(gasCostUsd);
        if (benefitRatio >= this.config.minOptimizationBenefitRatio) {
          return {
            action: StrategyAction.OPTIMIZE,
            reason: `Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds threshold ${(this.config.optimizationDeltaThreshold * 100).toFixed(2)}% and benefit/cost ratio ${benefitRatio.toFixed(2)}x exceeds minimum ${this.config.minOptimizationBenefitRatio}x`,
            data: optimizationData,
          };
        } else {
          return {
            action: StrategyAction.NONE,
            reason: `Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds threshold but benefit/cost ratio ${benefitRatio.toFixed(2)}x is below minimum ${this.config.minOptimizationBenefitRatio}x`,
            data: optimizationData,
          };
        }
      } else {
        // If we can't calculate benefit ratio, still optimize if delta drift is high enough
        return {
          action: StrategyAction.OPTIMIZE,
          reason: `Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds threshold ${(this.config.optimizationDeltaThreshold * 100).toFixed(2)}%`,
          data: optimizationData,
        };
      }
    }

    // Priority 6: Range position issues (wide range, near edges, or drifted from center)
    const rangeIssues = this.checkRangeIssues(status, price);
    if (rangeIssues.hasIssues) {
      // Range width issues (exceeding default) should always trigger optimization
      // Other range issues (near edges, drifted) require fees/benefit check
      const isRangeWidthIssue =
        rangeIssues.reason.includes("range width") &&
        rangeIssues.reason.includes("exceeds configured default");

      if (
        isRangeWidthIssue ||
        totalFeesUsd >= this.config.minOptimizationFeeThresholdUsd ||
        (estimatedBenefitUsd > 0n && gasCostUsd > 0n && estimatedBenefitUsd >= gasCostUsd)
      ) {
        return {
          action: StrategyAction.OPTIMIZE,
          reason: rangeIssues.reason,
          data: optimizationData,
        };
      }
    }

    // Priority 7: Fees are significant enough to warrant optimization
    if (totalFeesUsd >= this.config.minOptimizationFeeThresholdUsd) {
      // Check if benefit exceeds cost
      if (estimatedBenefitUsd > 0n && gasCostUsd > 0n) {
        const benefitRatio = Number(estimatedBenefitUsd) / Number(gasCostUsd);
        if (benefitRatio >= this.config.minOptimizationBenefitRatio) {
          return {
            action: StrategyAction.OPTIMIZE,
            reason: `Unclaimed fees ($${ethers.formatUnits(totalFeesUsd, 30)}) exceed threshold and benefit/cost ratio ${benefitRatio.toFixed(2)}x is favorable`,
            data: optimizationData,
          };
        }
      } else {
        // If fees are high enough, optimize anyway
        return {
          action: StrategyAction.OPTIMIZE,
          reason: `Unclaimed fees ($${ethers.formatUnits(totalFeesUsd, 30)}) exceed threshold ($${ethers.formatUnits(this.config.minOptimizationFeeThresholdUsd, 30)})`,
          data: optimizationData,
        };
      }
    }

    // No optimization needed
    return {
      action: StrategyAction.NONE,
      reason: "Strategy is healthy - no optimization needed",
      data: optimizationData,
    };
  }

  /**
   * Check if there are range position issues that might warrant optimization
   */
  private checkRangeIssues(
    status: StrategyStatus,
    currentPrice: number
  ): { hasIssues: boolean; reason: string } {
    for (const position of status.uniswap) {
      if (position.liquidity === 0n) {
        continue;
      }

      const { priceLower, priceUpper, currentPrice: posCurrentPrice } = position;
      const price = posCurrentPrice || currentPrice;
      const priceCenter = (priceLower + priceUpper) / 2;
      const rangeWidth = priceUpper - priceLower;

      // Check if current range width exceeds configured default (priority check)
      // Calculate current range width as percentage of price
      const currentRangeWidthPercent = rangeWidth / price;
      if (currentRangeWidthPercent > this.config.defaultRangeWidth * 1.1) {
        // Allow 10% tolerance to avoid constant rebalancing due to tick rounding
        const currentWidthPercent = (currentRangeWidthPercent * 100).toFixed(1);
        const defaultWidthPercent = (this.config.defaultRangeWidth * 100).toFixed(1);
        return {
          hasIssues: true,
          reason: `Position ${position.tokenId} range width ${currentWidthPercent}% exceeds configured default ${defaultWidthPercent}% - optimization recommended to tighten range`,
        };
      }

      // Check if price is near range boundary
      const distanceToLower = (price - priceLower) / rangeWidth;
      const distanceToUpper = (priceUpper - price) / rangeWidth;
      const minDistanceToEdge = Math.min(distanceToLower, distanceToUpper);

      if (minDistanceToEdge < this.config.rangeAdjustmentThreshold) {
        const edge = distanceToLower < distanceToUpper ? "lower" : "upper";
        const distancePercent = (minDistanceToEdge * 100).toFixed(2);
        return {
          hasIssues: true,
          reason: `Position ${position.tokenId} price is within ${distancePercent}% of ${edge} edge (threshold: ${(this.config.rangeAdjustmentThreshold * 100).toFixed(2)}%)`,
        };
      }

      // Check if price has drifted significantly from center
      const distanceFromCenter = Math.abs(price - priceCenter) / priceCenter;
      if (distanceFromCenter > this.config.rangeCenterDriftThreshold) {
        const driftPercent = (distanceFromCenter * 100).toFixed(2);
        return {
          hasIssues: true,
          reason: `Position ${position.tokenId} price has drifted ${driftPercent}% from center (threshold: ${(this.config.rangeCenterDriftThreshold * 100).toFixed(2)}%)`,
        };
      }
    }

    return { hasIssues: false, reason: "" };
  }

  /**
   * Estimate the benefit of optimizing (fees + value of delta correction)
   */
  private estimateOptimizationBenefit(
    status: StrategyStatus,
    totalFeesUsd: bigint,
    price: number,
    decimals: number
  ): bigint {
    let benefit = totalFeesUsd;

    // Add value of correcting delta drift
    // Rough estimate: value of delta correction = abs(netDelta) * price * some factor
    // This is a simplified estimate - actual benefit depends on future price movements
    if (status.netDelta !== 0n && status.totalLpDelta !== 0n) {
      // Estimate: correcting delta reduces risk, which has value
      // Use a conservative estimate: 0.1% of the absolute delta value
      const absNetDelta = status.netDelta < 0n ? -status.netDelta : status.netDelta;
      const deltaValueUsd = this.calculateUsdValue(absNetDelta, decimals, price);
      // Conservative estimate: 0.1% of delta value as benefit
      benefit += deltaValueUsd / 1000n;
    }

    return benefit;
  }
}
