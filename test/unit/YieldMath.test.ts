import { expect } from "chai";
import { ethers } from "hardhat";
import { YieldMathHarness } from "../../typechain-types";

describe("YieldMath", function () {
  let yieldMath: YieldMathHarness;

  // Constants
  const PRECISION = BigInt(10) ** BigInt(18);
  const SECONDS_PER_DAY = 86400n;
  const SECONDS_PER_YEAR = BigInt(Math.floor(365.25 * 86400));

  beforeEach(async function () {
    const YieldMathHarness = await ethers.getContractFactory("YieldMathHarness");
    yieldMath = await YieldMathHarness.deploy();
    await yieldMath.waitForDeployment();
  });

  describe("calculateAPY", function () {
    it("should return 0 when start value is 0", async function () {
      const startSnapshot = {
        timestamp: 1000n,
        totalValue: 0n,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: 2000n,
        totalValue: 1000n * PRECISION,
        cumulativeFees: 100n * PRECISION,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      expect(apy).to.equal(0n);
    });

    it("should return 0 when time delta is 0", async function () {
      const startSnapshot = {
        timestamp: 1000n,
        totalValue: 10000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: 1000n, // Same timestamp
        totalValue: 10000n * PRECISION,
        cumulativeFees: 100n * PRECISION,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      expect(apy).to.equal(0n);
    });

    it("should return 0 when net income is negative", async function () {
      const startSnapshot = {
        timestamp: 1000n,
        totalValue: 10000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: 1000n + SECONDS_PER_DAY,
        totalValue: 10000n * PRECISION,
        cumulativeFees: 50n * PRECISION, // +50 fees
        cumulativeFunding: -100n * BigInt(10) ** BigInt(18), // -100 funding
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      expect(apy).to.equal(0n);
    });

    it("should calculate correct APY for 1 day with positive fees only", async function () {
      // $10,000 vault, $10 fees in 1 day = 0.1% daily = ~36.5% APY
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 10000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: SECONDS_PER_DAY,
        totalValue: 10010n * PRECISION,
        cumulativeFees: 10n * PRECISION,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);

      // Expected: (10/10000) * (365.25 days / 1 day) = 0.001 * 365.25 = 0.36525 = 36.525% APY
      const expectedAPY = (10n * PRECISION * SECONDS_PER_YEAR) / (10000n * SECONDS_PER_DAY);
      expect(apy).to.equal(expectedAPY);

      // Should be approximately 36.5%
      const apyPercent = Number(apy) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(36.525, 0.01);
    });

    it("should calculate correct APY with positive funding", async function () {
      // $10,000 vault, $5 fees + $5 funding in 1 day
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 10000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: SECONDS_PER_DAY,
        totalValue: 10010n * PRECISION,
        cumulativeFees: 5n * PRECISION,
        cumulativeFunding: 5n * BigInt(10) ** BigInt(18),
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);

      // Net income = 5 + 5 = 10
      const expectedAPY = (10n * PRECISION * SECONDS_PER_YEAR) / (10000n * SECONDS_PER_DAY);
      expect(apy).to.equal(expectedAPY);
    });

    it("should calculate correct APY with rebalance costs", async function () {
      // $10,000 vault, $15 fees - $5 rebalance costs in 1 day = $10 net
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 10000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: SECONDS_PER_DAY,
        totalValue: 10010n * PRECISION,
        cumulativeFees: 15n * PRECISION,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 5n * PRECISION,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);

      // Net income = 15 - 5 = 10
      const expectedAPY = (10n * PRECISION * SECONDS_PER_YEAR) / (10000n * SECONDS_PER_DAY);
      expect(apy).to.equal(expectedAPY);
    });

    it("should calculate correct APY over 7 days", async function () {
      // $100,000 vault, $200 net income over 7 days
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 100000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: 7n * SECONDS_PER_DAY,
        totalValue: 100200n * PRECISION,
        cumulativeFees: 200n * PRECISION,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);

      // Expected: (200/100000) * (365.25/7) = 0.002 * 52.178... = ~10.4% APY
      const apyPercent = Number(apy) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(10.435, 0.01);
    });

    it("should handle mixed positive fees and negative funding", async function () {
      // $10,000 vault, $20 fees - $10 funding = $10 net
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 10000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: SECONDS_PER_DAY,
        totalValue: 10010n * PRECISION,
        cumulativeFees: 20n * PRECISION,
        cumulativeFunding: -10n * BigInt(10) ** BigInt(18), // Negative funding
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);

      // Net income = 20 - 10 = 10
      const expectedAPY = (10n * PRECISION * SECONDS_PER_YEAR) / (10000n * SECONDS_PER_DAY);
      expect(apy).to.equal(expectedAPY);
    });
  });

  describe("calculateReturn", function () {
    it("should return 0 when start value is 0", async function () {
      const returnPct = await yieldMath.calculateReturn(0n, 1000n);
      expect(returnPct).to.equal(0n);
    });

    it("should return 0 for no change", async function () {
      const returnPct = await yieldMath.calculateReturn(1000n, 1000n);
      expect(returnPct).to.equal(0n);
    });

    it("should calculate positive return correctly", async function () {
      // 1000 -> 1100 = 10% gain
      const returnPct = await yieldMath.calculateReturn(1000n * PRECISION, 1100n * PRECISION);
      expect(returnPct).to.equal(PRECISION / 10n); // 0.1e18 = 10%
    });

    it("should calculate negative return correctly", async function () {
      // 1000 -> 900 = -10% loss
      const returnPct = await yieldMath.calculateReturn(1000n * PRECISION, 900n * PRECISION);
      expect(returnPct).to.equal(-BigInt(PRECISION) / 10n); // -0.1e18 = -10%
    });

    it("should calculate 100% gain correctly", async function () {
      // 1000 -> 2000 = 100% gain
      const returnPct = await yieldMath.calculateReturn(1000n * PRECISION, 2000n * PRECISION);
      expect(returnPct).to.equal(BigInt(PRECISION)); // 1e18 = 100%
    });

    it("should calculate 50% loss correctly", async function () {
      // 1000 -> 500 = -50% loss
      const returnPct = await yieldMath.calculateReturn(1000n * PRECISION, 500n * PRECISION);
      expect(returnPct).to.equal(-BigInt(PRECISION) / 2n); // -0.5e18 = -50%
    });

    it("should handle small values", async function () {
      // 100 -> 101 = 1% gain
      const returnPct = await yieldMath.calculateReturn(100n * PRECISION, 101n * PRECISION);
      expect(returnPct).to.equal(PRECISION / 100n); // 0.01e18 = 1%
    });

    it("should handle large values", async function () {
      // $1B -> $1.1B = 10% gain
      const oneBillion = BigInt(10) ** BigInt(9) * PRECISION;
      const returnPct = await yieldMath.calculateReturn(oneBillion, oneBillion * 11n / 10n);
      expect(returnPct).to.equal(PRECISION / 10n); // 10%
    });
  });

  describe("periodReturnToAPY", function () {
    it("should return 0 for negative return", async function () {
      const apy = await yieldMath.periodReturnToAPY(-BigInt(PRECISION) / 10n, SECONDS_PER_DAY);
      expect(apy).to.equal(0n);
    });

    it("should return 0 for zero period", async function () {
      const apy = await yieldMath.periodReturnToAPY(PRECISION / 10n, 0n);
      expect(apy).to.equal(0n);
    });

    it("should return 0 for zero return", async function () {
      const apy = await yieldMath.periodReturnToAPY(0n, SECONDS_PER_DAY);
      expect(apy).to.equal(0n);
    });

    it("should annualize 1-day return correctly", async function () {
      // 0.1% daily return = ~36.525% APY (simple)
      const dailyReturn = PRECISION / 1000n; // 0.1%
      const apy = await yieldMath.periodReturnToAPY(dailyReturn, SECONDS_PER_DAY);

      // Expected: 0.001 * 365.25 = 0.36525 = 36.525%
      const apyPercent = Number(apy) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(36.525, 0.01);
    });

    it("should annualize 7-day return correctly", async function () {
      // 0.7% weekly return = ~36.525% APY
      const weeklyReturn = (PRECISION * 7n) / 1000n; // 0.7%
      const apy = await yieldMath.periodReturnToAPY(weeklyReturn, 7n * SECONDS_PER_DAY);

      const apyPercent = Number(apy) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(36.525, 0.01);
    });

    it("should annualize 30-day return correctly", async function () {
      // 1% monthly return = ~12.175% APY (simple)
      const monthlyReturn = PRECISION / 100n; // 1%
      const apy = await yieldMath.periodReturnToAPY(monthlyReturn, 30n * SECONDS_PER_DAY);

      // Expected: 0.01 * 365.25/30 = ~12.175%
      const apyPercent = Number(apy) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(12.175, 0.01);
    });

    it("should handle very small returns", async function () {
      // 0.01% daily = ~3.6525% APY
      const tinyReturn = PRECISION / 10000n; // 0.01%
      const apy = await yieldMath.periodReturnToAPY(tinyReturn, SECONDS_PER_DAY);

      const apyPercent = Number(apy) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(3.6525, 0.01);
    });

    it("should handle large returns", async function () {
      // 1% daily = ~365.25% APY
      const dailyReturn = PRECISION / 100n; // 1%
      const apy = await yieldMath.periodReturnToAPY(dailyReturn, SECONDS_PER_DAY);

      const apyPercent = Number(apy) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(365.25, 0.1);
    });
  });

  describe("calculateTotalFees", function () {
    it("should calculate fees with only token0 (ETH)", async function () {
      // 0.01 ETH at $2000/ETH = $20
      const amount0Fees = BigInt(10) ** BigInt(16); // 0.01 ETH (18 decimals)
      const amount1Fees = 0n;
      const token0Price = 2000n * PRECISION; // $2000
      const token1Decimals = 6;

      const totalFees = await yieldMath.calculateTotalFees(
        amount0Fees,
        amount1Fees,
        token0Price,
        token1Decimals
      );

      // 0.01 * 2000 = $20
      expect(totalFees).to.equal(20n * PRECISION);
    });

    it("should calculate fees with only token1 (USDC)", async function () {
      // 50 USDC = $50
      const amount0Fees = 0n;
      const amount1Fees = 50n * BigInt(10) ** BigInt(6); // 50 USDC (6 decimals)
      const token0Price = 2000n * PRECISION;
      const token1Decimals = 6;

      const totalFees = await yieldMath.calculateTotalFees(
        amount0Fees,
        amount1Fees,
        token0Price,
        token1Decimals
      );

      expect(totalFees).to.equal(50n * PRECISION);
    });

    it("should calculate fees with both tokens", async function () {
      // 0.01 ETH at $2000 = $20 + 30 USDC = $50 total
      const amount0Fees = BigInt(10) ** BigInt(16); // 0.01 ETH
      const amount1Fees = 30n * BigInt(10) ** BigInt(6); // 30 USDC
      const token0Price = 2000n * PRECISION;
      const token1Decimals = 6;

      const totalFees = await yieldMath.calculateTotalFees(
        amount0Fees,
        amount1Fees,
        token0Price,
        token1Decimals
      );

      expect(totalFees).to.equal(50n * PRECISION);
    });

    it("should handle different ETH prices", async function () {
      // 0.1 ETH at $3500 = $350
      const amount0Fees = BigInt(10) ** BigInt(17); // 0.1 ETH
      const amount1Fees = 0n;
      const token0Price = 3500n * PRECISION;
      const token1Decimals = 6;

      const totalFees = await yieldMath.calculateTotalFees(
        amount0Fees,
        amount1Fees,
        token0Price,
        token1Decimals
      );

      expect(totalFees).to.equal(350n * PRECISION);
    });

    it("should handle zero fees", async function () {
      const totalFees = await yieldMath.calculateTotalFees(
        0n,
        0n,
        2000n * PRECISION,
        6
      );

      expect(totalFees).to.equal(0n);
    });

    it("should handle token1 with 18 decimals", async function () {
      // For a stablecoin with 18 decimals like DAI
      const amount1Fees = 100n * PRECISION; // 100 tokens with 18 decimals
      const token1Decimals = 18;

      const totalFees = await yieldMath.calculateTotalFees(
        0n,
        amount1Fees,
        2000n * PRECISION,
        token1Decimals
      );

      expect(totalFees).to.equal(100n * PRECISION);
    });
  });

  describe("calculateFundingAPY", function () {
    it("should return 0 for zero position size", async function () {
      const fundingAPY = await yieldMath.calculateFundingAPY(
        100n * BigInt(10) ** BigInt(18),
        0n,
        SECONDS_PER_DAY
      );
      expect(fundingAPY).to.equal(0n);
    });

    it("should return 0 for zero time period", async function () {
      const fundingAPY = await yieldMath.calculateFundingAPY(
        100n * BigInt(10) ** BigInt(18),
        10000n * PRECISION,
        0n
      );
      expect(fundingAPY).to.equal(0n);
    });

    it("should calculate positive funding APY correctly", async function () {
      // $10 funding received on $10,000 position in 1 day
      // = 0.1% daily = ~36.525% APY
      const fundingAmount = 10n * BigInt(10) ** BigInt(18);
      const positionSize = 10000n * PRECISION;

      const fundingAPY = await yieldMath.calculateFundingAPY(
        fundingAmount,
        positionSize,
        SECONDS_PER_DAY
      );

      const apyPercent = Number(fundingAPY) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(36.525, 0.01);
    });

    it("should calculate negative funding APY correctly", async function () {
      // -$10 funding paid on $10,000 position in 1 day
      const fundingAmount = -10n * BigInt(10) ** BigInt(18);
      const positionSize = 10000n * PRECISION;

      const fundingAPY = await yieldMath.calculateFundingAPY(
        fundingAmount,
        positionSize,
        SECONDS_PER_DAY
      );

      const apyPercent = Number(fundingAPY) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(-36.525, 0.01);
    });

    it("should handle weekly funding calculation", async function () {
      // $70 funding received on $100,000 position in 7 days
      // = 0.07% per week = ~3.6525% APY
      const fundingAmount = 70n * BigInt(10) ** BigInt(18);
      const positionSize = 100000n * PRECISION;

      const fundingAPY = await yieldMath.calculateFundingAPY(
        fundingAmount,
        positionSize,
        7n * SECONDS_PER_DAY
      );

      const apyPercent = Number(fundingAPY) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(3.6525, 0.01);
    });

    it("should handle high funding rates", async function () {
      // $100 funding on $10,000 position in 1 day = 1% daily = ~365.25% APY
      const fundingAmount = 100n * BigInt(10) ** BigInt(18);
      const positionSize = 10000n * PRECISION;

      const fundingAPY = await yieldMath.calculateFundingAPY(
        fundingAmount,
        positionSize,
        SECONDS_PER_DAY
      );

      const apyPercent = Number(fundingAPY) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(365.25, 0.1);
    });

    it("should handle zero funding amount", async function () {
      const fundingAPY = await yieldMath.calculateFundingAPY(
        0n,
        10000n * PRECISION,
        SECONDS_PER_DAY
      );
      expect(fundingAPY).to.equal(0n);
    });
  });

  describe("calculateBreakevenVolatility", function () {
    it("should return 0 for zero fee APY", async function () {
      const breakevenVol = await yieldMath.calculateBreakevenVolatility(
        0n,
        PRECISION / 10n // 10% range
      );
      expect(breakevenVol).to.equal(0n);
    });

    it("should calculate breakeven vol for typical scenario", async function () {
      // 20% fee APY, 10% range width
      // breakeven vol = sqrt(8 * 0.2 * 0.1) = sqrt(0.16) = 0.4 = 40%
      const feeAPY = (PRECISION * 20n) / 100n; // 20%
      const rangeWidth = PRECISION / 10n; // 10%

      const breakevenVol = await yieldMath.calculateBreakevenVolatility(feeAPY, rangeWidth);

      const volPercent = Number(breakevenVol) / Number(PRECISION) * 100;
      expect(volPercent).to.be.closeTo(40, 1); // Allow 1% tolerance for sqrt approximation
    });

    it("should increase with higher fee APY", async function () {
      const rangeWidth = PRECISION / 10n; // 10%

      const vol10 = await yieldMath.calculateBreakevenVolatility(
        (PRECISION * 10n) / 100n, // 10% APY
        rangeWidth
      );
      const vol20 = await yieldMath.calculateBreakevenVolatility(
        (PRECISION * 20n) / 100n, // 20% APY
        rangeWidth
      );
      const vol40 = await yieldMath.calculateBreakevenVolatility(
        (PRECISION * 40n) / 100n, // 40% APY
        rangeWidth
      );

      expect(vol20).to.be.gt(vol10);
      expect(vol40).to.be.gt(vol20);
    });

    it("should increase with wider range", async function () {
      const feeAPY = (PRECISION * 20n) / 100n; // 20%

      const volNarrow = await yieldMath.calculateBreakevenVolatility(
        feeAPY,
        PRECISION / 20n // 5% range
      );
      const volMedium = await yieldMath.calculateBreakevenVolatility(
        feeAPY,
        PRECISION / 10n // 10% range
      );
      const volWide = await yieldMath.calculateBreakevenVolatility(
        feeAPY,
        PRECISION / 5n // 20% range
      );

      expect(volMedium).to.be.gt(volNarrow);
      expect(volWide).to.be.gt(volMedium);
    });

    it("should handle high fee APY scenarios", async function () {
      // 100% fee APY, 20% range = sqrt(8 * 1.0 * 0.2) = sqrt(1.6) ≈ 1.26 = 126%
      const feeAPY = PRECISION; // 100%
      const rangeWidth = PRECISION / 5n; // 20%

      const breakevenVol = await yieldMath.calculateBreakevenVolatility(feeAPY, rangeWidth);

      const volPercent = Number(breakevenVol) / Number(PRECISION) * 100;
      expect(volPercent).to.be.closeTo(126.5, 2);
    });

    it("should handle narrow range correctly", async function () {
      // 10% fee APY, 2% range = sqrt(8 * 0.1 * 0.02) = sqrt(0.016) ≈ 0.126 = 12.6%
      const feeAPY = PRECISION / 10n; // 10%
      const rangeWidth = PRECISION / 50n; // 2%

      const breakevenVol = await yieldMath.calculateBreakevenVolatility(feeAPY, rangeWidth);

      const volPercent = Number(breakevenVol) / Number(PRECISION) * 100;
      expect(volPercent).to.be.closeTo(12.65, 1);
    });
  });

  describe("Edge cases and precision", function () {
    it("should handle very small yield snapshots", async function () {
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 1n, // 1 wei
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: SECONDS_PER_DAY,
        totalValue: 2n,
        cumulativeFees: 1n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };

      // Should not revert
      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      expect(apy).to.be.gt(0n);
    });

    it("should handle maximum reasonable values", async function () {
      // $1 trillion vault
      const trillion = BigInt(10) ** BigInt(12) * PRECISION;

      const startSnapshot = {
        timestamp: 0n,
        totalValue: trillion,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: SECONDS_PER_DAY,
        totalValue: trillion + trillion / 1000n, // +0.1%
        cumulativeFees: trillion / 1000n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      const apyPercent = Number(apy) / Number(PRECISION) * 100;
      expect(apyPercent).to.be.closeTo(36.525, 0.1);
    });

    it("should expose correct PRECISION constant", async function () {
      const precision = await yieldMath.PRECISION();
      expect(precision).to.equal(PRECISION);
    });

    it("should expose correct SECONDS_PER_YEAR constant", async function () {
      const secondsPerYear = await yieldMath.SECONDS_PER_YEAR();
      expect(secondsPerYear).to.equal(SECONDS_PER_YEAR);
    });
  });

  describe("Real-world scenarios", function () {
    it("scenario: conservative vault with stable returns", async function () {
      // $100,000 vault
      // Day 1: $10 fees, $0 funding, $1 rebalance cost = $9 net
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 100000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: SECONDS_PER_DAY,
        totalValue: 100009n * PRECISION,
        cumulativeFees: 10n * PRECISION,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 1n * PRECISION,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      const apyPercent = Number(apy) / Number(PRECISION) * 100;

      // $9 / $100,000 * 365.25 = ~3.3% APY
      expect(apyPercent).to.be.closeTo(3.287, 0.01);
    });

    it("scenario: high-yield vault with positive funding", async function () {
      // $50,000 vault
      // Week: $100 fees, $50 funding received, $10 rebalance costs = $140 net
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 50000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: 7n * SECONDS_PER_DAY,
        totalValue: 50140n * PRECISION,
        cumulativeFees: 100n * PRECISION,
        cumulativeFunding: 50n * BigInt(10) ** BigInt(18),
        cumulativeRebalanceCosts: 10n * PRECISION,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      const apyPercent = Number(apy) / Number(PRECISION) * 100;

      // $140 / $50,000 * 52.178 = ~14.6% APY
      expect(apyPercent).to.be.closeTo(14.61, 0.1);
    });

    it("scenario: challenging market with negative funding", async function () {
      // $75,000 vault
      // Month: $300 fees, -$200 funding paid, $25 rebalance costs = $75 net
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 75000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: 30n * SECONDS_PER_DAY,
        totalValue: 75075n * PRECISION,
        cumulativeFees: 300n * PRECISION,
        cumulativeFunding: -200n * BigInt(10) ** BigInt(18),
        cumulativeRebalanceCosts: 25n * PRECISION,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      const apyPercent = Number(apy) / Number(PRECISION) * 100;

      // $75 / $75,000 * 12.175 = ~1.22% APY
      expect(apyPercent).to.be.closeTo(1.217, 0.01);
    });

    it("scenario: breakeven with costs exactly matching income", async function () {
      // $10,000 vault, $50 fees, -$50 funding = $0 net
      const startSnapshot = {
        timestamp: 0n,
        totalValue: 10000n * PRECISION,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };
      const endSnapshot = {
        timestamp: SECONDS_PER_DAY,
        totalValue: 10000n * PRECISION,
        cumulativeFees: 50n * PRECISION,
        cumulativeFunding: -50n * BigInt(10) ** BigInt(18),
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      expect(apy).to.equal(0n);
    });
  });
});
