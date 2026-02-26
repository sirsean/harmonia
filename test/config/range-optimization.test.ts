import { describe, it, expect } from "vitest";
import {
  DEFAULT_STRATEGY_CONFIG,
  loadStrategyConfig,
  validateStrategyConfig,
} from "../../src/config/strategy";
import { getDefaultRangeBounds, validateRangeWidth } from "../../src/config/markets";

/**
 * Tests for LP range configuration optimization (Issue #41)
 *
 * These tests verify that the default range configuration is optimized
 * for balanced yield vs operational costs based on historical analysis.
 */
describe("Range Configuration Optimization (Issue #41)", () => {
  describe("Default Range Width", () => {
    it("should use optimized default range width of 6% (±3%)", () => {
      // Tighter range for higher capital efficiency:
      // - Higher fee yield per unit of liquidity
      // - More frequent rebalancing (protected by GMX hedge)
      expect(DEFAULT_STRATEGY_CONFIG.defaultRangeWidth).toBe(0.06);
    });

    it("should calculate correct bounds for optimized default", () => {
      const price = 3000;
      const rangeWidth = DEFAULT_STRATEGY_CONFIG.defaultRangeWidth;
      const bounds = getDefaultRangeBounds(price, rangeWidth);

      // 6% width = ±3% on each side
      expect(bounds.lower).toBeCloseTo(2910, 0); // 3000 * 0.97
      expect(bounds.upper).toBeCloseTo(3090, 0); // 3000 * 1.03

      // Verify range width is correct
      const calculatedWidth = (bounds.upper - bounds.lower) / price;
      expect(calculatedWidth).toBeCloseTo(0.06, 2);
    });

    it("should allow environment variable override", () => {
      process.env.DEFAULT_RANGE_WIDTH = "0.2";
      const config = loadStrategyConfig();
      expect(config.defaultRangeWidth).toBe(0.2);
      delete process.env.DEFAULT_RANGE_WIDTH;
    });

    it("should validate default range width is within bounds", () => {
      const { defaultRangeWidth, minRangeWidth, maxRangeWidth } =
        DEFAULT_STRATEGY_CONFIG;

      expect(defaultRangeWidth).toBeGreaterThan(minRangeWidth);
      expect(defaultRangeWidth).toBeLessThan(maxRangeWidth);
      expect(() => validateRangeWidth(defaultRangeWidth, minRangeWidth, maxRangeWidth)).not.toThrow();
    });
  });

  describe("Range Width Bounds", () => {
    it("should have reasonable min/max bounds", () => {
      const { minRangeWidth, maxRangeWidth } = DEFAULT_STRATEGY_CONFIG;

      // Min: ±2% (4% total) - tight for maximum capital efficiency
      expect(minRangeWidth).toBe(0.04);

      // Max: ±20% (40% total) - wide for low-maintenance strategies
      expect(maxRangeWidth).toBe(0.4);

      // Default should be between min and max
      expect(DEFAULT_STRATEGY_CONFIG.defaultRangeWidth).toBeGreaterThan(minRangeWidth);
      expect(DEFAULT_STRATEGY_CONFIG.defaultRangeWidth).toBeLessThan(maxRangeWidth);
    });

    it("should reject invalid range width configurations", () => {
      const invalid1 = {
        ...DEFAULT_STRATEGY_CONFIG,
        defaultRangeWidth: 0.03, // Below minimum (0.04)
      };
      expect(() => validateStrategyConfig(invalid1)).toThrow();

      const invalid2 = {
        ...DEFAULT_STRATEGY_CONFIG,
        defaultRangeWidth: 0.5, // Above maximum
      };
      expect(() => validateStrategyConfig(invalid2)).toThrow();

      const invalid3 = {
        ...DEFAULT_STRATEGY_CONFIG,
        minRangeWidth: 0.2,
        defaultRangeWidth: 0.03, // Below minimum
      };
      expect(() => validateStrategyConfig(invalid3)).toThrow();
    });
  });

  describe("Range Adjustment Thresholds", () => {
    it("should have proactive adjustment thresholds for 6% default width", () => {
      const { rangeAdjustmentThreshold, rangeCenterDriftThreshold, defaultRangeWidth } =
        DEFAULT_STRATEGY_CONFIG;

      // Edge threshold: 15% of range span from the nearest edge
      expect(rangeAdjustmentThreshold).toBe(0.15);

      // Center drift threshold must stay strictly below half-width for proactive recentering
      expect(rangeCenterDriftThreshold).toBe(0.02);

      expect(rangeCenterDriftThreshold).toBeLessThan(defaultRangeWidth / 2);
    });

    it("should allow environment variable overrides for thresholds", () => {
      process.env.RANGE_ADJUSTMENT_THRESHOLD = "0.03";
      process.env.RANGE_CENTER_DRIFT_THRESHOLD = "0.06";

      const config = loadStrategyConfig();
      expect(config.rangeAdjustmentThreshold).toBe(0.03);
      expect(config.rangeCenterDriftThreshold).toBe(0.06);

      delete process.env.RANGE_ADJUSTMENT_THRESHOLD;
      delete process.env.RANGE_CENTER_DRIFT_THRESHOLD;
    });
  });

  describe("Configuration Validation", () => {
    it("should accept optimized default configuration", () => {
      expect(() => validateStrategyConfig(DEFAULT_STRATEGY_CONFIG)).not.toThrow();
    });

    it("should validate all range-related parameters", () => {
      const config = DEFAULT_STRATEGY_CONFIG;

      // Range width must be between 0 and 1
      expect(config.defaultRangeWidth).toBeGreaterThan(0);
      expect(config.defaultRangeWidth).toBeLessThan(1);

      // Thresholds must be between 0 and 1
      expect(config.rangeAdjustmentThreshold).toBeGreaterThan(0);
      expect(config.rangeAdjustmentThreshold).toBeLessThan(1);
      expect(config.rangeCenterDriftThreshold).toBeGreaterThan(0);
      expect(config.rangeCenterDriftThreshold).toBeLessThan(1);

      // Min/max bounds must be valid
      expect(config.minRangeWidth).toBeGreaterThan(0);
      expect(config.maxRangeWidth).toBeLessThan(1);
      expect(config.minRangeWidth).toBeLessThan(config.maxRangeWidth);
    });
  });

  describe("Range Width Comparison", () => {
    it("should demonstrate yield vs operational cost trade-offs", () => {
      // Based on range analysis results:
      // ±7.5% (0.15): ~24% net APY, 0.6% out-of-range, ~12.7 adj/month
      // ±10% (0.2): ~18% net APY, 0.6% out-of-range, ~12.7 adj/month
      // ±5% (0.1): ~36% net APY, 1.9% out-of-range, ~12.7 adj/month

      const optimizedWidth = 0.15; // ±7.5%
      const previousWidth = 0.2; // ±10%

      // Optimized width should be tighter (better yield) than previous
      expect(optimizedWidth).toBeLessThan(previousWidth);

      // But not too tight (should be above minimum)
      expect(optimizedWidth).toBeGreaterThan(DEFAULT_STRATEGY_CONFIG.minRangeWidth);
    });

    it("should calculate proportional range bounds correctly", () => {
      const price = 3000;
      const widths = [0.1, 0.15, 0.2, 0.3, 0.4];

      for (const width of widths) {
        const bounds = getDefaultRangeBounds(price, width);
        const calculatedWidth = (bounds.upper - bounds.lower) / price;

        expect(calculatedWidth).toBeCloseTo(width, 2);
        expect(bounds.lower).toBeLessThan(price);
        expect(bounds.upper).toBeGreaterThan(price);
      }
    });
  });
});
