import { StrategyConfig, PRECISION } from "../config/strategy";
import { calculateDelta, DeltaResult } from "../modules/math/delta";
import { getSqrtRatioAtTick } from "../modules/math/ticks";
import { UniswapPosition } from "../modules/uniswap/types";

/**
 * Calculate optimal allocation between LP position and GMX hedge
 *
 * Given:
 * - Total available capital (USD)
 * - Max position size limit
 * - Target leverage for GMX
 * - LP position parameters (range, current price)
 *
 * Returns:
 * - Optimal LP size (USD)
 * - Required GMX hedge size (USD)
 * - Required GMX collateral (USD)
 */
export interface AllocationResult {
  /** LP position size in USD (30 decimals) */
  lpSizeUsd: bigint;
  /** GMX short size in USD (30 decimals) - to hedge LP delta */
  gmxShortSizeUsd: bigint;
  /** GMX collateral required in USD (30 decimals) */
  gmxCollateralUsd: bigint;
  /** Total capital used (LP + GMX collateral) in USD (30 decimals) */
  totalCapitalUsd: bigint;
  /** LP delta that will be hedged */
  lpDelta: bigint;
}

/**
 * Estimate LP delta for a given position size
 *
 * This is a simplified calculation assuming:
 * - Position is centered (current price at range center)
 * - Delta ≈ 0.5 at center (50% token0, 50% token1)
 * - Delta varies linearly within range
 *
 * For a more accurate calculation, we'd need to:
 * - Calculate actual liquidity distribution
 * - Use actual current price vs range bounds
 * - Account for price impact
 */
export function estimateLpDelta(
  lpSizeUsd: bigint,
  currentPrice: number, // USDC per WETH
  priceLower: number,
  priceUpper: number
): bigint {
  // For a centered LP position, delta ≈ 0.5 at center
  // Delta = 0 at upper bound, 1 at lower bound
  // At center: delta = 0.5

  const centerPrice = Math.sqrt(priceLower * priceUpper); // Geometric mean
  const rangeSize = priceUpper - priceLower;

  // Calculate how far current price is from center
  const priceOffset = currentPrice - centerPrice;
  const normalizedOffset = priceOffset / rangeSize;

  // Delta at center is 0.5, varies by ±0.5 across range
  // Simplified: delta = 0.5 - normalizedOffset
  // But we need to account for the actual range bounds
  let deltaRatio = 0.5;

  if (currentPrice <= priceLower) {
    deltaRatio = 1.0; // All token0 (WETH)
  } else if (currentPrice >= priceUpper) {
    deltaRatio = 0.0; // All token1 (USDC)
  } else {
    // Linear interpolation within range
    const positionInRange = (currentPrice - priceLower) / rangeSize;
    deltaRatio = 1.0 - positionInRange; // 1.0 at lower, 0.0 at upper
  }

  // LP delta in tokens = LP size * delta ratio
  // For delta-neutral, we need to short delta * LP size worth of WETH
  // Convert to USD: delta * LP size (already in USD)
  const deltaUsd = (lpSizeUsd * BigInt(Math.floor(deltaRatio * 1e18))) / PRECISION.STANDARD;

  return deltaUsd;
}

/**
 * Calculate optimal allocation for delta-neutral strategy
 *
 * @param totalCapitalUsd Total available capital in USD (30 decimals)
 * @param maxPositionSizeUsd Maximum position size limit in USD (30 decimals)
 * @param currentPrice Current price (USDC per WETH)
 * @param priceLower Lower bound of LP range
 * @param priceUpper Upper bound of LP range
 * @param targetLeverage Target leverage for GMX positions
 * @param collateralPrice Collateral token price (usually 1.0 for USDC)
 * @returns Allocation result with LP size, GMX hedge size, and collateral
 */
export function calculateOptimalAllocation(
  totalCapitalUsd: bigint,
  maxPositionSizeUsd: bigint,
  currentPrice: number,
  priceLower: number,
  priceUpper: number,
  targetLeverage: number,
  collateralPrice: number = 1.0
): AllocationResult {
  // Cap total capital by max position size
  const availableCapital =
    totalCapitalUsd > maxPositionSizeUsd ? maxPositionSizeUsd : totalCapitalUsd;

  // We need to solve for LP size such that:
  // LP size + GMX collateral <= available capital
  // GMX collateral = GMX short size / targetLeverage
  // GMX short size = LP delta
  // LP delta = estimateLpDelta(LP size, ...)

  // This is iterative - we need to find LP size where:
  // LP + (LP_delta / leverage) <= available
  //
  // For a centered position, delta ≈ 0.5, so:
  // LP + (0.5 * LP / leverage) <= available
  // LP * (1 + 0.5/leverage) <= available
  // LP <= available / (1 + 0.5/leverage)
  //
  // For leverage = 3: LP <= available / (1 + 0.5/3) = available / 1.1667 ≈ available * 0.857

  // Use binary search to find optimal LP size
  let lpMin = 0n;
  let lpMax = availableCapital;
  let bestLpSize = 0n;
  let bestResult: AllocationResult | null = null;
  const tolerance = (availableCapital * BigInt(100)) / PRECISION.STANDARD; // 0.01% tolerance

  for (let i = 0; i < 50; i++) {
    const lpSizeUsd = (lpMin + lpMax) / 2n;

    // Estimate LP delta for this LP size
    const lpDelta = estimateLpDelta(lpSizeUsd, currentPrice, priceLower, priceUpper);

    // Calculate required GMX collateral
    const leverageScaled = BigInt(Math.floor(targetLeverage * 10000));
    const gmxCollateralUsd = (lpDelta * 10000n) / leverageScaled;

    // Total capital needed
    const totalNeeded = lpSizeUsd + gmxCollateralUsd;

    if (totalNeeded <= availableCapital) {
      // This allocation fits - try to use more
      bestLpSize = lpSizeUsd;
      bestResult = {
        lpSizeUsd,
        gmxShortSizeUsd: lpDelta,
        gmxCollateralUsd,
        totalCapitalUsd: totalNeeded,
        lpDelta,
      };
      lpMin = lpSizeUsd;
    } else {
      // Too large - reduce
      lpMax = lpSizeUsd;
    }

    // Check convergence
    if (lpMax - lpMin <= tolerance) {
      break;
    }
  }

  // Return best result found, or fallback if none found
  if (bestResult) {
    return bestResult;
  }

  // Fallback: use conservative allocation
  const conservativeLpSize = availableCapital / 2n;
  const lpDelta = estimateLpDelta(conservativeLpSize, currentPrice, priceLower, priceUpper);
  const leverageScaled = BigInt(Math.floor(targetLeverage * 10000));
  const gmxCollateralUsd = (lpDelta * 10000n) / leverageScaled;

  return {
    lpSizeUsd: conservativeLpSize,
    gmxShortSizeUsd: lpDelta,
    gmxCollateralUsd,
    totalCapitalUsd: conservativeLpSize + gmxCollateralUsd,
    lpDelta,
  };
}

/**
 * Calculate token amounts for LP position given USD size
 *
 * @param lpSizeUsd LP size in USD (30 decimals)
 * @param currentPrice Current price (USDC per WETH)
 * @param priceLower Lower bound of LP range
 * @param priceUpper Upper bound of LP range
 * @param wethDecimals WETH decimals (usually 18)
 * @param usdcDecimals USDC decimals (usually 6)
 * @returns Token amounts in their native decimals
 */
export function calculateLpTokenAmounts(
  lpSizeUsd: bigint,
  currentPrice: number,
  priceLower: number,
  priceUpper: number,
  wethDecimals: number,
  usdcDecimals: number
): { wethAmount: bigint; usdcAmount: bigint } {
  // Calculate the delta ratio based on where current price is in the range
  // This must match the logic in estimateLpDelta to ensure consistency
  const rangeSize = priceUpper - priceLower;
  let deltaRatio: number;

  if (currentPrice <= priceLower) {
    deltaRatio = 1.0; // All token0 (WETH)
  } else if (currentPrice >= priceUpper) {
    deltaRatio = 0.0; // All token1 (USDC)
  } else {
    // Linear interpolation within range
    const positionInRange = (currentPrice - priceLower) / rangeSize;
    deltaRatio = 1.0 - positionInRange; // 1.0 at lower, 0.0 at upper
  }

  // Calculate token amounts based on delta ratio
  // WETH value = lpSizeUsd * deltaRatio
  // USDC value = lpSizeUsd * (1 - deltaRatio)
  const wethValueUsd = (lpSizeUsd * BigInt(Math.floor(deltaRatio * 1e18))) / PRECISION.STANDARD;
  const usdcValueUsd = lpSizeUsd - wethValueUsd;

  // Convert to token amounts
  // WETH amount = value / price (in 30 decimals) / 10^(30 - decimals)
  const wethAmount =
    (wethValueUsd * BigInt(10 ** wethDecimals)) / BigInt(Math.floor(currentPrice * 1e30));

  // USDC amount = value (in 30 decimals) / 10^(30 - decimals)
  const usdcAmount = (usdcValueUsd * BigInt(10 ** usdcDecimals)) / PRECISION.GMX_USD;

  return { wethAmount, usdcAmount };
}
