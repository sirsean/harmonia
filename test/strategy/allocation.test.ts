import { describe, it, expect } from "vitest";
import {
  calculateOptimalAllocation,
  estimateLpDelta,
  calculateLpTokenAmounts,
  AllocationResult,
} from "../../src/strategy/allocation";
import { PRECISION } from "../../src/config/strategy";

describe("Allocation Calculations", () => {
  describe("estimateLpDelta", () => {
    it("should return 0 delta when price is at upper bound", () => {
      const lpSizeUsd = BigInt(100000) * PRECISION.GMX_USD; // $100k
      const currentPrice = 3300; // At upper bound
      const priceLower = 2700;
      const priceUpper = 3300;

      const delta = estimateLpDelta(lpSizeUsd, currentPrice, priceLower, priceUpper);
      expect(delta).toBe(0n);
    });

    it("should return full LP size delta when price is at lower bound", () => {
      const lpSizeUsd = BigInt(100000) * PRECISION.GMX_USD; // $100k
      const currentPrice = 2700; // At lower bound
      const priceLower = 2700;
      const priceUpper = 3300;

      const delta = estimateLpDelta(lpSizeUsd, currentPrice, priceLower, priceUpper);
      // Delta should be approximately equal to LP size (all WETH)
      expect(delta).toBeGreaterThan((lpSizeUsd * 99n) / 100n);
      expect(delta).toBeLessThanOrEqual(lpSizeUsd);
    });

    it("should return ~50% delta when price is at center", () => {
      const lpSizeUsd = BigInt(100000) * PRECISION.GMX_USD; // $100k
      const centerPrice = Math.sqrt(2700 * 3300); // ~2984.9
      const priceLower = 2700;
      const priceUpper = 3300;

      const delta = estimateLpDelta(lpSizeUsd, centerPrice, priceLower, priceUpper);
      // At geometric center, positionInRange ≈ 0.475, so deltaRatio ≈ 0.525
      // Delta should be approximately 50-55% of LP size
      // Expected: ~52.5% = 0.525 * lpSizeUsd
      const expectedDelta = (lpSizeUsd * 525n) / 1000n; // 52.5%
      expect(delta).toBeGreaterThan((expectedDelta * 95n) / 100n); // Allow 5% tolerance
      expect(delta).toBeLessThan((expectedDelta * 105n) / 100n);
    });

    it("should handle different range sizes", () => {
      const lpSizeUsd = BigInt(100000) * PRECISION.GMX_USD;
      const currentPrice = 3000;
      const priceLower1 = 2700; // ±10%
      const priceUpper1 = 3300;
      const priceLower2 = 2850; // ±5%
      const priceUpper2 = 3150;

      const delta1 = estimateLpDelta(lpSizeUsd, currentPrice, priceLower1, priceUpper1);
      const delta2 = estimateLpDelta(lpSizeUsd, currentPrice, priceLower2, priceUpper2);

      // Both should be similar since price is at center for both
      expect(delta1).toBeGreaterThan(0n);
      expect(delta2).toBeGreaterThan(0n);
    });
  });

  describe("calculateOptimalAllocation", () => {
    it("should allocate within max position size limit", () => {
      const totalCapital = BigInt(200000) * PRECISION.GMX_USD; // $200k
      const maxPositionSize = BigInt(100000) * PRECISION.GMX_USD; // $100k max
      const currentPrice = 3000;
      const priceLower = 2700;
      const priceUpper = 3300;
      const targetLeverage = 3.0;

      const allocation = calculateOptimalAllocation(
        totalCapital,
        maxPositionSize,
        currentPrice,
        priceLower,
        priceUpper,
        targetLeverage
      );

      expect(allocation.totalCapitalUsd).toBeLessThanOrEqual(maxPositionSize);
      expect(allocation.lpSizeUsd).toBeGreaterThan(0n);
      expect(allocation.gmxShortSizeUsd).toBeGreaterThan(0n);
      expect(allocation.gmxCollateralUsd).toBeGreaterThan(0n);
    });

    it("should use all capital if below max limit", () => {
      const totalCapital = BigInt(50000) * PRECISION.GMX_USD; // $50k
      const maxPositionSize = BigInt(100000) * PRECISION.GMX_USD; // $100k max
      const currentPrice = 3000;
      const priceLower = 2700;
      const priceUpper = 3300;
      const targetLeverage = 3.0;

      const allocation = calculateOptimalAllocation(
        totalCapital,
        maxPositionSize,
        currentPrice,
        priceLower,
        priceUpper,
        targetLeverage
      );

      // Should use most of the capital (some rounding may occur)
      expect(allocation.totalCapitalUsd).toBeLessThanOrEqual(totalCapital);
      expect(allocation.totalCapitalUsd).toBeGreaterThan((totalCapital * 90n) / 100n);
    });

    it("should calculate GMX collateral correctly based on leverage", () => {
      const totalCapital = BigInt(100000) * PRECISION.GMX_USD; // $100k
      const maxPositionSize = BigInt(100000) * PRECISION.GMX_USD;
      const currentPrice = 3000;
      const priceLower = 2700;
      const priceUpper = 3300;
      const targetLeverage = 3.0;

      const allocation = calculateOptimalAllocation(
        totalCapital,
        maxPositionSize,
        currentPrice,
        priceLower,
        priceUpper,
        targetLeverage
      );

      // GMX collateral = short size / leverage
      const expectedCollateral = allocation.gmxShortSizeUsd / BigInt(Math.floor(targetLeverage));
      expect(allocation.gmxCollateralUsd).toBeGreaterThanOrEqual(expectedCollateral * 99n / 100n);
      expect(allocation.gmxCollateralUsd).toBeLessThanOrEqual(expectedCollateral * 101n / 100n);
    });

    it("should ensure LP + GMX collateral <= total capital", () => {
      const totalCapital = BigInt(100000) * PRECISION.GMX_USD;
      const maxPositionSize = BigInt(100000) * PRECISION.GMX_USD;
      const currentPrice = 3000;
      const priceLower = 2700;
      const priceUpper = 3300;
      const targetLeverage = 3.0;

      const allocation = calculateOptimalAllocation(
        totalCapital,
        maxPositionSize,
        currentPrice,
        priceLower,
        priceUpper,
        targetLeverage
      );

      const totalUsed = allocation.lpSizeUsd + allocation.gmxCollateralUsd;
      expect(totalUsed).toBeLessThanOrEqual(maxPositionSize);
    });
  });

  describe("calculateLpTokenAmounts", () => {
    it("should calculate equal value amounts for centered position", () => {
      const lpSizeUsd = BigInt(100000) * PRECISION.GMX_USD; // $100k
      const currentPrice = 3000; // USDC per WETH
      const priceLower = 2700;
      const priceUpper = 3300;
      const wethDecimals = 18;
      const usdcDecimals = 6;

      const { wethAmount, usdcAmount } = calculateLpTokenAmounts(
        lpSizeUsd,
        currentPrice,
        priceLower,
        priceUpper,
        wethDecimals,
        usdcDecimals
      );

      // Should have approximately equal value in both tokens
      const wethValue = Number(wethAmount) * currentPrice / 1e18;
      const usdcValue = Number(usdcAmount) / 1e6;

      expect(wethValue).toBeCloseTo(usdcValue, 0);
      expect(wethAmount).toBeGreaterThan(0n);
      expect(usdcAmount).toBeGreaterThan(0n);
    });

    it("should handle different LP sizes", () => {
      const currentPrice = 3000;
      const priceLower = 2700;
      const priceUpper = 3300;
      const wethDecimals = 18;
      const usdcDecimals = 6;

      const smallLp = calculateLpTokenAmounts(
        BigInt(10000) * PRECISION.GMX_USD, // $10k
        currentPrice,
        priceLower,
        priceUpper,
        wethDecimals,
        usdcDecimals
      );

      const largeLp = calculateLpTokenAmounts(
        BigInt(100000) * PRECISION.GMX_USD, // $100k
        currentPrice,
        priceLower,
        priceUpper,
        wethDecimals,
        usdcDecimals
      );

      // Large LP should have 10x the amounts
      expect(largeLp.wethAmount).toBeGreaterThan(smallLp.wethAmount * 9n);
      expect(largeLp.usdcAmount).toBeGreaterThan(smallLp.usdcAmount * 9n);
    });

    it("should return amounts that sum to approximately LP size value", () => {
      const lpSizeUsd = BigInt(100000) * PRECISION.GMX_USD;
      const currentPrice = 3000;
      const priceLower = 2700;
      const priceUpper = 3300;

      const { wethAmount, usdcAmount } = calculateLpTokenAmounts(
        lpSizeUsd,
        currentPrice,
        priceLower,
        priceUpper,
        18,
        6
      );

      // Total value should be approximately LP size
      const wethValueUsd = (Number(wethAmount) * currentPrice) / 1e18;
      const usdcValueUsd = Number(usdcAmount) / 1e6;
      const totalValue = wethValueUsd + usdcValueUsd;

      expect(totalValue).toBeCloseTo(100000, -3); // Within $1000
    });
  });
});
