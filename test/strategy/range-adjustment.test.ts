import { describe, it, expect } from "vitest";
import { RangeAdjustmentManager } from "../../src/strategy/range-adjustment";
import { DEFAULT_STRATEGY_CONFIG } from "../../src/config/strategy";
import { UniswapPosition } from "../../src/modules/uniswap/types";

describe("RangeAdjustmentManager", () => {
  const config = DEFAULT_STRATEGY_CONFIG;
  const context = {
    poolAddress: "0xPool",
    positionManager: "0xPM",
    account: "0xAccount",
    token0: "0xWETH",
    token1: "0xUSDC",
    token0Decimals: 18,
    token1Decimals: 6,
    isToken0Weth: true,
    isToken0Usdc: false,
    fee: 500,
    tickSpacing: 10,
  };

  describe("calculateNewRangeBounds", () => {
    it("should calculate bounds using default range width", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const currentPrice = 3000;

      const result = manager.calculateNewRangeBounds(currentPrice);

      // Default is 0.06 (6% = ±3%)
      expect(result.rangeWidth).toBe(0.06);
      expect(result.lower).toBeCloseTo(3000 * 0.97, 0); // 2910
      expect(result.upper).toBeCloseTo(3000 * 1.03, 0); // 3090
    });

    it("should use override range width when provided", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const currentPrice = 3000;
      const overrideWidth = 0.2; // 20% = ±10%

      const result = manager.calculateNewRangeBounds(currentPrice, overrideWidth);

      expect(result.rangeWidth).toBe(0.2);
      expect(result.lower).toBeCloseTo(3000 * 0.9, 0); // 2700
      expect(result.upper).toBeCloseTo(3000 * 1.1, 0); // 3300
    });

    it("should handle different price values", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const currentPrice = 2000;

      const result = manager.calculateNewRangeBounds(currentPrice);

      expect(result.lower).toBeLessThan(currentPrice);
      expect(result.upper).toBeGreaterThan(currentPrice);
      expect(result.lower).toBeCloseTo(2000 * 0.97, 0); // 1940
      expect(result.upper).toBeCloseTo(2000 * 1.03, 0); // 2060
    });
  });

  describe("calculateNewTicks", () => {
    it("should calculate valid ticks for given price bounds", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const priceLower = 2775;
      const priceUpper = 3225;
      const currentTick = 69080;

      const result = manager.calculateNewTicks(priceLower, priceUpper, currentTick);

      expect(result.tickLower).toBeLessThan(result.tickUpper);
      // Note: ticks can be negative in Uniswap v3, so we just check ordering
    });

    it("should round ticks according to tick spacing", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const priceLower = 2775;
      const priceUpper = 3225;
      const currentTick = 69080;

      const result = manager.calculateNewTicks(priceLower, priceUpper, currentTick);

      // Ticks should be multiples of tick spacing (10)
      // Handle negative zero quirk in JavaScript
      expect(Math.abs(result.tickLower % 10)).toBe(0);
      expect(Math.abs(result.tickUpper % 10)).toBe(0);
    });

    it("should throw error if tickLower >= tickUpper", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const priceLower = 3225; // Reversed
      const priceUpper = 2775;
      const currentTick = 69080;

      expect(() => {
        manager.calculateNewTicks(priceLower, priceUpper, currentTick);
      }).toThrow("Invalid ticks");
    });
  });

  describe("prepareAdjustment", () => {
    it("should prepare adjustment data correctly", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const positionsToClose = [
        {
          tokenId: 123n,
          position: {
            nonce: 0n,
            operator: "0xOp",
            token0: "0xWETH",
            token1: "0xUSDC",
            fee: 500,
            tickLower: 68000,
            tickUpper: 70000,
            liquidity: 1000000n,
            feeGrowthInside0LastX128: 0n,
            feeGrowthInside1LastX128: 0n,
            tokensOwed0: 0n,
            tokensOwed1: 0n,
          } as UniswapPosition,
        },
      ];
      const currentPrice = 3000;
      const currentTick = 69080;

      const result = manager.prepareAdjustment(
        positionsToClose,
        currentPrice,
        currentTick
      );

      expect(result.tokenIdsToClose).toEqual([123n]);
      expect(result.priceLower).toBeCloseTo(2910, 0); // 3000 * 0.97
      expect(result.priceUpper).toBeCloseTo(3090, 0); // 3000 * 1.03
      expect(result.rangeWidth).toBe(0.06);
      expect(result.tickLower).toBeLessThan(result.tickUpper);
    });

    it("should handle multiple positions", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const positionsToClose = [
        {
          tokenId: 123n,
          position: {
            liquidity: 1000000n,
          } as UniswapPosition,
        },
        {
          tokenId: 456n,
          position: {
            liquidity: 2000000n,
          } as UniswapPosition,
        },
      ];
      const currentPrice = 3000;
      const currentTick = 69080;

      const result = manager.prepareAdjustment(
        positionsToClose,
        currentPrice,
        currentTick
      );

      expect(result.tokenIdsToClose).toEqual([123n, 456n]);
      expect(result.tokenIdsToClose.length).toBe(2);
    });

    it("should use override range width when provided", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const positionsToClose = [
        {
          tokenId: 123n,
          position: {
            liquidity: 1000000n,
          } as UniswapPosition,
        },
      ];
      const currentPrice = 3000;
      const currentTick = 69080;
      const overrideWidth = 0.2;

      const result = manager.prepareAdjustment(
        positionsToClose,
        currentPrice,
        currentTick,
        overrideWidth
      );

      expect(result.rangeWidth).toBe(0.2);
      expect(result.priceLower).toBeCloseTo(2700, 0);
      expect(result.priceUpper).toBeCloseTo(3300, 0);
    });
  });

  describe("validateAdjustment", () => {
    it("should return valid for positions with liquidity", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const positionsToClose = [
        {
          tokenId: 123n,
          position: {
            liquidity: 1000000n,
          } as UniswapPosition,
        },
      ];
      const currentPrice = 3000;

      const result = manager.validateAdjustment(positionsToClose, currentPrice);

      expect(result.valid).toBe(true);
    });

    it("should return invalid for empty positions list", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const positionsToClose: { tokenId: bigint; position: UniswapPosition }[] = [];
      const currentPrice = 3000;

      const result = manager.validateAdjustment(positionsToClose, currentPrice);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("No positions to adjust");
    });

    it("should return invalid for positions without liquidity", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const positionsToClose = [
        {
          tokenId: 123n,
          position: {
            liquidity: 0n,
          } as UniswapPosition,
        },
      ];
      const currentPrice = 3000;

      const result = manager.validateAdjustment(positionsToClose, currentPrice);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("No positions with liquidity");
    });

    it("should return valid for mixed positions (some with liquidity)", () => {
      const manager = new RangeAdjustmentManager(config, context);
      const positionsToClose = [
        {
          tokenId: 123n,
          position: {
            liquidity: 0n,
          } as UniswapPosition,
        },
        {
          tokenId: 456n,
          position: {
            liquidity: 1000000n,
          } as UniswapPosition,
        },
      ];
      const currentPrice = 3000;

      const result = manager.validateAdjustment(positionsToClose, currentPrice);

      expect(result.valid).toBe(true);
    });
  });
});
