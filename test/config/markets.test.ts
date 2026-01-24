import { describe, it, expect } from "vitest";
import {
  getMarketConfig,
  getDefaultRangeBounds,
  validateRangeWidth,
  MarketConfig,
} from "../../src/config/markets";
import { ARBITRUM_MAINNET } from "../../src/config/addresses";

describe("Markets Configuration", () => {
  describe("getMarketConfig", () => {
    it("should return valid market configuration", () => {
      const config = getMarketConfig(ARBITRUM_MAINNET);

      expect(config.baseToken).toBe(ARBITRUM_MAINNET.weth);
      expect(config.quoteToken).toBe(ARBITRUM_MAINNET.usdc);
      expect(config.uniswapPool).toBe(ARBITRUM_MAINNET.uniswapV3EthUsdcPool);
      expect(config.gmxMarket).toBe(ARBITRUM_MAINNET.gmxEthUsdMarket);
      expect(config.chainlinkFeed).toBe(ARBITRUM_MAINNET.chainlinkEthUsdFeed);
    });

    it("should have correct fee tier", () => {
      const config = getMarketConfig(ARBITRUM_MAINNET);
      expect(config.uniswapFeeTier).toBe(500); // 0.05%
    });

    it("should have correct token decimals", () => {
      const config = getMarketConfig(ARBITRUM_MAINNET);
      expect(config.baseTokenDecimals).toBe(18); // WETH
      expect(config.quoteTokenDecimals).toBe(6); // USDC
    });

    it("should return configuration matching MarketConfig interface", () => {
      const config = getMarketConfig(ARBITRUM_MAINNET);
      const requiredKeys: (keyof MarketConfig)[] = [
        "baseToken",
        "quoteToken",
        "uniswapPool",
        "uniswapFeeTier",
        "gmxMarket",
        "chainlinkFeed",
        "baseTokenDecimals",
        "quoteTokenDecimals",
      ];

      for (const key of requiredKeys) {
        expect(config).toHaveProperty(key);
      }
    });
  });

  describe("getDefaultRangeBounds", () => {
    it("should calculate correct range bounds for default width", () => {
      const price = 3000;
      const bounds = getDefaultRangeBounds(price);

      // Default width is 0.2 (20%), so ±10% on each side
      expect(bounds.lower).toBeCloseTo(2700, 0); // 3000 * 0.9
      expect(bounds.upper).toBeCloseTo(3300, 0); // 3000 * 1.1
    });

    it("should calculate correct range bounds for custom width", () => {
      const price = 3000;
      const bounds = getDefaultRangeBounds(price, 0.4); // 40% width

      // 40% width = ±20% on each side
      expect(bounds.lower).toBeCloseTo(2400, 0); // 3000 * 0.8
      expect(bounds.upper).toBeCloseTo(3600, 0); // 3000 * 1.2
    });

    it("should handle different price values", () => {
      const price = 2000;
      const bounds = getDefaultRangeBounds(price, 0.2);

      expect(bounds.lower).toBeCloseTo(1800, 0);
      expect(bounds.upper).toBeCloseTo(2200, 0);
    });

    it("should ensure lower < upper", () => {
      const price = 1000;
      const bounds = getDefaultRangeBounds(price);
      expect(bounds.lower).toBeLessThan(bounds.upper);
    });
  });

  describe("validateRangeWidth", () => {
    it("should accept valid range width", () => {
      expect(() => validateRangeWidth(0.2)).not.toThrow();
      expect(() => validateRangeWidth(0.1)).not.toThrow();
      expect(() => validateRangeWidth(0.4)).not.toThrow();
    });

    it("should reject range width below minimum", () => {
      expect(() => validateRangeWidth(0.05)).toThrow();
    });

    it("should reject range width above maximum", () => {
      expect(() => validateRangeWidth(0.5)).toThrow();
    });

    it("should accept custom min/max bounds", () => {
      expect(() => validateRangeWidth(0.15, 0.1, 0.3)).not.toThrow();
      expect(() => validateRangeWidth(0.05, 0.1, 0.3)).toThrow();
      expect(() => validateRangeWidth(0.35, 0.1, 0.3)).toThrow();
    });

    it("should throw descriptive error messages", () => {
      expect(() => validateRangeWidth(0.05)).toThrow(/below minimum/);
      expect(() => validateRangeWidth(0.5)).toThrow(/above maximum/);
    });
  });
});
