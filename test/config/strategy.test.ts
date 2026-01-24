import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_STRATEGY_CONFIG,
  loadStrategyConfig,
  validateStrategyConfig,
  StrategyConfig,
  PRECISION,
} from "../../src/config/strategy";

describe("Strategy Configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original process.env
    process.env = originalEnv;
  });

  describe("DEFAULT_STRATEGY_CONFIG", () => {
    it("should have all required configuration properties", () => {
      const requiredKeys: (keyof StrategyConfig)[] = [
        "deltaThreshold",
        "emergencyThreshold",
        "minRebalanceInterval",
        "maxRebalanceInterval",
        "minCompoundInterval",
        "minRangeAdjustmentInterval",
        "maxLeverage",
        "minPositionSizeUsd",
        "maxSlippage",
        "slippageBuffer",
        "minFeeThresholdUsd",
        "defaultExecutionFee",
        "rangeAdjustmentThreshold",
        "rangeCenterDriftThreshold",
        "defaultRangeWidth",
        "minRangeWidth",
        "maxRangeWidth",
        "targetLeverage",
      ];

      for (const key of requiredKeys) {
        expect(DEFAULT_STRATEGY_CONFIG).toHaveProperty(key);
      }
    });

    it("should have valid default values", () => {
      expect(DEFAULT_STRATEGY_CONFIG.deltaThreshold).toBe(0.05);
      expect(DEFAULT_STRATEGY_CONFIG.emergencyThreshold).toBe(0.20);
      expect(DEFAULT_STRATEGY_CONFIG.maxLeverage).toBe(3.0);
      expect(DEFAULT_STRATEGY_CONFIG.targetLeverage).toBe(3.0);
      expect(DEFAULT_STRATEGY_CONFIG.minRebalanceInterval).toBe(3600);
      expect(DEFAULT_STRATEGY_CONFIG.defaultRangeWidth).toBe(0.15);
    });

    it("should have bigint values for USD amounts", () => {
      expect(typeof DEFAULT_STRATEGY_CONFIG.minPositionSizeUsd).toBe("bigint");
      expect(typeof DEFAULT_STRATEGY_CONFIG.minFeeThresholdUsd).toBe("bigint");
      expect(typeof DEFAULT_STRATEGY_CONFIG.defaultExecutionFee).toBe("bigint");
      expect(DEFAULT_STRATEGY_CONFIG.minPositionSizeUsd).toBeGreaterThan(0n);
      expect(DEFAULT_STRATEGY_CONFIG.minFeeThresholdUsd).toBeGreaterThan(0n);
      expect(DEFAULT_STRATEGY_CONFIG.defaultExecutionFee).toBeGreaterThan(0n);
    });
  });

  describe("loadStrategyConfig", () => {
    it("should return default config when no overrides provided", () => {
      const config = loadStrategyConfig();
      expect(config).toEqual(DEFAULT_STRATEGY_CONFIG);
    });

    it("should apply programmatic overrides", () => {
      const overrides: Partial<StrategyConfig> = {
        deltaThreshold: 0.1,
        maxLeverage: 5.0,
      };
      const config = loadStrategyConfig(overrides);
      expect(config.deltaThreshold).toBe(0.1);
      expect(config.maxLeverage).toBe(5.0);
      expect(config.emergencyThreshold).toBe(DEFAULT_STRATEGY_CONFIG.emergencyThreshold);
    });

    it("should load from environment variables", () => {
      process.env.DELTA_THRESHOLD = "0.08";
      process.env.MAX_LEVERAGE = "4.0";
      process.env.MIN_REBALANCE_INTERVAL = "7200";

      const config = loadStrategyConfig();
      expect(config.deltaThreshold).toBe(0.08);
      expect(config.maxLeverage).toBe(4.0);
      expect(config.minRebalanceInterval).toBe(7200);
    });

    it("should prioritize programmatic overrides over environment variables", () => {
      process.env.DELTA_THRESHOLD = "0.08";
      const config = loadStrategyConfig({ deltaThreshold: 0.1 });
      expect(config.deltaThreshold).toBe(0.1);
    });

    it("should parse USD values from environment correctly", () => {
      process.env.MIN_POSITION_SIZE_USD = "2000";
      process.env.MIN_FEE_THRESHOLD_USD = "20";

      const config = loadStrategyConfig();
      // Values should be in 30 decimals
      expect(config.minPositionSizeUsd).toBeGreaterThan(0n);
      expect(config.minFeeThresholdUsd).toBeGreaterThan(0n);
    });
  });

  describe("validateStrategyConfig", () => {
    it("should accept valid default configuration", () => {
      expect(() => validateStrategyConfig(DEFAULT_STRATEGY_CONFIG)).not.toThrow();
    });

    it("should reject invalid delta threshold", () => {
      const invalid = { ...DEFAULT_STRATEGY_CONFIG, deltaThreshold: 1.5 };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject emergency threshold less than delta threshold", () => {
      const invalid = {
        ...DEFAULT_STRATEGY_CONFIG,
        deltaThreshold: 0.1,
        emergencyThreshold: 0.05,
      };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject invalid intervals", () => {
      const invalid = { ...DEFAULT_STRATEGY_CONFIG, minRebalanceInterval: -1 };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject max interval less than min interval", () => {
      const invalid = {
        ...DEFAULT_STRATEGY_CONFIG,
        minRebalanceInterval: 1000,
        maxRebalanceInterval: 500,
      };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject invalid leverage", () => {
      const invalid = { ...DEFAULT_STRATEGY_CONFIG, maxLeverage: 100 };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject target leverage greater than max leverage", () => {
      const invalid = {
        ...DEFAULT_STRATEGY_CONFIG,
        maxLeverage: 3.0,
        targetLeverage: 5.0,
      };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject invalid slippage", () => {
      const invalid = { ...DEFAULT_STRATEGY_CONFIG, maxSlippage: 1.5 };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject invalid range width", () => {
      const invalid = { ...DEFAULT_STRATEGY_CONFIG, defaultRangeWidth: 1.5 };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject min range width greater than default", () => {
      const invalid = {
        ...DEFAULT_STRATEGY_CONFIG,
        minRangeWidth: 0.3,
        defaultRangeWidth: 0.2,
      };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject max range width less than default", () => {
      const invalid = {
        ...DEFAULT_STRATEGY_CONFIG,
        maxRangeWidth: 0.1,
        defaultRangeWidth: 0.2,
      };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });

    it("should reject zero or negative bigint values", () => {
      const invalid = {
        ...DEFAULT_STRATEGY_CONFIG,
        minPositionSizeUsd: 0n,
      };
      expect(() => validateStrategyConfig(invalid)).toThrow();
    });
  });

  describe("PRECISION constants", () => {
    it("should have correct precision values", () => {
      expect(PRECISION.STANDARD).toBe(BigInt(10 ** 18));
      expect(PRECISION.GMX_USD).toBe(BigInt(10 ** 30));
      expect(PRECISION.Q96).toBe(BigInt(2) ** BigInt(96));
    });
  });
});
