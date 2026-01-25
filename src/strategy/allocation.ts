import { StrategyConfig, PRECISION } from "../config/strategy";
import { calculateDelta, DeltaResult } from "../modules/math/delta";
import {
  getSqrtRatioAtTick,
  priceToTickWithDecimals,
  priceToSqrtPriceX96,
} from "../modules/math/ticks";
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
 * Estimate LP delta for a given position size using Uniswap V3 formula
 *
 * This calculates delta in WETH tokens (matching monitor calculation), then converts to USD.
 * Uses the actual Uniswap V3 delta formula for accuracy.
 *
 * @param lpSizeUsd LP size in USD (30 decimals)
 * @param currentPrice Current price (USDC per WETH)
 * @param priceLower Lower bound of LP range
 * @param priceUpper Upper bound of LP range
 * @param wethDecimals WETH decimals (usually 18)
 * @param usdcDecimals USDC decimals (usually 6)
 * @returns Delta in USD (30 decimals) - this is the GMX short size needed
 */
export function estimateLpDelta(
  lpSizeUsd: bigint,
  currentPrice: number, // USDC per WETH
  priceLower: number,
  priceUpper: number,
  wethDecimals: number = 18,
  usdcDecimals: number = 6
): bigint {
  // Calculate token amounts for this LP size (same logic as calculateLpTokenAmounts)
  const rangeSize = priceUpper - priceLower;
  let deltaRatio: number;

  if (currentPrice <= priceLower) {
    deltaRatio = 1.0; // All token0 (WETH)
  } else if (currentPrice >= priceUpper) {
    deltaRatio = 0.0; // All token1 (USDC)
  } else {
    // Linear interpolation within range (for token amounts)
    const positionInRange = (currentPrice - priceLower) / rangeSize;
    deltaRatio = 1.0 - positionInRange; // 1.0 at lower, 0.0 at upper
  }

  // Calculate WETH and USDC amounts
  const wethValueUsd = (lpSizeUsd * BigInt(Math.floor(deltaRatio * 1e18))) / PRECISION.STANDARD;
  const wethAmount =
    (wethValueUsd * BigInt(10 ** wethDecimals)) / BigInt(Math.floor(currentPrice * 1e30));
  const usdcValueUsd = lpSizeUsd - wethValueUsd;
  const usdcAmount = (usdcValueUsd * BigInt(10 ** usdcDecimals)) / PRECISION.GMX_USD;

  // Convert prices to sqrtPriceX96 format for Uniswap V3 calculations
  // Note: In WETH/USDC pool, token0=WETH (18 decimals), token1=USDC (6 decimals)
  // currentPrice = USDC/WETH = token1/token0
  // For Uniswap V3, we need sqrtPriceX96 representing sqrt(token1/token0) in Q96 format
  // priceToSqrtPriceX96 expects price in token1/token0 format with (token1Decimals, token0Decimals)
  const sqrtPriceX96 = priceToSqrtPriceX96(currentPrice, usdcDecimals, wethDecimals);

  // For ticks, priceToTickWithDecimals expects price in token1/token0 format
  // But we need to be careful - ticks represent the price, and we need to match the pool's token order
  // Since currentPrice is already USDC/WETH (token1/token0), we use it directly
  const tickLower = priceToTickWithDecimals(priceLower, usdcDecimals, wethDecimals);
  const tickUpper = priceToTickWithDecimals(priceUpper, usdcDecimals, wethDecimals);
  const sqrtPaX96 = getSqrtRatioAtTick(tickLower);
  const sqrtPbX96 = getSqrtRatioAtTick(tickUpper);

  // Normalize bounds (ensure sqrtPaX96 <= sqrtPbX96)
  const [sqrtLower, sqrtUpper] =
    sqrtPaX96 <= sqrtPbX96 ? [sqrtPaX96, sqrtPbX96] : [sqrtPbX96, sqrtPaX96];

  // Estimate liquidity from token amounts using Uniswap V3 formulas
  // This is the reverse of getAmountsForLiquidity
  let estimatedLiquidity: bigint;

  if (currentPrice <= priceLower || sqrtPriceX96 <= sqrtLower) {
    // Price below or at lower bound: all WETH (token0)
    // When price is at lower bound: amount0 = L * (sqrtUpper - sqrtLower) * Q96 / (sqrtLower * sqrtUpper)
    // So: L = amount0 * sqrtLower * sqrtUpper / ((sqrtUpper - sqrtLower) * Q96)
    const sqrtDiff = sqrtUpper - sqrtLower;
    if (sqrtDiff === 0n) {
      estimatedLiquidity = wethAmount;
    } else {
      // Use floating point for precision
      const sqrtLowerNum = Number(sqrtLower) / Number(PRECISION.Q96);
      const sqrtUpperNum = Number(sqrtUpper) / Number(PRECISION.Q96);
      const sqrtDiffNum = sqrtUpperNum - sqrtLowerNum;
      const wethAmountNum = Number(wethAmount);
      const liquidityNum = (wethAmountNum * sqrtLowerNum * sqrtUpperNum) / sqrtDiffNum;
      estimatedLiquidity = BigInt(Math.floor(liquidityNum));
    }
  } else if (currentPrice >= priceUpper || sqrtPriceX96 >= sqrtUpper) {
    // Price above range: all USDC (token1), delta is 0
    return 0n;
  } else {
    // Price in range: calculate liquidity from both sides and use the minimum
    // Convert to numbers for intermediate calculations to avoid bigint overflow
    const sqrtCurrentNum = Number(sqrtPriceX96) / Number(PRECISION.Q96);
    const sqrtLowerNum = Number(sqrtLower) / Number(PRECISION.Q96);
    const sqrtUpperNum = Number(sqrtUpper) / Number(PRECISION.Q96);

    const sqrtDiffUpper = sqrtUpperNum - sqrtCurrentNum;
    const sqrtDiffLower = sqrtCurrentNum - sqrtLowerNum;

    if (sqrtDiffUpper <= 0) {
      // Edge case: price at or above upper bound
      return 0n;
    }

    if (sqrtDiffLower <= 0) {
      // Edge case: price at or below lower bound
      estimatedLiquidity = wethAmount;
    } else {
      // From amount0 (WETH): amount0 = L * (sqrtUpper - sqrtCurrent) * Q96 / (sqrtCurrent * sqrtUpper)
      // So: L = amount0 * sqrtCurrent * sqrtUpper / ((sqrtUpper - sqrtCurrent) * Q96)
      const wethAmountNum = Number(wethAmount);
      const liquidityFromWethNum = (wethAmountNum * sqrtCurrentNum * sqrtUpperNum) / sqrtDiffUpper;

      // From amount1 (USDC): amount1 = L * (sqrtCurrent - sqrtLower) / Q96
      // So: L = amount1 * Q96 / (sqrtCurrent - sqrtLower)
      const usdcAmountNum = Number(usdcAmount);
      const liquidityFromUsdcNum = (usdcAmountNum * Number(PRECISION.Q96)) / sqrtDiffLower;

      // Use the minimum (the limiting factor)
      const minLiquidityNum = Math.min(liquidityFromWethNum, liquidityFromUsdcNum);

      // Convert back to bigint (scale by Q96 to maintain precision)
      estimatedLiquidity = BigInt(Math.floor(minLiquidityNum));
    }
  }

  if (estimatedLiquidity === 0n) {
    return 0n;
  }

  // Calculate delta using the exact Uniswap V3 formula
  const deltaResult = calculateDelta(sqrtPriceX96, sqrtLower, sqrtUpper, estimatedLiquidity);

  // Delta is in WETH tokens (18 decimals) - convert to USD
  // delta_usd = delta_tokens * price_usdc_per_weth
  const deltaTokens = deltaResult.delta;
  const deltaUsd =
    (deltaTokens * BigInt(Math.floor(currentPrice * 1e30))) / BigInt(10 ** wethDecimals);

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

  // Use binary search to find optimal LP size
  let lpMin = 0n;
  let lpMax = availableCapital;
  let bestLpSize = 0n;
  let bestResult: AllocationResult | null = null;
  const tolerance = (availableCapital * BigInt(100)) / PRECISION.STANDARD; // 0.01% tolerance

  for (let i = 0; i < 50; i++) {
    const lpSizeUsd = (lpMin + lpMax) / 2n;

    // Estimate LP delta for this LP size (need decimals for proper calculation)
    // We'll use standard decimals (18 for WETH, 6 for USDC)
    const lpDelta = estimateLpDelta(lpSizeUsd, currentPrice, priceLower, priceUpper, 18, 6);

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
  const lpDelta = estimateLpDelta(conservativeLpSize, currentPrice, priceLower, priceUpper, 18, 6);
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
