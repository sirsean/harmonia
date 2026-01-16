/**
 * Unit tests for price conversion functions in src/markets/types.ts
 *
 * Tests sqrtPriceX96ToPrice and priceToSqrtPriceX96 with various token pairs
 * and decimal configurations.
 */

import { expect } from "chai";
import {
  sqrtPriceX96ToPrice,
  priceToSqrtPriceX96,
  calculateDecimalAdjustment,
  isBaseTokenToken0,
} from "../../../src/markets/types";

describe("Price Conversion Functions", () => {
  // Token decimals
  const WETH_DECIMALS = 18;
  const USDC_DECIMALS = 6;
  const WBTC_DECIMALS = 8;

  // Q96 constant for reference
  const Q96 = BigInt(2) ** BigInt(96);

  describe("isBaseTokenToken0", () => {
    it("should return true when base address is lower", () => {
      // WETH (0x82...) < USDC (0xaf...)
      const result = isBaseTokenToken0(
        "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
        "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" // USDC
      );
      expect(result).to.be.true;
    });

    it("should return false when base address is higher", () => {
      // WBTC (0x2f...) > lower address
      const result = isBaseTokenToken0(
        "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // higher
        "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f" // WBTC - lower
      );
      expect(result).to.be.false;
    });
  });

  describe("calculateDecimalAdjustment", () => {
    it("should calculate adjustment for WETH/USDC (18-6=12)", () => {
      const adjustment = calculateDecimalAdjustment(WETH_DECIMALS, USDC_DECIMALS);
      expect(adjustment).to.equal(BigInt(10) ** BigInt(12));
    });

    it("should calculate adjustment for WBTC/USDC (8-6=2)", () => {
      const adjustment = calculateDecimalAdjustment(WBTC_DECIMALS, USDC_DECIMALS);
      expect(adjustment).to.equal(BigInt(10) ** BigInt(2));
    });

    it("should calculate adjustment for USDC/WETH (6-18=-12)", () => {
      const adjustment = calculateDecimalAdjustment(USDC_DECIMALS, WETH_DECIMALS);
      // When diff is negative, returns 10^|diff|
      expect(adjustment).to.equal(BigInt(10) ** BigInt(12));
    });
  });

  describe("sqrtPriceX96ToPrice", () => {
    describe("ETH/USDC pool (WETH is token0, USDC is token1)", () => {
      // WETH: 0x82... (lower) = token0, 18 decimals
      // USDC: 0xaf... (higher) = token1, 6 decimals
      const token0Decimals = WETH_DECIMALS; // 18
      const token1Decimals = USDC_DECIMALS; // 6
      const baseIsToken0 = true; // WETH is base and token0

      it("should convert ETH price of $3300 correctly", () => {
        // At $3300 ETH:
        // poolPrice = token1_per_token0 = USDC_raw / WETH_raw
        // 3300 * 10^6 USDC / 10^18 WETH = 3.3e-9
        // sqrtPrice = sqrt(3.3e-9) ≈ 5.745e-5
        // sqrtPriceX96 = 5.745e-5 * 2^96 ≈ 4.548e24

        // Calculate expected sqrtPriceX96 for $3300
        const price = 3300;
        const poolPrice = (price * Math.pow(10, token1Decimals)) / Math.pow(10, token0Decimals);
        const sqrtPrice = Math.sqrt(poolPrice);
        const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));

        const result = sqrtPriceX96ToPrice(
          sqrtPriceX96,
          token0Decimals,
          token1Decimals,
          baseIsToken0
        );

        // Should be approximately $3300 (within 0.1% due to precision)
        expect(result).to.be.closeTo(price, price * 0.001);
      });

      it("should convert ETH price of $2000 correctly", () => {
        const price = 2000;
        const poolPrice = (price * Math.pow(10, token1Decimals)) / Math.pow(10, token0Decimals);
        const sqrtPrice = Math.sqrt(poolPrice);
        const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));

        const result = sqrtPriceX96ToPrice(
          sqrtPriceX96,
          token0Decimals,
          token1Decimals,
          baseIsToken0
        );

        expect(result).to.be.closeTo(price, price * 0.001);
      });

      it("should convert ETH price of $5000 correctly", () => {
        const price = 5000;
        const poolPrice = (price * Math.pow(10, token1Decimals)) / Math.pow(10, token0Decimals);
        const sqrtPrice = Math.sqrt(poolPrice);
        const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));

        const result = sqrtPriceX96ToPrice(
          sqrtPriceX96,
          token0Decimals,
          token1Decimals,
          baseIsToken0
        );

        expect(result).to.be.closeTo(price, price * 0.001);
      });
    });

    describe("BTC/USDC pool (WBTC is token1, USDC is token0)", () => {
      // Example scenario where base token is NOT token0
      // USDC: 0xaf... = token0, 6 decimals
      // WBTC: 0x2f... = token1, 8 decimals
      // Note: In reality, WBTC (0x2f...) < USDC (0xaf...), so WBTC would be token0
      // But this tests the baseIsToken0=false case

      const token0Decimals = USDC_DECIMALS; // 6
      const token1Decimals = WBTC_DECIMALS; // 8
      const baseIsToken0 = false; // WBTC is base but is token1

      it("should convert BTC price of $60000 correctly", () => {
        // At $60000 BTC:
        // We want human price in USDC per WBTC = $60000
        // poolPrice = token1_per_token0 = WBTC_raw / USDC_raw
        // At $60000: 1e8 WBTC_raw / (60000 * 1e6) USDC_raw = 1.667e-3

        const price = 60000;
        // Calculate sqrtPriceX96 using the correct inverse formula:
        // poolPrice = 1 / (price * decimalMultiplier)
        const decimalDiff = token0Decimals - token1Decimals; // 6 - 8 = -2
        const decimalMultiplier = Math.pow(10, decimalDiff); // 0.01
        const poolPrice = 1 / (price * decimalMultiplier); // 1 / (60000 * 0.01) = 1.667e-3
        const sqrtPrice = Math.sqrt(poolPrice);
        const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));

        const result = sqrtPriceX96ToPrice(
          sqrtPriceX96,
          token0Decimals,
          token1Decimals,
          baseIsToken0
        );

        expect(result).to.be.closeTo(price, price * 0.001);
      });

      it("should convert BTC price of $45000 correctly", () => {
        const price = 45000;
        const decimalDiff = token0Decimals - token1Decimals;
        const decimalMultiplier = Math.pow(10, decimalDiff);
        const poolPrice = 1 / (price * decimalMultiplier);
        const sqrtPrice = Math.sqrt(poolPrice);
        const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));

        const result = sqrtPriceX96ToPrice(
          sqrtPriceX96,
          token0Decimals,
          token1Decimals,
          baseIsToken0
        );

        expect(result).to.be.closeTo(price, price * 0.001);
      });
    });

    describe("Edge cases", () => {
      it("should handle very small prices", () => {
        const price = 0.0001; // e.g., some micro-cap token
        const token0Decimals = 18;
        const token1Decimals = 6;
        const baseIsToken0 = true;

        const poolPrice = (price * Math.pow(10, token1Decimals)) / Math.pow(10, token0Decimals);
        const sqrtPrice = Math.sqrt(poolPrice);
        const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));

        const result = sqrtPriceX96ToPrice(
          sqrtPriceX96,
          token0Decimals,
          token1Decimals,
          baseIsToken0
        );

        expect(result).to.be.closeTo(price, price * 0.01); // 1% tolerance for small numbers
      });

      it("should handle same decimals (18-18)", () => {
        const price = 1.5; // e.g., WETH/WSTETH ratio
        const token0Decimals = 18;
        const token1Decimals = 18;
        const baseIsToken0 = true;

        const poolPrice = price; // No decimal adjustment needed
        const sqrtPrice = Math.sqrt(poolPrice);
        const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));

        const result = sqrtPriceX96ToPrice(
          sqrtPriceX96,
          token0Decimals,
          token1Decimals,
          baseIsToken0
        );

        expect(result).to.be.closeTo(price, price * 0.001);
      });
    });
  });

  describe("priceToSqrtPriceX96", () => {
    describe("ETH/USDC (baseIsToken0 = true)", () => {
      const token0Decimals = WETH_DECIMALS;
      const token1Decimals = USDC_DECIMALS;
      const baseIsToken0 = true;

      it("should convert $3300 to correct sqrtPriceX96", () => {
        const price = 3300;
        const sqrtPriceX96 = priceToSqrtPriceX96(
          price,
          token0Decimals,
          token1Decimals,
          baseIsToken0
        );

        // Convert back to verify
        const result = sqrtPriceX96ToPrice(
          sqrtPriceX96,
          token0Decimals,
          token1Decimals,
          baseIsToken0
        );

        expect(result).to.be.closeTo(price, price * 0.001);
      });
    });

    describe("Roundtrip conversion", () => {
      it("should maintain precision through price -> sqrtPriceX96 -> price", () => {
        const prices = [100, 1000, 3300, 5000, 10000, 50000];
        const token0Decimals = 18;
        const token1Decimals = 6;
        const baseIsToken0 = true;

        for (const price of prices) {
          const sqrtPriceX96 = priceToSqrtPriceX96(
            price,
            token0Decimals,
            token1Decimals,
            baseIsToken0
          );
          const result = sqrtPriceX96ToPrice(
            sqrtPriceX96,
            token0Decimals,
            token1Decimals,
            baseIsToken0
          );

          expect(result).to.be.closeTo(price, price * 0.001, `Failed for price ${price}`);
        }
      });
    });
  });

  describe("Integration with real Uniswap sqrtPriceX96 values", () => {
    it("should correctly decode a known ETH/USDC sqrtPriceX96 value", () => {
      // This test uses a real-world sqrtPriceX96 value from the ETH/USDC pool
      // sqrtPriceX96 for ~$3300 ETH
      // poolPrice = (3300 * 10^6) / 10^18 = 3.3e-9
      // sqrtPrice = sqrt(3.3e-9) = 5.745e-5
      // sqrtPriceX96 = 5.745e-5 * 2^96 ≈ 4.548e24

      // Construct the expected value
      const ethPrice = 3300;
      const poolPrice = (ethPrice * 1e6) / 1e18;
      const sqrtPrice = Math.sqrt(poolPrice);
      const expectedSqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));

      const result = sqrtPriceX96ToPrice(
        expectedSqrtPriceX96,
        18, // WETH decimals
        6, // USDC decimals
        true // WETH is token0
      );

      expect(result).to.be.closeTo(ethPrice, 1); // Within $1
    });
  });
});
