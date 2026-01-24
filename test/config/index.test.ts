import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import {
  loadConfig,
  loadConfigSync,
  AppConfig,
  ConfigOptions,
} from "../../src/config/index";
import { DEFAULT_STRATEGY_CONFIG } from "../../src/config/strategy";
import { ARBITRUM_MAINNET } from "../../src/config/addresses";

describe("Configuration System Integration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("loadConfigSync", () => {
    it("should load complete configuration", () => {
      const config = loadConfigSync();

      expect(config.addresses).toBeDefined();
      expect(config.strategy).toBeDefined();
      expect(config.market).toBeDefined();
      expect(config.chainId).toBe(42161);
    });

    it("should use provided chain ID", () => {
      const config = loadConfigSync(42161);
      expect(config.chainId).toBe(42161);
    });

    it("should apply strategy overrides", () => {
      const overrides = { deltaThreshold: 0.1 };
      const config = loadConfigSync(42161, overrides);

      expect(config.strategy.deltaThreshold).toBe(0.1);
      expect(config.strategy.emergencyThreshold).toBe(DEFAULT_STRATEGY_CONFIG.emergencyThreshold);
    });

    it("should return valid AppConfig structure", () => {
      const config = loadConfigSync();
      const requiredKeys: (keyof AppConfig)[] = [
        "addresses",
        "strategy",
        "market",
        "chainId",
      ];

      for (const key of requiredKeys) {
        expect(config).toHaveProperty(key);
      }
    });

    it("should have matching addresses and market config", () => {
      const config = loadConfigSync();

      expect(config.market.baseToken).toBe(config.addresses.weth);
      expect(config.market.quoteToken).toBe(config.addresses.usdc);
      expect(config.market.uniswapPool).toBe(config.addresses.uniswapV3EthUsdcPool);
      expect(config.market.gmxMarket).toBe(config.addresses.gmxEthUsdMarket);
    });
  });

  describe("loadConfig", () => {
    it("should load configuration without provider (defaults to Arbitrum)", async () => {
      const config = await loadConfig();

      expect(config.chainId).toBe(42161);
      expect(config.addresses).toEqual(ARBITRUM_MAINNET);
    });

    it("should use provided chain ID", async () => {
      const config = await loadConfig({ chainId: 42161 });

      expect(config.chainId).toBe(42161);
    });

    it("should detect chain ID from provider", async () => {
      // Create a mock provider that returns Arbitrum network
      const mockProvider = {
        getNetwork: async () => ({
          chainId: BigInt(42161),
        }),
      } as unknown as ethers.Provider;

      const config = await loadConfig({ provider: mockProvider });

      expect(config.chainId).toBe(42161);
    });

    it("should apply strategy overrides", async () => {
      const overrides = { maxLeverage: 5.0 };
      const config = await loadConfig({ strategyOverrides: overrides });

      expect(config.strategy.maxLeverage).toBe(5.0);
    });

    it("should validate configuration on load", async () => {
      const invalidOverrides = {
        deltaThreshold: 1.5, // Invalid: > 1
      };

      await expect(
        loadConfig({ strategyOverrides: invalidOverrides })
      ).rejects.toThrow();
    });

    it("should respect environment variable overrides", async () => {
      process.env.DELTA_THRESHOLD = "0.08";
      process.env.MAX_LEVERAGE = "4.0";

      const config = await loadConfig();

      expect(config.strategy.deltaThreshold).toBe(0.08);
      expect(config.strategy.maxLeverage).toBe(4.0);
    });

    it("should prioritize programmatic overrides over environment", async () => {
      process.env.DELTA_THRESHOLD = "0.08";

      const config = await loadConfig({
        strategyOverrides: { deltaThreshold: 0.1 },
      });

      expect(config.strategy.deltaThreshold).toBe(0.1);
    });
  });

  describe("Configuration consistency", () => {
    it("should have consistent addresses across config", async () => {
      const config = await loadConfig();

      // Verify all addresses are valid
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      expect(config.addresses.usdc).toMatch(addressRegex);
      expect(config.addresses.weth).toMatch(addressRegex);
      expect(config.market.baseToken).toMatch(addressRegex);
      expect(config.market.quoteToken).toMatch(addressRegex);
    });

    it("should have valid strategy thresholds", async () => {
      const config = await loadConfig();

      expect(config.strategy.deltaThreshold).toBeGreaterThan(0);
      expect(config.strategy.deltaThreshold).toBeLessThan(1);
      expect(config.strategy.emergencyThreshold).toBeGreaterThan(
        config.strategy.deltaThreshold
      );
    });

    it("should have valid timing intervals", async () => {
      const config = await loadConfig();

      expect(config.strategy.minRebalanceInterval).toBeGreaterThan(0);
      expect(config.strategy.maxRebalanceInterval).toBeGreaterThan(
        config.strategy.minRebalanceInterval
      );
      expect(config.strategy.minCompoundInterval).toBeGreaterThan(0);
      expect(config.strategy.minRangeAdjustmentInterval).toBeGreaterThan(0);
    });

    it("should have valid leverage settings", async () => {
      const config = await loadConfig();

      expect(config.strategy.maxLeverage).toBeGreaterThan(0);
      expect(config.strategy.maxLeverage).toBeLessThanOrEqual(50);
      expect(config.strategy.targetLeverage).toBeGreaterThan(0);
      expect(config.strategy.targetLeverage).toBeLessThanOrEqual(
        config.strategy.maxLeverage
      );
    });

    it("should have valid range parameters", async () => {
      const config = await loadConfig();

      expect(config.strategy.defaultRangeWidth).toBeGreaterThan(0);
      expect(config.strategy.defaultRangeWidth).toBeLessThan(1);
      expect(config.strategy.minRangeWidth).toBeLessThan(
        config.strategy.defaultRangeWidth
      );
      expect(config.strategy.maxRangeWidth).toBeGreaterThan(
        config.strategy.defaultRangeWidth
      );
    });
  });
});
