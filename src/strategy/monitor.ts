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
  HedgeAdjustmentData,
} from "./types";
import { StrategyConfig } from "../config/strategy";
import { GMXPosition } from "../modules/gmx/types";
import { UniswapPosition } from "../modules/uniswap/types";
import {
  ERC20_ABI,
  UNISWAP_POOL_ABI,
  UNISWAP_POSITION_MANAGER_ABI,
  GMX_READER_ABI,
} from "../utils/abis";
import { MonitoringDatabase } from "../utils/database";
import { multicallRead, MulticallRequest } from "../utils/multicall";

interface TokenMetadataCache {
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
}

export class DeltaNeutralMonitor implements StrategyMonitor {
  private tokenMetadataCache?: TokenMetadataCache;

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
      multicall3?: string;
    },
    private database?: MonitoringDatabase
  ) {}

  async check(): Promise<{ status: StrategyStatus; recommendation: Recommendation }> {
    const { uniswap, gmx } = this.context;

    // 1. Fetch Uniswap Data for ALL positions
    const poolContract = uniswapReader.createPool(uniswap.pool, this.provider);
    const pmContract = uniswapReader.createPositionManager(uniswap.positionManager, this.provider);

    let positionsToMonitor: { tokenId: bigint; position: UniswapPosition }[];
    let poolState;
    let gmxPosition: GMXPosition | undefined;

    const canBatch = this.context.multicall3 && uniswap.tokenIds && uniswap.tokenIds.length > 0;

    if (canBatch) {
      // Batched path: single multicall for pool state, positions, fees, and GMX
      ({ positionsToMonitor, poolState, gmxPosition } = await this.fetchDataBatched(
        uniswap.tokenIds!
      ));
    } else {
      // Individual calls path (auto-discover or no multicall3)
      ({ positionsToMonitor, poolState, gmxPosition } = await this.fetchDataIndividual(
        poolContract,
        pmContract
      ));
    }

    // Lazily cache immutable token metadata (token addresses, decimals, symbols)
    if (!this.tokenMetadataCache) {
      const poolToken0 = await poolContract.token0();
      const poolToken1 = await poolContract.token1();
      const token0Contract = new ethers.Contract(poolToken0, ERC20_ABI, this.provider);
      const token1Contract = new ethers.Contract(poolToken1, ERC20_ABI, this.provider);
      const [d0, d1, s0, s1] = await Promise.all([
        token0Contract.decimals(),
        token1Contract.decimals(),
        token0Contract.symbol(),
        token1Contract.symbol(),
      ]);
      this.tokenMetadataCache = {
        token0: poolToken0,
        token1: poolToken1,
        decimals0: typeof d0 === "bigint" ? Number(d0) : d0,
        decimals1: typeof d1 === "bigint" ? Number(d1) : d1,
        symbol0: s0,
        symbol1: s1,
      };
    }

    const {
      token0: poolToken0,
      token1: poolToken1,
      decimals0,
      decimals1,
      symbol0,
      symbol1,
    } = this.tokenMetadataCache;

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

    // 2. Calculate GMX Delta
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

    // Calculate funding fee amount (negative for costs)
    // Note: shortTokenClaimableFundingAmountPerSize is typically negative for shorts (we pay funding)
    // We'll track the absolute value as a cost
    let fundingFeeAmountUsd = 0n;
    if (gmxPosition && gmxPosition.numbers.sizeInTokens > 0n) {
      // fundingFeeAmountPerSize is cumulative funding fees paid per unit of size
      // Convert to USD value (30 decimals)
      const sizeInTokensScaled = gmxPosition.numbers.sizeInTokens;
      // fundingFeeAmountPerSize is in USD (30 decimals) per token (scaled)
      // For accurate tracking, we'd need to track changes over time
      // For now, we'll use the claimable funding as an approximation
      // Note: This is an approximation - actual funding fees should be tracked as deltas
      if (gmxPosition.numbers.fundingFeeAmountPerSize !== 0n) {
        // This is a cumulative value, so we'd need to track deltas
        // For now, we'll record it but actual calculation should track changes
        fundingFeeAmountUsd = gmxPosition.numbers.fundingFeeAmountPerSize;
      }
    }

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
    let lastHedgeAdjustmentTime: number | undefined;
    if (this.database) {
      const lastOptTime = this.database.getLastOptimizationTime(gmx.account);
      if (lastOptTime !== undefined) {
        lastOptimizationTime = lastOptTime;
      }
      const lastHedgeTime = this.database.getLastHedgeAdjustmentTime(gmx.account);
      if (lastHedgeTime !== undefined) {
        lastHedgeAdjustmentTime = lastHedgeTime;
      }
    }

    const recommendation = this.shouldOptimize(
      status,
      anyOutOfRange,
      totalFeesUsd,
      riskTokenPrice,
      Number(riskTokenDecimals),
      lastOptimizationTime,
      lastHedgeAdjustmentTime,
      gmxPosition
    );

    return { status, recommendation };
  }

  /**
   * Fetch pool state, positions, and GMX data using individual RPC calls.
   * Used when multicall3 is not configured or when auto-discovering positions.
   */
  private async fetchDataIndividual(
    poolContract: any,
    pmContract: any
  ): Promise<{
    positionsToMonitor: { tokenId: bigint; position: UniswapPosition }[];
    poolState: { sqrtPriceX96: bigint; tick: number; liquidity: bigint };
    gmxPosition: GMXPosition | undefined;
  }> {
    const { uniswap, gmx } = this.context;

    let positionsToMonitor: { tokenId: bigint; position: UniswapPosition }[] = [];

    if (uniswap.tokenIds && uniswap.tokenIds.length > 0) {
      for (const id of uniswap.tokenIds) {
        const position = await uniswapReader.getPositionWithFees(pmContract, id, gmx.account);
        if (position.liquidity > 0n) {
          positionsToMonitor.push({ tokenId: id, position });
        }
      }
    } else {
      positionsToMonitor = await uniswapReader.getActivePositionsForOwner(pmContract, gmx.account);
    }

    const poolState = await uniswapReader.getPoolState(poolContract);

    const gmxReaderContract = gmxReader.createReader(gmx.reader, this.provider);
    const gmxPosition = await gmxReader.getPosition(gmxReaderContract, gmx.dataStore, gmx.account, {
      market: gmx.market,
      collateralToken: gmx.collateralToken,
      isLong: false,
    });

    return { positionsToMonitor, poolState, gmxPosition };
  }

  /**
   * Fetch pool state, positions, and GMX data in a single Multicall3 batch.
   * Reduces ~5-8 RPC calls to 1.
   */
  private async fetchDataBatched(tokenIds: bigint[]): Promise<{
    positionsToMonitor: { tokenId: bigint; position: UniswapPosition }[];
    poolState: { sqrtPriceX96: bigint; tick: number; liquidity: bigint };
    gmxPosition: GMXPosition | undefined;
  }> {
    const { uniswap, gmx } = this.context;
    const multicall3Address = this.context.multicall3!;

    const poolIface = new ethers.Interface(UNISWAP_POOL_ABI);
    const pmIface = new ethers.Interface(UNISWAP_POSITION_MANAGER_ABI);
    const gmxIface = new ethers.Interface(GMX_READER_ABI);

    const MAX_UINT128 = (1n << 128n) - 1n;

    // Build the batch: slot0, liquidity, then per-position: positions + collect, then GMX
    const requests: MulticallRequest[] = [];

    // Index 0: slot0
    requests.push({
      target: uniswap.pool,
      iface: poolIface,
      functionName: "slot0",
      args: [],
    });

    // Index 1: liquidity
    requests.push({
      target: uniswap.pool,
      iface: poolIface,
      functionName: "liquidity",
      args: [],
    });

    // Indices 2..2+2N-1: for each tokenId, positions() then collect()
    for (const tokenId of tokenIds) {
      requests.push({
        target: uniswap.positionManager,
        iface: pmIface,
        functionName: "positions",
        args: [tokenId],
      });

      requests.push({
        target: uniswap.positionManager,
        iface: pmIface,
        functionName: "collect",
        args: [
          {
            tokenId,
            recipient: gmx.account,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          },
        ],
        allowFailure: true,
      });
    }

    // Last index: GMX getAccountPositions
    requests.push({
      target: gmx.reader,
      iface: gmxIface,
      functionName: "getAccountPositions",
      args: [gmx.dataStore, gmx.account, 0, 10],
    });

    const results = await multicallRead(this.provider, multicall3Address, requests);

    // Parse slot0
    const slot0Data = results[0].data;
    const poolState = {
      sqrtPriceX96: slot0Data[0] as bigint,
      tick: Number(slot0Data[1]),
      liquidity: results[1].data[0] as bigint,
    };

    // Parse positions and fees
    const positionsToMonitor: { tokenId: bigint; position: UniswapPosition }[] = [];
    for (let i = 0; i < tokenIds.length; i++) {
      const posResult = results[2 + i * 2];
      const feeResult = results[2 + i * 2 + 1];

      const data = posResult.data;
      const position: UniswapPosition = {
        nonce: data[0] as bigint,
        operator: data[1] as string,
        token0: data[2] as string,
        token1: data[3] as string,
        fee: Number(data[4]),
        tickLower: Number(data[5]),
        tickUpper: Number(data[6]),
        liquidity: data[7] as bigint,
        feeGrowthInside0LastX128: data[8] as bigint,
        feeGrowthInside1LastX128: data[9] as bigint,
        tokensOwed0: feeResult.success ? (feeResult.data[0] as bigint) : 0n,
        tokensOwed1: feeResult.success ? (feeResult.data[1] as bigint) : 0n,
      };

      if (position.liquidity > 0n) {
        positionsToMonitor.push({ tokenId: tokenIds[i], position });
      }
    }

    // Parse GMX positions
    const gmxResultIndex = 2 + tokenIds.length * 2;
    const gmxPositions = results[gmxResultIndex].data[0] as GMXPosition[];
    const gmxPosition = gmxReader.findPosition(gmxPositions, {
      market: gmx.market,
      collateralToken: gmx.collateralToken,
      isLong: false,
    });

    return { positionsToMonitor, poolState, gmxPosition };
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
   * Build HedgeAdjustmentData for the current state.
   * Returns undefined if no GMX position exists or adjustment is below minimum.
   */
  private buildHedgeAdjustmentData(
    status: StrategyStatus,
    gmxPosition: GMXPosition | undefined,
    price: number,
    decimals: number
  ): HedgeAdjustmentData | undefined {
    if (!gmxPosition || status.totalLpDelta === 0n) return undefined;

    const currentShortSizeTokens = gmxPosition.numbers.sizeInTokens;
    // Target short size = LP delta (to neutralize it)
    const targetShortSizeTokens = status.totalLpDelta;

    // Calculate adjustment in tokens (positive = need to increase short)
    const adjustmentTokens = targetShortSizeTokens - currentShortSizeTokens;
    if (adjustmentTokens === 0n) return undefined;

    // Convert adjustment to USD (30 decimals)
    const absAdjustmentTokens = adjustmentTokens < 0n ? -adjustmentTokens : adjustmentTokens;
    const adjustmentUsdAbs = this.calculateUsdValue(absAdjustmentTokens, decimals, price);

    // Check minimum adjustment size
    if (adjustmentUsdAbs < this.config.minHedgeAdjustmentUsd) return undefined;

    const adjustmentSizeUsd = adjustmentTokens > 0n ? adjustmentUsdAbs : -adjustmentUsdAbs;

    // Calculate current and estimated leverage
    let currentLeverage = 0;
    let estimatedLeverageAfter = 0;

    if (gmxPosition.numbers.collateralAmount > 0n) {
      const collateralUsd = this.calculateUsdValue(
        gmxPosition.numbers.collateralAmount,
        6, // USDC decimals
        1.0 // USDC price
      );

      if (collateralUsd > 0n) {
        const currentSizeUsd = gmxPosition.numbers.sizeInUsd;
        currentLeverage = Number(currentSizeUsd) / Number(collateralUsd);

        // New size after adjustment
        const newSizeUsd =
          adjustmentSizeUsd > 0n
            ? currentSizeUsd + adjustmentUsdAbs
            : currentSizeUsd - adjustmentUsdAbs;

        // Collateral stays the same for hedge adjustments
        estimatedLeverageAfter = newSizeUsd > 0n ? Number(newSizeUsd) / Number(collateralUsd) : 0;
      }
    }

    return {
      currentShortSizeTokens,
      targetShortSizeTokens,
      adjustmentSizeUsd,
      currentLeverage,
      estimatedLeverageAfter,
    };
  }

  /**
   * Determines if we should optimize or hedge-adjust right now based on multiple factors:
   *
   * Decision flow:
   * 1. Out of range → OPTIMIZE (always)
   * 2. Within hedge cooldown → NONE
   * 3. Within optimization cooldown (but past hedge cooldown):
   *    - Emergency delta → OPTIMIZE (bypass optimization cooldown)
   *    - Delta >= hedge threshold → HEDGE_ADJUST
   *    - else → NONE
   * 4. Past optimization cooldown:
   *    - Max interval → OPTIMIZE
   *    - Delta >= optimization threshold (with cost/benefit) → OPTIMIZE
   *    - Delta >= hedge threshold → HEDGE_ADJUST
   *    - Range issues → OPTIMIZE
   *    - Fees accumulated → OPTIMIZE
   *    - else → NONE
   */
  private shouldOptimize(
    status: StrategyStatus,
    anyOutOfRange: boolean,
    totalFeesUsd: bigint,
    price: number,
    decimals: number,
    lastOptimizationTime?: number,
    lastHedgeAdjustmentTime?: number,
    gmxPosition?: GMXPosition
  ): Recommendation {
    const now = Date.now();
    const timeSinceLastOptimization =
      lastOptimizationTime !== undefined ? (now - lastOptimizationTime) / 1000 : undefined;
    const timeSinceLastHedge =
      lastHedgeAdjustmentTime !== undefined ? (now - lastHedgeAdjustmentTime) / 1000 : undefined;

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

    // Pre-compute hedge adjustment data for potential HEDGE_ADJUST decisions
    const hedgeData = this.buildHedgeAdjustmentData(status, gmxPosition, price, decimals);

    // Helper to build a HEDGE_ADJUST recommendation with leverage safety check
    const makeHedgeRecommendation = (reason: string): Recommendation | null => {
      if (!hedgeData) return null;

      // Leverage safety guard
      if (hedgeData.estimatedLeverageAfter > this.config.maxHedgeLeverage) {
        return null; // Caller should escalate to OPTIMIZE or NONE
      }

      return {
        action: StrategyAction.HEDGE_ADJUST,
        reason,
        data: optimizationData,
        hedgeData,
      };
    };

    // Priority 1: CRITICAL - Positions are out of range (always optimize)
    if (anyOutOfRange) {
      return {
        action: StrategyAction.OPTIMIZE,
        reason: "One or more positions are out of range - immediate optimization required",
        data: optimizationData,
      };
    }

    // Priority 2: Check hedge cooldown (rate limiting for everything)
    if (timeSinceLastHedge !== undefined) {
      if (timeSinceLastHedge < this.config.minHedgeInterval) {
        return {
          action: StrategyAction.NONE,
          reason: `Too soon since last hedge/optimization (${Math.floor(timeSinceLastHedge / 60)}min < ${Math.floor(this.config.minHedgeInterval / 60)}min hedge interval)`,
          data: optimizationData,
        };
      }
    }

    // Priority 3: Within optimization cooldown (but past hedge cooldown)
    const withinOptimizationCooldown =
      timeSinceLastOptimization !== undefined &&
      timeSinceLastOptimization < this.config.minOptimizationInterval;

    if (withinOptimizationCooldown) {
      // 3a: Emergency delta drift bypasses optimization cooldown
      if (status.deltaDrift >= this.config.emergencyDeltaThreshold) {
        return {
          action: StrategyAction.OPTIMIZE,
          reason: `Emergency: Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds emergency threshold ${(this.config.emergencyDeltaThreshold * 100).toFixed(2)}%`,
          data: optimizationData,
        };
      }

      // 3b: Hedge adjustment if delta drift exceeds hedge threshold
      if (status.deltaDrift >= this.config.hedgeDeltaThreshold) {
        const hedgeRec = makeHedgeRecommendation(
          `Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds hedge threshold ${(this.config.hedgeDeltaThreshold * 100).toFixed(2)}% (within optimization cooldown)`
        );
        if (hedgeRec) return hedgeRec;
        // If hedge failed safety check, fall through to NONE (can't optimize yet)
      }

      // 3c: Within optimization cooldown and no hedge needed
      const minutesSince = Math.floor(timeSinceLastOptimization! / 60);
      const minMinutes = Math.floor(this.config.minOptimizationInterval / 60);
      return {
        action: StrategyAction.NONE,
        reason: `Within optimization cooldown (${minutesSince}min < ${minMinutes}min) - no action needed`,
        data: optimizationData,
      };
    }

    // Priority 4+: Past optimization cooldown (or never optimized)

    // Priority 4: Emergency delta drift (always optimize regardless of other factors)
    if (status.deltaDrift >= this.config.emergencyDeltaThreshold) {
      return {
        action: StrategyAction.OPTIMIZE,
        reason: `Emergency: Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds emergency threshold ${(this.config.emergencyDeltaThreshold * 100).toFixed(2)}%`,
        data: optimizationData,
      };
    }

    // Priority 5: Max interval reached (force optimization even if conditions aren't ideal)
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

    // Priority 6: Delta drift exceeds optimization threshold AND cost/benefit is favorable
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
          // Cost/benefit not favorable for full optimization, try hedge instead
          if (status.deltaDrift >= this.config.hedgeDeltaThreshold) {
            const hedgeRec = makeHedgeRecommendation(
              `Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds hedge threshold - hedge preferred over optimization (benefit/cost ratio ${benefitRatio.toFixed(2)}x below minimum ${this.config.minOptimizationBenefitRatio}x)`
            );
            if (hedgeRec) return hedgeRec;
          }
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

    // Priority 7: Delta drift exceeds hedge threshold (but below optimization threshold)
    if (status.deltaDrift >= this.config.hedgeDeltaThreshold) {
      const hedgeRec = makeHedgeRecommendation(
        `Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds hedge threshold ${(this.config.hedgeDeltaThreshold * 100).toFixed(2)}%`
      );
      if (hedgeRec) return hedgeRec;
      // If hedge failed safety check, fall through to other checks
    }

    // Priority 8: Range position issues (wide range, near edges, or drifted from center)
    const rangeIssues = this.checkRangeIssues(status, price);
    if (rangeIssues.hasIssues) {
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

    // Priority 9: Fees are significant enough to warrant optimization
    if (totalFeesUsd >= this.config.minOptimizationFeeThresholdUsd) {
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
        return {
          action: StrategyAction.OPTIMIZE,
          reason: `Unclaimed fees ($${ethers.formatUnits(totalFeesUsd, 30)}) exceed threshold ($${ethers.formatUnits(this.config.minOptimizationFeeThresholdUsd, 30)})`,
          data: optimizationData,
        };
      }
    }

    // No optimization or hedge needed
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
