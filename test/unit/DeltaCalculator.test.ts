import { expect } from "chai";
import { ethers } from "hardhat";
import { DeltaCalculatorHarness } from "../../typechain-types";

describe("DeltaCalculator", function () {
  let deltaCalculator: DeltaCalculatorHarness;

  // Constants
  const Q96 = BigInt(2) ** BigInt(96);
  const PRECISION = BigInt(10) ** BigInt(18);

  // Helper to create sqrtPriceX96 from a human-readable price
  // For ETH/USDC where ETH is token0 and USDC is token1
  // Price represents USDC per ETH (e.g., 2000 means 1 ETH = 2000 USDC)
  function priceToSqrtX96(price: number): bigint {
    // sqrtPriceX96 = sqrt(price) * 2^96
    // We need to account for decimal differences: ETH (18 decimals) vs USDC (6 decimals)
    // Actual price in the pool = (USDC amount / 10^6) / (ETH amount / 10^18)
    //                          = (USDC amount * 10^18) / (ETH amount * 10^6)
    //                          = price * 10^12
    const adjustedPrice = price * 1e12;
    const sqrtPrice = Math.sqrt(adjustedPrice);
    return BigInt(Math.floor(sqrtPrice * Number(Q96)));
  }

  // Helper to convert sqrtPriceX96 back to human-readable price
  function sqrtX96ToPrice(sqrtPriceX96: bigint): number {
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
    const adjustedPrice = sqrtPrice * sqrtPrice;
    return adjustedPrice / 1e12;
  }

  beforeEach(async function () {
    const DeltaCalculatorHarness = await ethers.getContractFactory(
      "DeltaCalculatorHarness"
    );
    deltaCalculator = await DeltaCalculatorHarness.deploy();
    await deltaCalculator.waitForDeployment();
  });

  describe("calculateDelta", function () {
    it("should return 0 delta when price is above range", async function () {
      // ETH price: $2500 (above range)
      // Range: $1800 - $2200
      const sqrtPriceCurrent = priceToSqrtX96(2500);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = BigInt(10) ** BigInt(18); // 1 unit of liquidity

      const delta = await deltaCalculator.calculateDelta(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      expect(delta).to.equal(0n);
    });

    it("should return full delta when price is below range", async function () {
      // ETH price: $1500 (below range)
      // Range: $1800 - $2200
      const sqrtPriceCurrent = priceToSqrtX96(1500);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      const delta = await deltaCalculator.calculateDelta(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      // Delta should be positive (full exposure to ETH)
      expect(delta).to.be.gt(0n);
    });

    it("should return partial delta when price is in range", async function () {
      // ETH price: $2000 (in range)
      // Range: $1800 - $2200
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      const delta = await deltaCalculator.calculateDelta(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      // Delta should be positive but less than full exposure
      expect(delta).to.be.gt(0n);
    });

    it("should return 0 delta for 0 liquidity", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = 0n;

      const delta = await deltaCalculator.calculateDelta(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      expect(delta).to.equal(0n);
    });

    it("should have decreasing delta as price approaches upper bound", async function () {
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      const deltaAt1900 = await deltaCalculator.calculateDelta(
        priceToSqrtX96(1900),
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const deltaAt2000 = await deltaCalculator.calculateDelta(
        priceToSqrtX96(2000),
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const deltaAt2100 = await deltaCalculator.calculateDelta(
        priceToSqrtX96(2100),
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      // Delta should decrease as price increases
      expect(deltaAt1900).to.be.gt(deltaAt2000);
      expect(deltaAt2000).to.be.gt(deltaAt2100);
    });
  });

  describe("calculateDeltaRatio", function () {
    it("should return 1e18 (100%) when price is below range", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(1500);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);

      const deltaRatio = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      expect(deltaRatio).to.equal(PRECISION);
    });

    it("should return 0 when price is above range", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(2500);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);

      const deltaRatio = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      expect(deltaRatio).to.equal(0n);
    });

    it("should return approximately 0.5 at strike price", async function () {
      // Strike price K = sqrt(Pa * Pb) = sqrt(1800 * 2200) ≈ 1990
      const strikePrice = Math.sqrt(1800 * 2200);
      const sqrtPriceCurrent = priceToSqrtX96(strikePrice);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);

      const deltaRatio = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      // Should be approximately 0.5 (within 5% tolerance)
      const halfPrecision = PRECISION / 2n;
      const tolerance = PRECISION / 20n; // 5%
      expect(deltaRatio).to.be.gte(halfPrecision - tolerance);
      expect(deltaRatio).to.be.lte(halfPrecision + tolerance);
    });

    it("should be between 0 and 1 when in range", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);

      const deltaRatio = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      expect(deltaRatio).to.be.gt(0n);
      expect(deltaRatio).to.be.lt(PRECISION);
    });
  });

  describe("getBaseTokenAmount and getQuoteTokenAmount", function () {
    it("should return all base token when below range", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(1500);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      const baseAmount = await deltaCalculator.getBaseTokenAmount(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const quoteAmount = await deltaCalculator.getQuoteTokenAmount(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      expect(baseAmount).to.be.gt(0n);
      expect(quoteAmount).to.equal(0n);
    });

    it("should return all quote token when above range", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(2500);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      const baseAmount = await deltaCalculator.getBaseTokenAmount(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const quoteAmount = await deltaCalculator.getQuoteTokenAmount(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      expect(baseAmount).to.equal(0n);
      expect(quoteAmount).to.be.gt(0n);
    });

    it("should return both tokens when in range", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      const baseAmount = await deltaCalculator.getBaseTokenAmount(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const quoteAmount = await deltaCalculator.getQuoteTokenAmount(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      expect(baseAmount).to.be.gt(0n);
      expect(quoteAmount).to.be.gt(0n);
    });
  });

  describe("calculateGamma", function () {
    it("should return 0 gamma when price is outside range", async function () {
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      // Below range
      const gammaBelow = await deltaCalculator.calculateGamma(
        priceToSqrtX96(1500),
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      // Above range
      const gammaAbove = await deltaCalculator.calculateGamma(
        priceToSqrtX96(2500),
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      expect(gammaBelow).to.equal(0n);
      expect(gammaAbove).to.equal(0n);
    });

    it("should return negative gamma when in range (short volatility)", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      const gamma = await deltaCalculator.calculateGamma(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      // Gamma should be negative for LP positions (short volatility)
      expect(gamma).to.be.lt(0n);
    });

    it("should have larger magnitude gamma for higher liquidity", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);

      const gammaSmall = await deltaCalculator.calculateGamma(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        BigInt(10) ** BigInt(18)
      );

      const gammaLarge = await deltaCalculator.calculateGamma(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        BigInt(10) ** BigInt(19) // 10x more liquidity
      );

      // Magnitude should be larger with more liquidity
      expect(-gammaLarge).to.be.gt(-gammaSmall);
    });
  });

  describe("Price conversions", function () {
    it("should round-trip price conversions accurately", async function () {
      const testPrices = [1000, 2000, 3000, 5000];
      const priceDecimals = 18;

      for (const price of testPrices) {
        const priceWei = BigInt(price) * BigInt(10) ** BigInt(priceDecimals);

        const sqrtPriceX96 = await deltaCalculator.priceToSqrtPriceX96(
          priceWei,
          priceDecimals
        );

        const recoveredPrice = await deltaCalculator.sqrtPriceX96ToPrice(
          sqrtPriceX96,
          priceDecimals
        );

        // Allow 1% tolerance due to fixed-point math
        const tolerance = priceWei / 100n;
        expect(recoveredPrice).to.be.gte(priceWei - tolerance);
        expect(recoveredPrice).to.be.lte(priceWei + tolerance);
      }
    });
  });

  describe("Edge cases", function () {
    it("should handle very narrow ranges", async function () {
      // 1% range around $2000
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(1990);
      const sqrtPriceUpper = priceToSqrtX96(2010);
      const liquidity = BigInt(10) ** BigInt(18);

      const delta = await deltaCalculator.calculateDelta(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      // Should not revert and return a valid delta
      expect(delta).to.be.gte(0n);
    });

    it("should handle very wide ranges", async function () {
      // 100% range: $1000 - $4000
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(1000);
      const sqrtPriceUpper = priceToSqrtX96(4000);
      const liquidity = BigInt(10) ** BigInt(18);

      const delta = await deltaCalculator.calculateDelta(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      // Should not revert and return a valid delta
      expect(delta).to.be.gte(0n);
    });

    it("should revert on invalid price range (lower >= upper)", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(2200);
      const sqrtPriceUpper = priceToSqrtX96(1800);
      const liquidity = BigInt(10) ** BigInt(18);

      await expect(
        deltaCalculator.calculateDelta(
          sqrtPriceCurrent,
          sqrtPriceLower,
          sqrtPriceUpper,
          liquidity
        )
      ).to.be.revertedWith("Invalid price range");
    });

    it("should handle large liquidity values", async function () {
      const sqrtPriceCurrent = priceToSqrtX96(2000);
      const sqrtPriceLower = priceToSqrtX96(1800);
      const sqrtPriceUpper = priceToSqrtX96(2200);
      // Very large liquidity (close to uint128 max)
      const liquidity = BigInt(2) ** BigInt(100);

      const delta = await deltaCalculator.calculateDelta(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      // Should not overflow and return a valid delta
      expect(delta).to.be.gt(0n);
    });
  });
});
