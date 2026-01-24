import { ethers } from "ethers";
import { UniswapPosition } from "../modules/uniswap/types";
import { StrategyConfig } from "../config/strategy";
import { getDefaultRangeBounds } from "../config/markets";
import {
  priceToTickWithDecimals,
  roundTickDown,
  roundTickUp,
  tickToPriceWithDecimals,
} from "../modules/math/ticks";

export interface RangeAdjustmentData {
  /** Token IDs of positions to close */
  tokenIdsToClose: bigint[];
  /** New tick lower bound */
  tickLower: number;
  /** New tick upper bound */
  tickUpper: number;
  /** New price lower bound */
  priceLower: number;
  /** New price upper bound */
  priceUpper: number;
  /** Range width used for new position */
  rangeWidth: number;
}

export interface RangeAdjustmentContext {
  poolAddress: string;
  positionManager: string;
  account: string;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
  isToken0Weth: boolean;
  isToken0Usdc: boolean;
  fee: number;
  tickSpacing: number;
}

export class RangeAdjustmentManager {
  constructor(
    private config: StrategyConfig,
    private context: RangeAdjustmentContext
  ) {}

  /**
   * Calculate new range bounds based on current price and configured default
   */
  calculateNewRangeBounds(
    currentPrice: number,
    rangeWidthOverride?: number
  ): { lower: number; upper: number; rangeWidth: number } {
    const rangeWidth = rangeWidthOverride ?? this.config.defaultRangeWidth;
    const bounds = getDefaultRangeBounds(currentPrice, rangeWidth);
    return {
      lower: bounds.lower,
      upper: bounds.upper,
      rangeWidth,
    };
  }

  /**
   * Calculate ticks for new range bounds
   */
  calculateNewTicks(
    priceLower: number,
    priceUpper: number,
    currentTick: number
  ): { tickLower: number; tickUpper: number } {
    const { isToken0Weth, token0Decimals, token1Decimals, tickSpacing } = this.context;

    const priceLowerForTicks = isToken0Weth ? priceLower : 1 / priceLower;
    const priceUpperForTicks = isToken0Weth ? priceUpper : 1 / priceUpper;

    const tickLower = roundTickDown(
      priceToTickWithDecimals(priceLowerForTicks, token0Decimals, token1Decimals),
      tickSpacing
    );
    const tickUpper = roundTickUp(
      priceToTickWithDecimals(priceUpperForTicks, token0Decimals, token1Decimals),
      tickSpacing
    );

    if (tickLower >= tickUpper) {
      throw new Error(`Invalid ticks: tickLower (${tickLower}) >= tickUpper (${tickUpper})`);
    }

    return { tickLower, tickUpper };
  }

  /**
   * Prepare range adjustment data
   */
  prepareAdjustment(
    positionsToClose: { tokenId: bigint; position: UniswapPosition }[],
    currentPrice: number,
    currentTick: number,
    rangeWidthOverride?: number
  ): RangeAdjustmentData {
    const tokenIdsToClose = positionsToClose.map((p) => p.tokenId);

    const { lower, upper, rangeWidth } = this.calculateNewRangeBounds(
      currentPrice,
      rangeWidthOverride
    );
    const { tickLower, tickUpper } = this.calculateNewTicks(lower, upper, currentTick);

    return {
      tokenIdsToClose,
      tickLower,
      tickUpper,
      priceLower: lower,
      priceUpper: upper,
      rangeWidth,
    };
  }

  /**
   * Validate that adjustment is needed and positions are valid
   */
  validateAdjustment(
    positionsToClose: { tokenId: bigint; position: UniswapPosition }[],
    currentPrice: number
  ): { valid: boolean; reason?: string } {
    if (positionsToClose.length === 0) {
      return { valid: false, reason: "No positions to adjust" };
    }

    const positionsWithLiquidity = positionsToClose.filter((p) => p.position.liquidity > 0n);
    if (positionsWithLiquidity.length === 0) {
      return { valid: false, reason: "No positions with liquidity to adjust" };
    }

    // Check if any position has a range that's significantly wider than default
    const { rangeWidth: defaultRangeWidth } = this.calculateNewRangeBounds(currentPrice);
    let hasWideRange = false;

    for (const { position } of positionsToClose) {
      if (position.liquidity === 0n) continue;

      // Calculate current range width (simplified - would need price conversion)
      // This is a placeholder - actual implementation would need tick-to-price conversion
      const tolerance = 0.1; // 10% tolerance
      // For now, we'll assume validation passes if positions exist
      hasWideRange = true;
    }

    return { valid: true };
  }
}
