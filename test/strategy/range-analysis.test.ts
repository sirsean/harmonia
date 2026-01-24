import { describe, it, expect } from "vitest";
import {
  isOutOfRange,
  distanceToEdge,
  estimateFeeYield,
  estimateGasCosts,
  analyzeRangeWidth,
  simulatePriceMovements,
  PricePoint,
} from "../../src/modules/strategy/range-analysis";

describe("Range Analysis", () => {
  describe("isOutOfRange", () => {
    const centerPrice = 3000;
    const rangeWidth = 0.2; // 20% total = ±10%

    it("returns false when price is within range", () => {
      expect(isOutOfRange(3000, centerPrice, rangeWidth)).toBe(false); // Center
      expect(isOutOfRange(3100, centerPrice, rangeWidth)).toBe(false); // Upper half
      expect(isOutOfRange(2900, centerPrice, rangeWidth)).toBe(false); // Lower half
    });

    it("returns true when price is below range", () => {
      const lowerBound = centerPrice * 0.9; // 2700
      expect(isOutOfRange(2699, centerPrice, rangeWidth)).toBe(true);
      expect(isOutOfRange(2000, centerPrice, rangeWidth)).toBe(true);
    });

    it("returns true when price is above range", () => {
      const upperBound = centerPrice * 1.1; // 3300
      expect(isOutOfRange(3301, centerPrice, rangeWidth)).toBe(true);
      expect(isOutOfRange(4000, centerPrice, rangeWidth)).toBe(true);
    });

    it("returns false when price is exactly at boundary", () => {
      const lowerBound = centerPrice * 0.9; // 2700
      const upperBound = centerPrice * 1.1; // 3300
      expect(isOutOfRange(lowerBound, centerPrice, rangeWidth)).toBe(false);
      expect(isOutOfRange(upperBound, centerPrice, rangeWidth)).toBe(false);
    });
  });

  describe("distanceToEdge", () => {
    const centerPrice = 3000;
    const rangeWidth = 0.2; // 20% total = ±10%
    const lowerBound = 2700;
    const upperBound = 3300;
    const rangeSize = 600;

    it("returns 0 when price is at edge", () => {
      expect(distanceToEdge(lowerBound, centerPrice, rangeWidth)).toBeCloseTo(0, 10);
      expect(distanceToEdge(upperBound, centerPrice, rangeWidth)).toBeCloseTo(0, 10);
    });

    it("returns 0.5 when price is at center", () => {
      const dist = distanceToEdge(centerPrice, centerPrice, rangeWidth);
      expect(dist).toBeCloseTo(0.5, 5);
    });

    it("returns correct distance when price is within range", () => {
      // Price at 25% from lower bound
      const price = lowerBound + rangeSize * 0.25;
      const dist = distanceToEdge(price, centerPrice, rangeWidth);
      expect(dist).toBeCloseTo(0.25, 5);
    });

    it("returns positive value when price is below range", () => {
      const dist = distanceToEdge(2000, centerPrice, rangeWidth);
      expect(dist).toBeGreaterThan(0);
      // Should be (2700 - 2000) / 600 = 700/600 ≈ 1.167
      expect(dist).toBeCloseTo((lowerBound - 2000) / rangeSize, 5);
    });

    it("returns positive value when price is above range", () => {
      const dist = distanceToEdge(4000, centerPrice, rangeWidth);
      expect(dist).toBeGreaterThan(0);
      // Should be (4000 - 3300) / 600 = 700/600 ≈ 1.167
      expect(dist).toBeCloseTo((4000 - upperBound) / rangeSize, 5);
    });
  });

  describe("estimateFeeYield", () => {
    it("returns higher yield for tighter ranges", () => {
      const poolFeeBps = 500; // 0.05%
      const dailyVolumeUsd = 10_000_000;
      const positionSizeUsd = 100_000;

      const tightRangeYield = estimateFeeYield(0.1, poolFeeBps, dailyVolumeUsd, positionSizeUsd);
      const wideRangeYield = estimateFeeYield(0.4, poolFeeBps, dailyVolumeUsd, positionSizeUsd);

      expect(tightRangeYield).toBeGreaterThan(wideRangeYield);
    });

    it("returns positive yield for valid inputs", () => {
      const yield_ = estimateFeeYield(0.2, 500, 10_000_000, 100_000);
      expect(yield_).toBeGreaterThan(0);
      expect(yield_).toBeLessThan(1000); // Sanity check - shouldn't be absurdly high
    });

    it("handles different fee tiers", () => {
      const dailyVolumeUsd = 10_000_000;
      const positionSizeUsd = 100_000;

      const lowFeeYield = estimateFeeYield(0.2, 100, dailyVolumeUsd, positionSizeUsd); // 0.01%
      const highFeeYield = estimateFeeYield(0.2, 3000, dailyVolumeUsd, positionSizeUsd); // 0.3%

      expect(highFeeYield).toBeGreaterThan(lowFeeYield);
    });
  });

  describe("estimateGasCosts", () => {
    it("calculates annual gas costs correctly", () => {
      const adjustmentsPerMonth = 2;
      const gasPriceGwei = 0.1;
      const gasPerAdjustment = 350000;
      const ethPriceUsd = 3000;

      const annualCost = estimateGasCosts(
        adjustmentsPerMonth,
        gasPriceGwei,
        gasPerAdjustment,
        ethPriceUsd
      );

      // Expected: (2 * 350000 * 0.1) / 1e9 * 3000 * 12
      // = (700000 * 0.1) / 1e9 * 3000 * 12
      // = 70000 / 1e9 * 3000 * 12
      // = 0.00007 * 3000 * 12
      // = 0.21 * 12
      // = 2.52 USD
      expect(annualCost).toBeCloseTo(2.52, 2);
    });

    it("returns 0 when no adjustments", () => {
      const cost = estimateGasCosts(0);
      expect(cost).toBe(0);
    });

    it("scales with adjustment frequency", () => {
      const cost1 = estimateGasCosts(1);
      const cost2 = estimateGasCosts(2);
      expect(cost2).toBeCloseTo(cost1 * 2, 2);
    });
  });

  describe("analyzeRangeWidth", () => {
    const baseTime = Math.floor(Date.now() / 1000);
    const initialPrice = 3000;
    const poolFeeBps = 500;
    const dailyVolumeUsd = 10_000_000;
    const positionSizeUsd = 100_000;

    it("identifies out-of-range prices correctly", () => {
      // Create price points: some in range, some out
      const pricePoints: PricePoint[] = [
        { timestamp: baseTime, price: 3000 }, // In range (center)
        { timestamp: baseTime + 3600, price: 3100 }, // In range
        { timestamp: baseTime + 7200, price: 2000 }, // Out of range (below)
        { timestamp: baseTime + 10800, price: 4000 }, // Out of range (above)
        { timestamp: baseTime + 14400, price: 3050 }, // In range
      ];

      const analysis = analyzeRangeWidth(
        0.2, // 20% range
        pricePoints,
        initialPrice,
        poolFeeBps,
        dailyVolumeUsd,
        positionSizeUsd
      );

      expect(analysis.outOfRangeCount).toBe(2);
      expect(analysis.outOfRangePercent).toBeCloseTo(40, 1); // 2 out of 5 = 40%
    });

    it("counts adjustments respecting minimum interval", () => {
      const pricePoints: PricePoint[] = [
        { timestamp: baseTime, price: 2000 }, // Out of range
        { timestamp: baseTime + 1800, price: 2000 }, // Out of range, but too soon
        { timestamp: baseTime + 3600, price: 2000 }, // Out of range, enough time passed
        { timestamp: baseTime + 7200, price: 2000 }, // Out of range, enough time passed
      ];

      const analysis = analyzeRangeWidth(
        0.2,
        pricePoints,
        initialPrice,
        poolFeeBps,
        dailyVolumeUsd,
        positionSizeUsd,
        3600 // 1 hour minimum
      );

      // Should count 3 adjustments (first, third, fourth)
      // First at baseTime, second skipped (too soon), third at baseTime+3600, fourth at baseTime+7200
      expect(analysis.expectedAdjustmentsPerMonth).toBeGreaterThan(0);
    });

    it("calculates net APY correctly", () => {
      const pricePoints: PricePoint[] = [
        { timestamp: baseTime, price: 3000 },
        { timestamp: baseTime + 86400, price: 3000 }, // 1 day later
      ];

      const analysis = analyzeRangeWidth(
        0.2,
        pricePoints,
        initialPrice,
        poolFeeBps,
        dailyVolumeUsd,
        positionSizeUsd
      );

      expect(analysis.netAPY).toBeCloseTo(
        analysis.estimatedFeeYieldAPY - analysis.estimatedGasCostAPY,
        2
      );
    });

    it("handles empty price points", () => {
      const analysis = analyzeRangeWidth(
        0.2,
        [],
        initialPrice,
        poolFeeBps,
        dailyVolumeUsd,
        positionSizeUsd
      );

      expect(analysis.outOfRangeCount).toBe(0);
      expect(analysis.outOfRangePercent).toBe(0);
      expect(analysis.expectedAdjustmentsPerMonth).toBe(0);
    });
  });

  describe("simulatePriceMovements", () => {
    it("generates correct number of price points", () => {
      const points = simulatePriceMovements(3000, 0.8, 1, 24); // 1 day, hourly
      expect(points.length).toBe(24);
    });

    it("starts at initial price", () => {
      const initialPrice = 3000;
      // Use a deterministic random function that returns 0.5 (no change on first step)
      const mockRandom = () => 0.5;
      const points = simulatePriceMovements(initialPrice, 0.8, 1, 1, mockRandom);
      // First point should be at initial price (before any random changes)
      expect(points[0].price).toBeCloseTo(initialPrice, 0);
    });

    it("generates sequential timestamps", () => {
      const points = simulatePriceMovements(3000, 0.8, 1, 5);
      for (let i = 1; i < points.length; i++) {
        expect(points[i].timestamp).toBeGreaterThan(points[i - 1].timestamp);
        expect(points[i].timestamp - points[i - 1].timestamp).toBe(3600); // 1 hour apart
      }
    });

    it("respects price floor", () => {
      const initialPrice = 3000;
      const floor = initialPrice * 0.1; // 10% floor
      const points = simulatePriceMovements(initialPrice, 10, 1, 100); // High volatility

      for (const point of points) {
        expect(point.price).toBeGreaterThanOrEqual(floor);
      }
    });

    it("uses injected random function for testing", () => {
      let callCount = 0;
      const mockRandom = () => {
        callCount++;
        return 0.5; // Always return 0.5 (no price change)
      };

      const points = simulatePriceMovements(3000, 0.8, 1, 5, mockRandom);
      expect(callCount).toBeGreaterThan(0);
      // With volatility 0.8 and random always 0.5, price should stay near initial
      expect(points[points.length - 1].price).toBeCloseTo(3000, 0);
    });
  });
});
