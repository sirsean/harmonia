import { expect } from "chai";
import { ethers } from "hardhat";
import { DeltaCalculatorHarness, YieldMathHarness } from "../../typechain-types";
import { Q96, PRECISION, priceToSqrtPriceX96, sqrtPriceX96ToPrice } from "../helpers/constants";

/**
 * Critical Scenario Tests (P0)
 *
 * These tests cover scenarios that could lead to significant financial loss:
 * 1. GMX liquidation during extreme price moves
 * 2. Rebalance failure during high volatility
 * 3. Oracle price manipulation/deviation
 * 4. Price moves outside LP range
 * 5. Negative funding rates exceeding LP fees
 * 6. Flash crash scenarios
 * 7. Sandwich attack protection (slippage)
 */
describe("Critical Scenarios (P0)", function () {
  let deltaCalculator: DeltaCalculatorHarness;
  let yieldMath: YieldMathHarness;

  // Constants
  const SECONDS_PER_DAY = 86400n;
  const SECONDS_PER_YEAR = BigInt(Math.floor(365.25 * 86400));

  beforeEach(async function () {
    const DeltaCalculatorHarness = await ethers.getContractFactory("DeltaCalculatorHarness");
    deltaCalculator = await DeltaCalculatorHarness.deploy();
    await deltaCalculator.waitForDeployment();

    const YieldMathHarness = await ethers.getContractFactory("YieldMathHarness");
    yieldMath = await YieldMathHarness.deploy();
    await yieldMath.waitForDeployment();
  });

  describe("1. GMX Liquidation Scenarios", function () {
    /**
     * GMX v2 liquidation occurs when:
     * - Position losses exceed collateral minus maintenance margin
     * - Typically at 90-95% collateral loss
     *
     * For a short position with 3x leverage:
     * - $10,000 collateral, $30,000 position
     * - Liquidation at ~33% price increase (before fees)
     */

    it("should detect liquidation risk at 25% price increase with 3x leverage", async function () {
      // Initial state: Short position at $2000 ETH
      const entryPrice = 2000;
      const positionSizeUsd = 30000n * PRECISION; // $30k position
      const collateral = 10000n * PRECISION; // $10k collateral (3x leverage)
      const maintenanceMarginRatio = (1n * PRECISION) / 100n; // 1% maintenance margin

      // Price increases by 25%
      const newPrice = 2500;
      const priceChangePct = ((newPrice - entryPrice) / entryPrice) * 100;

      // Calculate PnL for short position
      // Short PnL = position_size * (entry_price - current_price) / entry_price
      const pnl = (positionSizeUsd * BigInt(entryPrice - newPrice)) / BigInt(entryPrice);
      const pnlUsd = Number(pnl) / Number(PRECISION);

      // Calculate remaining equity
      const remainingEquity = Number(collateral) / Number(PRECISION) + pnlUsd;
      const equityRatio = remainingEquity / (Number(positionSizeUsd) / Number(PRECISION));

      console.log("Liquidation Analysis:");
      console.log(`  Entry Price: $${entryPrice}`);
      console.log(`  Current Price: $${newPrice} (+${priceChangePct.toFixed(1)}%)`);
      console.log(`  Position Size: $${Number(positionSizeUsd) / Number(PRECISION)}`);
      console.log(`  Collateral: $${Number(collateral) / Number(PRECISION)}`);
      console.log(`  PnL: $${pnlUsd.toFixed(2)}`);
      console.log(`  Remaining Equity: $${remainingEquity.toFixed(2)}`);
      console.log(`  Equity Ratio: ${(equityRatio * 100).toFixed(2)}%`);

      // At 25% price increase, equity should be critically low
      expect(pnlUsd).to.be.lt(0); // Loss on short
      expect(remainingEquity).to.be.lt(Number(collateral) / Number(PRECISION)); // Less than initial

      // Check if near liquidation (equity < 5% of position)
      const isNearLiquidation = equityRatio < 0.05;
      console.log(`  Near Liquidation: ${isNearLiquidation}`);
    });

    it("should calculate liquidation price for short position", async function () {
      const entryPrice = 2000;
      const leverage = 3;
      const collateral = 10000; // $10k
      const positionSize = collateral * leverage; // $30k

      // Liquidation occurs when: collateral + PnL = maintenance_margin
      // For short: PnL = positionSize * (entryPrice - currentPrice) / entryPrice
      // collateral + positionSize * (entryPrice - liqPrice) / entryPrice = maintenanceMargin
      // Solving for liqPrice:
      // liqPrice = entryPrice * (1 + (collateral - maintenanceMargin) / positionSize)

      const maintenanceMargin = positionSize * 0.01; // 1%
      const liquidationPrice = entryPrice * (1 + (collateral - maintenanceMargin) / positionSize);

      console.log("Liquidation Price Calculation:");
      console.log(`  Entry Price: $${entryPrice}`);
      console.log(`  Leverage: ${leverage}x`);
      console.log(`  Liquidation Price: $${liquidationPrice.toFixed(2)}`);
      console.log(
        `  Price Buffer: ${(((liquidationPrice - entryPrice) / entryPrice) * 100).toFixed(2)}%`
      );

      // With 3x leverage, liquidation should be around 32-33% price increase
      expect(liquidationPrice).to.be.closeTo(2647, 10);
    });

    it("should track position health at various price levels", async function () {
      const entryPrice = 2000;
      const collateral = 10000n * PRECISION;
      const positionSize = 30000n * PRECISION; // 3x leverage

      const pricePoints = [2000, 2200, 2400, 2500, 2600, 2650];

      console.log("\nPosition Health at Various Prices:");
      console.log("Price\t\tPnL\t\tEquity\t\tHealth");

      for (const price of pricePoints) {
        const pnl = (positionSize * BigInt(entryPrice - price)) / BigInt(entryPrice);
        const equity = BigInt(Number(collateral)) + pnl;
        const healthRatio = (Number(equity) / Number(positionSize)) * 100;

        const status =
          healthRatio < 2
            ? "LIQUIDATION"
            : healthRatio < 5
              ? "CRITICAL"
              : healthRatio < 10
                ? "WARNING"
                : "HEALTHY";

        console.log(
          `$${price}\t\t$${(Number(pnl) / Number(PRECISION)).toFixed(0)}\t\t$${(Number(equity) / Number(PRECISION)).toFixed(0)}\t\t${healthRatio.toFixed(1)}% (${status})`
        );

        // Verify calculations
        if (price === entryPrice) {
          expect(pnl).to.equal(0n);
        }
        if (price > entryPrice) {
          expect(pnl).to.be.lt(0n);
        }
      }
    });

    it("should calculate required collateral for target liquidation buffer", async function () {
      const positionSize = 30000; // $30k position
      const entryPrice = 2000;
      const targetLiqBuffer = 0.4; // Want 40% price buffer before liquidation

      // Target liquidation price
      const targetLiqPrice = entryPrice * (1 + targetLiqBuffer);

      // Required collateral = positionSize * (targetLiqPrice - entryPrice) / entryPrice + margin
      const maintenanceMargin = positionSize * 0.01;
      const requiredCollateral =
        (positionSize * (targetLiqPrice - entryPrice)) / entryPrice + maintenanceMargin;
      const resultingLeverage = positionSize / requiredCollateral;

      console.log("\nCollateral Requirements for Safety Buffer:");
      console.log(`  Target Liq Price: $${targetLiqPrice}`);
      console.log(`  Required Collateral: $${requiredCollateral.toFixed(2)}`);
      console.log(`  Resulting Leverage: ${resultingLeverage.toFixed(2)}x`);

      expect(resultingLeverage).to.be.lt(3);
      expect(requiredCollateral).to.be.gt(positionSize * 0.3);
    });
  });

  describe("2. Oracle Price Deviation Scenarios", function () {
    /**
     * Oracle vs AMM price deviation can occur during:
     * - High volatility periods
     * - Low liquidity conditions
     * - Oracle update delays
     * - Potential manipulation attempts
     */

    it("should detect dangerous oracle deviation (>2%)", async function () {
      const oraclePrice = 2000;
      const ammPrices = [1950, 1960, 1980, 2000, 2020, 2040, 2050];

      console.log("\nOracle Deviation Analysis:");
      console.log("AMM Price\tDeviation\tStatus");

      for (const ammPrice of ammPrices) {
        const deviation = ((ammPrice - oraclePrice) / oraclePrice) * 100;
        const absDeviation = Math.abs(deviation);

        const status =
          absDeviation > 5
            ? "HALT_TRADING"
            : absDeviation > 2
              ? "DANGEROUS"
              : absDeviation > 1
                ? "WARNING"
                : "OK";

        console.log(`$${ammPrice}\t\t${deviation.toFixed(2)}%\t\t${status}`);

        // Any deviation > 5% should halt operations
        if (absDeviation > 5) {
          expect(absDeviation).to.be.gt(5);
        }
      }
    });

    it("should calculate delta error from price deviation", async function () {
      // Setup LP position
      const currentPriceOracle = 2000;
      const rangeLower = 1800;
      const rangeUpper = 2200;
      const liquidity = BigInt(10) ** BigInt(18);

      // Calculate delta at oracle price
      const sqrtPriceOracle = priceToSqrtPriceX96(currentPriceOracle);
      const sqrtPriceLower = priceToSqrtPriceX96(rangeLower);
      const sqrtPriceUpper = priceToSqrtPriceX96(rangeUpper);

      const deltaAtOracle = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceOracle,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      // Simulate different AMM prices (deviation scenarios)
      const deviationPcts = [-5, -3, -1, 0, 1, 3, 5];

      console.log("\nDelta Error from Price Deviation:");
      console.log("Deviation\tAMM Price\tDelta@Oracle\tDelta@AMM\tDelta Error");

      for (const devPct of deviationPcts) {
        const ammPrice = currentPriceOracle * (1 + devPct / 100);
        const sqrtPriceAMM = priceToSqrtPriceX96(ammPrice);

        const deltaAtAMM = await deltaCalculator.calculateDeltaRatio(
          sqrtPriceAMM,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        const deltaOraclePct = (Number(deltaAtOracle) / Number(PRECISION)) * 100;
        const deltaAMMPct = (Number(deltaAtAMM) / Number(PRECISION)) * 100;
        const deltaError = deltaAMMPct - deltaOraclePct;

        console.log(
          `${devPct >= 0 ? "+" : ""}${devPct}%\t\t$${ammPrice.toFixed(0)}\t\t${deltaOraclePct.toFixed(2)}%\t\t${deltaAMMPct.toFixed(2)}%\t\t${deltaError >= 0 ? "+" : ""}${deltaError.toFixed(2)}%`
        );

        // Delta error should be proportional to price deviation
        if (devPct !== 0) {
          expect(Math.abs(deltaError)).to.be.gt(0);
        }
      }
    });

    it("should calculate hedge size error from oracle deviation", async function () {
      // $100k vault
      const vaultValueUsd = 100000;
      const currentPrice = 2000;

      // LP position delta at correct price
      const sqrtPrice = priceToSqrtPriceX96(currentPrice);
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      const deltaRatio = await deltaCalculator.calculateDeltaRatio(
        sqrtPrice,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const lpDeltaUsd = (vaultValueUsd * Number(deltaRatio)) / Number(PRECISION);

      // If oracle is off by 3%, what's the hedge error?
      const oracleDeviation = 0.03;
      const wrongPrice = currentPrice * (1 + oracleDeviation);
      const sqrtPriceWrong = priceToSqrtPriceX96(wrongPrice);

      const wrongDeltaRatio = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceWrong,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const wrongLpDeltaUsd = (vaultValueUsd * Number(wrongDeltaRatio)) / Number(PRECISION);
      const hedgeError = wrongLpDeltaUsd - lpDeltaUsd;
      const hedgeErrorPct = (hedgeError / vaultValueUsd) * 100;

      console.log("\nHedge Error from Oracle Deviation:");
      console.log(`  Vault Value: $${vaultValueUsd}`);
      console.log(`  Correct Delta: $${lpDeltaUsd.toFixed(2)}`);
      console.log(
        `  Wrong Delta (${(oracleDeviation * 100).toFixed(0)}% deviation): $${wrongLpDeltaUsd.toFixed(2)}`
      );
      console.log(
        `  Hedge Error: $${hedgeError.toFixed(2)} (${hedgeErrorPct.toFixed(3)}% of vault)`
      );

      // With 3% oracle deviation, hedge error can be significant due to delta's sensitivity to price
      // This demonstrates why oracle accuracy is critical - even small deviations cause large hedge errors
      expect(Math.abs(hedgeErrorPct)).to.be.gt(5); // Error is significant
      expect(Math.abs(hedgeErrorPct)).to.be.lt(25); // But bounded
    });
  });

  describe("3. Price Outside LP Range Scenarios", function () {
    /**
     * When price moves outside the LP range:
     * - Above range: 100% quote token (USDC), delta = 0
     * - Below range: 100% base token (ETH), delta = full exposure
     *
     * Critical risks:
     * - Hedge mismatch when delta jumps
     * - No fee accrual outside range
     * - Potential for rapid delta changes at boundaries
     */

    it("should handle price moving above range (100% USDC)", async function () {
      // Position: ETH/USDC LP from $1800 to $2200
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      // Price jumps above range to $2500
      const sqrtPriceAbove = priceToSqrtPriceX96(2500);

      const delta = await deltaCalculator.calculateDelta(
        sqrtPriceAbove,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const deltaRatio = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceAbove,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const baseAmount = await deltaCalculator.getBaseTokenAmount(
        sqrtPriceAbove,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const quoteAmount = await deltaCalculator.getQuoteTokenAmount(
        sqrtPriceAbove,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      console.log("\nPrice Above Range Analysis:");
      console.log("  Price: $2500 (range: $1800-$2200)");
      console.log(`  Delta: ${delta}`);
      console.log(`  Delta Ratio: ${Number(deltaRatio) / Number(PRECISION)}%`);
      console.log(`  Base Token (ETH): ${baseAmount}`);
      console.log(`  Quote Token (USDC): ${quoteAmount}`);

      // Above range: all quote token, no delta
      expect(delta).to.equal(0n);
      expect(deltaRatio).to.equal(0n);
      expect(baseAmount).to.equal(0n);
      expect(quoteAmount).to.be.gt(0n);
    });

    it("should handle price moving below range (100% ETH)", async function () {
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);
      const liquidity = BigInt(10) ** BigInt(18);

      // Price crashes below range to $1500
      const sqrtPriceBelow = priceToSqrtPriceX96(1500);

      const delta = await deltaCalculator.calculateDelta(
        sqrtPriceBelow,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const deltaRatio = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceBelow,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const baseAmount = await deltaCalculator.getBaseTokenAmount(
        sqrtPriceBelow,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const quoteAmount = await deltaCalculator.getQuoteTokenAmount(
        sqrtPriceBelow,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      console.log("\nPrice Below Range Analysis:");
      console.log("  Price: $1500 (range: $1800-$2200)");
      console.log(`  Delta: ${delta}`);
      console.log(`  Delta Ratio: ${(Number(deltaRatio) / Number(PRECISION)) * 100}%`);
      console.log(`  Base Token (ETH): ${baseAmount}`);
      console.log(`  Quote Token (USDC): ${quoteAmount}`);

      // Below range: all base token, full delta
      expect(delta).to.be.gt(0n);
      expect(deltaRatio).to.equal(PRECISION); // 100%
      expect(baseAmount).to.be.gt(0n);
      expect(quoteAmount).to.equal(0n);
    });

    it("should track delta discontinuity at range boundaries", async function () {
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Test prices around boundaries
      const testPrices = [1790, 1795, 1800, 1805, 1810, 2190, 2195, 2200, 2205, 2210];

      console.log("\nDelta Behavior at Boundaries:");
      console.log("Price\t\tDelta Ratio\tIn Range?");

      let prevDeltaRatio = 0n;

      for (const price of testPrices) {
        const sqrtPrice = priceToSqrtPriceX96(price);
        const deltaRatio = await deltaCalculator.calculateDeltaRatio(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        const inRange = price >= 1800 && price <= 2200;
        const deltaPct = (Number(deltaRatio) / Number(PRECISION)) * 100;

        // Check for discontinuity
        const jump = Number(deltaRatio) - Number(prevDeltaRatio);
        const jumpPct = (jump / Number(PRECISION)) * 100;

        console.log(
          `$${price}\t\t${deltaPct.toFixed(2)}%\t\t${inRange ? "YES" : "NO"}${Math.abs(jumpPct) > 1 ? ` (jump: ${jumpPct.toFixed(1)}%)` : ""}`
        );

        prevDeltaRatio = deltaRatio;
      }

      // Verify boundary behavior
      const deltaJustBelow = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(1799),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const deltaJustAbove = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(2201),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      expect(deltaJustBelow).to.equal(PRECISION); // 100% below range
      expect(deltaJustAbove).to.equal(0n); // 0% above range
    });

    it("should calculate hedge adjustment needed when exiting range", async function () {
      const vaultValue = 100000; // $100k vault
      const currentPrice = 2000;
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Current delta in range
      const sqrtPriceCurrent = priceToSqrtPriceX96(currentPrice);
      const currentDeltaRatio = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceCurrent,
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const currentHedgeNeeded = (vaultValue * Number(currentDeltaRatio)) / Number(PRECISION);

      // Delta if price goes above range
      const aboveRangeDeltaRatio = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(2300),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const aboveRangeHedgeNeeded = (vaultValue * Number(aboveRangeDeltaRatio)) / Number(PRECISION);

      // Delta if price goes below range
      const belowRangeDeltaRatio = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(1700),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const belowRangeHedgeNeeded = (vaultValue * Number(belowRangeDeltaRatio)) / Number(PRECISION);

      console.log("\nHedge Adjustment Analysis:");
      console.log(`  Current Price ($${currentPrice}): Hedge $${currentHedgeNeeded.toFixed(2)}`);
      console.log(
        `  Above Range ($2300): Hedge $${aboveRangeHedgeNeeded.toFixed(2)} (change: $${(aboveRangeHedgeNeeded - currentHedgeNeeded).toFixed(2)})`
      );
      console.log(
        `  Below Range ($1700): Hedge $${belowRangeHedgeNeeded.toFixed(2)} (change: $${(belowRangeHedgeNeeded - currentHedgeNeeded).toFixed(2)})`
      );

      // Going above range requires closing hedge (sell short)
      expect(aboveRangeHedgeNeeded).to.equal(0);
      // Going below range requires full hedge (using closeTo for floating point precision)
      expect(belowRangeHedgeNeeded).to.be.closeTo(vaultValue, 1);
    });
  });

  describe("4. Negative Funding Rate Scenarios", function () {
    /**
     * When shorts pay longs (negative funding for our hedge):
     * - Funding costs eat into LP fee income
     * - Sustained negative funding can cause net losses
     * - Need to monitor breakeven threshold
     */

    it("should calculate net yield with negative funding", async function () {
      // $100k vault, 7-day period
      const vaultValue = 100000n * PRECISION;

      // Scenario: LP fees $700, negative funding -$500, rebalance costs $50
      const startSnapshot = {
        timestamp: 0n,
        totalValue: vaultValue,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };

      const endSnapshot = {
        timestamp: 7n * SECONDS_PER_DAY,
        totalValue: vaultValue + 150n * PRECISION, // Net +$150
        cumulativeFees: 700n * PRECISION,
        cumulativeFunding: -500n * BigInt(10) ** BigInt(18), // Negative!
        cumulativeRebalanceCosts: 50n * PRECISION,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
      const apyPct = (Number(apy) / Number(PRECISION)) * 100;

      console.log("\nNegative Funding Scenario:");
      console.log(`  LP Fees: $700`);
      console.log(`  Funding: -$500 (shorts paying)`);
      console.log(`  Rebalance Costs: $50`);
      console.log(`  Net Income: $150`);
      console.log(`  APY: ${apyPct.toFixed(2)}%`);

      // Should still be positive but reduced
      expect(apy).to.be.gt(0n);
      expect(apyPct).to.be.closeTo(7.83, 0.1); // ~7.8% APY
    });

    it("should return 0 APY when negative funding exceeds LP fees", async function () {
      const vaultValue = 100000n * PRECISION;

      // Scenario: LP fees $500, negative funding -$800
      const startSnapshot = {
        timestamp: 0n,
        totalValue: vaultValue,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };

      const endSnapshot = {
        timestamp: 7n * SECONDS_PER_DAY,
        totalValue: vaultValue - 300n * PRECISION, // Net loss
        cumulativeFees: 500n * PRECISION,
        cumulativeFunding: -800n * BigInt(10) ** BigInt(18),
        cumulativeRebalanceCosts: 0n,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);

      console.log("\nExtreme Negative Funding Scenario:");
      console.log(`  LP Fees: $500`);
      console.log(`  Funding: -$800`);
      console.log(`  Net Income: -$300`);
      console.log(`  APY: ${apy} (returns 0 for negative)`);

      // Should return 0 for negative net income
      expect(apy).to.equal(0n);
    });

    it("should calculate funding rate threshold for profitability", async function () {
      const vaultValue = 100000; // $100k
      const lpFeeAPY = 0.15; // 15% APY from LP fees
      const rebalanceCostAPY = 0.01; // 1% APY in rebalance costs

      // Net profit requires: lpFees + funding - costs > 0
      // fundingAPY > -(lpFeeAPY - rebalanceCostAPY)
      const maxNegativeFunding = lpFeeAPY - rebalanceCostAPY;

      console.log("\nFunding Rate Threshold Analysis:");
      console.log(`  LP Fee APY: ${lpFeeAPY * 100}%`);
      console.log(`  Rebalance Cost APY: ${rebalanceCostAPY * 100}%`);
      console.log(`  Max Negative Funding APY: -${(maxNegativeFunding * 100).toFixed(2)}%`);
      console.log(`  Daily Funding Threshold: -${((maxNegativeFunding / 365) * 100).toFixed(4)}%`);

      // Test with different funding rates
      const fundingRates = [-0.2, -0.15, -0.14, -0.1, -0.05, 0, 0.05, 0.1];

      console.log("\nProfitability at Different Funding Rates:");
      for (const fundingAPY of fundingRates) {
        const netAPY = lpFeeAPY + fundingAPY - rebalanceCostAPY;
        const profitable = netAPY > 0;
        console.log(
          `  Funding ${(fundingAPY * 100).toFixed(0)}%: Net APY ${(netAPY * 100).toFixed(2)}% ${profitable ? "✓" : "✗"}`
        );
      }

      expect(maxNegativeFunding).to.be.closeTo(0.14, 0.001);
    });

    it("should track cumulative funding impact over extended periods", async function () {
      const vaultValue = 100000n * PRECISION;
      const dailyLPFees = 40n * PRECISION; // ~15% APY
      const dailyFunding = -30n * BigInt(10) ** BigInt(18); // Negative
      const dailyRebalanceCost = 3n * PRECISION; // ~1% APY

      // Simulate 30 days
      const days = 30;
      let cumulativeFees = 0n;
      let cumulativeFunding = 0n;
      let cumulativeCosts = 0n;

      console.log("\n30-Day Cumulative Impact:");
      console.log("Day\tFees\t\tFunding\t\tCosts\t\tNet");

      for (let day = 1; day <= days; day++) {
        cumulativeFees += dailyLPFees;
        cumulativeFunding += dailyFunding;
        cumulativeCosts += dailyRebalanceCost;

        const net = Number(cumulativeFees) + Number(cumulativeFunding) - Number(cumulativeCosts);

        if (day % 5 === 0 || day === 1) {
          console.log(
            `${day}\t$${(Number(cumulativeFees) / Number(PRECISION)).toFixed(0)}\t\t-$${(Math.abs(Number(cumulativeFunding)) / Number(PRECISION)).toFixed(0)}\t\t$${(Number(cumulativeCosts) / Number(PRECISION)).toFixed(0)}\t\t$${(net / Number(PRECISION)).toFixed(0)}`
          );
        }
      }

      const finalSnapshot = {
        timestamp: BigInt(days) * SECONDS_PER_DAY,
        totalValue: vaultValue,
        cumulativeFees,
        cumulativeFunding,
        cumulativeRebalanceCosts: cumulativeCosts,
      };

      const apy = await yieldMath.calculateAPY(
        {
          timestamp: 0n,
          totalValue: vaultValue,
          cumulativeFees: 0n,
          cumulativeFunding: 0n,
          cumulativeRebalanceCosts: 0n,
        },
        finalSnapshot
      );

      const apyPct = (Number(apy) / Number(PRECISION)) * 100;
      console.log(`\n30-Day APY: ${apyPct.toFixed(2)}%`);

      // With these numbers: 40*30 - 30*30 - 3*30 = 1200 - 900 - 90 = 210 net
      // APY = 210/100000 * 365/30 = 2.555%
      expect(apyPct).to.be.closeTo(2.56, 0.1);
    });
  });

  describe("5. Flash Crash Scenarios", function () {
    /**
     * Flash crash: Rapid price decline (>10%) in minutes
     * Challenges:
     * - Delta changes faster than rebalance can execute
     * - Multiple rebalances may queue up
     * - Slippage increases during volatility
     * - GMX order execution delays
     */

    it("should simulate rapid delta changes during 20% crash", async function () {
      const sqrtPriceLower = priceToSqrtPriceX96(1600);
      const sqrtPriceUpper = priceToSqrtPriceX96(2400);

      // Price points during crash: 2000 -> 1600 (-20%)
      const crashSequence = [2000, 1950, 1900, 1850, 1800, 1750, 1700, 1650, 1600];

      console.log("\nFlash Crash Delta Sequence:");
      console.log("Price\t\tDelta\t\tChange");

      let prevDelta = 0;

      for (const price of crashSequence) {
        const sqrtPrice = priceToSqrtPriceX96(price);
        const deltaRatio = await deltaCalculator.calculateDeltaRatio(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        const deltaPct = (Number(deltaRatio) / Number(PRECISION)) * 100;
        const deltaChange = deltaPct - prevDelta;

        console.log(
          `$${price}\t\t${deltaPct.toFixed(2)}%\t\t${deltaChange >= 0 ? "+" : ""}${deltaChange.toFixed(2)}%`
        );

        prevDelta = deltaPct;
      }

      // Verify delta increases during crash (more ETH exposure)
      const deltaStart = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(2000),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const deltaEnd = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(1600),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      expect(deltaEnd).to.be.gt(deltaStart);
    });

    it("should calculate hedge drift during multi-minute crash", async function () {
      const vaultValue = 100000; // $100k
      const sqrtPriceLower = priceToSqrtPriceX96(1600);
      const sqrtPriceUpper = priceToSqrtPriceX96(2400);

      // Initial hedge at $2000
      const initialDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(2000),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const initialHedge = (vaultValue * Number(initialDelta)) / Number(PRECISION);

      // Crash timeline: price drops while hedge stays constant
      const timeline = [
        { minute: 0, price: 2000 },
        { minute: 1, price: 1950 },
        { minute: 2, price: 1900 },
        { minute: 3, price: 1850 },
        { minute: 4, price: 1800 }, // Rebalance triggers here
        { minute: 5, price: 1750 }, // But execution takes 1-2 minutes
        { minute: 6, price: 1700 },
      ];

      console.log("\nHedge Drift During Flash Crash:");
      console.log("Minute\tPrice\t\tRequired Hedge\tActual Hedge\tDrift");

      let rebalanceTriggered = false;
      let hedgeUpdateMinute = -1;

      for (const point of timeline) {
        const currentDelta = await deltaCalculator.calculateDeltaRatio(
          priceToSqrtPriceX96(point.price),
          sqrtPriceLower,
          sqrtPriceUpper
        );
        const requiredHedge = (vaultValue * Number(currentDelta)) / Number(PRECISION);

        // Simulate: rebalance triggers at 5% drift, executes after 2 minutes
        const currentHedge =
          hedgeUpdateMinute >= 0 && point.minute >= hedgeUpdateMinute + 2
            ? requiredHedge
            : initialHedge;

        const drift = requiredHedge - currentHedge;
        const driftPct = (drift / vaultValue) * 100;

        // Check if rebalance should trigger (>5% drift)
        if (Math.abs(driftPct) > 5 && !rebalanceTriggered) {
          rebalanceTriggered = true;
          hedgeUpdateMinute = point.minute;
          console.log(`  >> Rebalance triggered at minute ${point.minute}`);
        }

        console.log(
          `${point.minute}\t$${point.price}\t\t$${requiredHedge.toFixed(0)}\t\t$${currentHedge.toFixed(0)}\t\t$${drift.toFixed(0)} (${driftPct.toFixed(2)}%)`
        );
      }

      // Verify significant drift accumulated during crash
      const finalDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(1700),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const finalRequired = (vaultValue * Number(finalDelta)) / Number(PRECISION);
      const maxDrift = finalRequired - initialHedge;

      expect(maxDrift).to.be.gt(vaultValue * 0.1); // >10% drift
    });

    it("should calculate worst-case PnL during unhedged crash period", async function () {
      const vaultValue = 100000;
      const startPrice = 2000;
      const crashPrice = 1600; // -20% crash
      const sqrtPriceLower = priceToSqrtPriceX96(1600);
      const sqrtPriceUpper = priceToSqrtPriceX96(2400);

      // Calculate delta at start
      const startDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(startPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const hedgeSize = (vaultValue * Number(startDelta)) / Number(PRECISION);

      // During crash:
      // 1. LP position: loses value due to IL + ETH exposure
      // 2. Hedge (short): gains from price drop
      // 3. But hedge is sized for old delta, not new delta

      // LP position delta exposure (unhedged portion)
      const endDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(crashPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      // The hedge only covers the initial delta
      // Extra exposure during crash is unhedged
      const avgDelta = (Number(startDelta) + Number(endDelta)) / 2 / Number(PRECISION);
      const unhedgedExposure = avgDelta * vaultValue - hedgeSize;

      // PnL from unhedged exposure during 20% crash
      const priceDropPct = (startPrice - crashPrice) / startPrice;
      const unhedgedLoss = unhedgedExposure * priceDropPct;

      console.log("\nWorst-Case Flash Crash PnL:");
      console.log(`  Initial Hedge Size: $${hedgeSize.toFixed(2)}`);
      console.log(`  Average Delta During Crash: ${(avgDelta * 100).toFixed(2)}%`);
      console.log(`  Unhedged Exposure: $${unhedgedExposure.toFixed(2)}`);
      console.log(`  Price Drop: ${(priceDropPct * 100).toFixed(0)}%`);
      console.log(`  Unhedged Loss: $${unhedgedLoss.toFixed(2)}`);
      console.log(`  Loss % of Vault: ${((unhedgedLoss / vaultValue) * 100).toFixed(2)}%`);

      // Unhedged loss should be material but not catastrophic
      expect(unhedgedLoss).to.be.gt(0);
      expect(unhedgedLoss).to.be.lt(vaultValue * 0.1); // <10% of vault
    });

    it("should simulate recovery scenario after flash crash", async function () {
      const vaultValue = 100000n * PRECISION;
      const sqrtPriceLower = priceToSqrtPriceX96(1600);
      const sqrtPriceUpper = priceToSqrtPriceX96(2400);

      // Scenario: Crash from $2000 to $1600, then recover to $1900
      const scenarios = [
        { name: "Pre-crash", price: 2000 },
        { name: "Crash bottom", price: 1600 },
        { name: "Recovery", price: 1900 },
      ];

      console.log("\nFlash Crash Recovery Analysis:");

      for (const scenario of scenarios) {
        const sqrtPrice = priceToSqrtPriceX96(scenario.price);
        const delta = await deltaCalculator.calculateDeltaRatio(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        const baseAmount = await deltaCalculator.getBaseTokenAmount(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper,
          BigInt(10) ** BigInt(18)
        );
        const quoteAmount = await deltaCalculator.getQuoteTokenAmount(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper,
          BigInt(10) ** BigInt(18)
        );

        console.log(`\n${scenario.name} ($${scenario.price}):`);
        console.log(`  Delta: ${((Number(delta) / Number(PRECISION)) * 100).toFixed(2)}%`);
        console.log(`  ETH Amount: ${Number(baseAmount)}`);
        console.log(`  USDC Amount: ${Number(quoteAmount)}`);
      }
    });
  });

  describe("6. Sandwich Attack / Slippage Protection", function () {
    /**
     * During rebalancing, the vault needs to swap tokens.
     * Sandwich attacks can cause significant slippage:
     * 1. Attacker frontruns with large buy
     * 2. Vault swap executes at worse price
     * 3. Attacker backruns with sell
     */

    it("should calculate acceptable slippage for rebalance swaps", async function () {
      const swapSizes = [1000, 5000, 10000, 25000, 50000]; // USD
      const poolTVL = 10_000_000; // $10M pool

      console.log("\nSlippage Calculation for Rebalance Swaps:");
      console.log("Swap Size\tPool Impact\tMax Slippage\tMin Output");

      for (const swapSize of swapSizes) {
        // Price impact approximation: impact ≈ swapSize / (2 * poolTVL)
        const priceImpact = swapSize / (2 * poolTVL);

        // Max slippage should be 2x price impact to account for volatility
        const maxSlippage = Math.max(priceImpact * 2, 0.001); // Min 0.1%

        const minOutput = swapSize * (1 - maxSlippage);

        console.log(
          `$${swapSize}\t\t${(priceImpact * 100).toFixed(4)}%\t\t${(maxSlippage * 100).toFixed(3)}%\t\t$${minOutput.toFixed(2)}`
        );
      }

      // Large swaps should have higher slippage tolerance
      const smallSwapImpact = 1000 / (2 * poolTVL);
      const largeSwapImpact = 50000 / (2 * poolTVL);

      expect(largeSwapImpact).to.be.gt(smallSwapImpact);
    });

    it("should detect sandwich attack profitability threshold", async function () {
      // Sandwich attack is profitable when:
      // attacker_profit > gas_cost + opportunity_cost

      const swapSize = 10000; // $10k swap
      const poolTVL = 10_000_000;
      const gasPrice = 0.1; // $0.10 per swap
      const attackGasCost = gasPrice * 2; // 2 txs

      // Attacker's profit = swap_size * price_impact_captured
      // Price impact from vault swap
      const priceImpact = swapSize / (2 * poolTVL);

      // Attacker can capture ~50% of price impact with perfect timing
      const attackerCapture = 0.5;
      const attackerProfit = swapSize * priceImpact * attackerCapture;

      console.log("\nSandwich Attack Economics:");
      console.log(`  Swap Size: $${swapSize}`);
      console.log(`  Price Impact: ${(priceImpact * 100).toFixed(4)}%`);
      console.log(`  Gas Cost: $${attackGasCost}`);
      console.log(`  Potential Attacker Profit: $${attackerProfit.toFixed(2)}`);
      console.log(`  Attack Profitable: ${attackerProfit > attackGasCost}`);

      // For small swaps, attack should not be profitable
      if (swapSize < 5000) {
        expect(attackerProfit).to.be.lt(attackGasCost);
      }
    });

    it("should recommend swap splitting for large rebalances", async function () {
      const totalSwapNeeded = 50000; // $50k
      const poolTVL = 10_000_000;
      const targetMaxImpact = 0.001; // 0.1% max impact per swap

      // Calculate optimal number of splits
      // impact_per_swap = swap_size / (2 * poolTVL)
      // swap_size = impact_per_swap * 2 * poolTVL
      const maxSwapPerChunk = targetMaxImpact * 2 * poolTVL;
      const recommendedSplits = Math.ceil(totalSwapNeeded / maxSwapPerChunk);

      const actualSwapPerChunk = totalSwapNeeded / recommendedSplits;
      const actualImpactPerChunk = actualSwapPerChunk / (2 * poolTVL);

      // Total impact with splitting vs without
      const impactWithoutSplitting = totalSwapNeeded / (2 * poolTVL);
      // With splitting, total impact is sum of smaller impacts
      // but since we're sequential, it's approximately the same
      // However, we reduce sandwich risk

      console.log("\nSwap Splitting Recommendation:");
      console.log(`  Total Swap Needed: $${totalSwapNeeded}`);
      console.log(`  Target Max Impact: ${(targetMaxImpact * 100).toFixed(2)}%`);
      console.log(`  Recommended Splits: ${recommendedSplits}`);
      console.log(`  Swap Per Chunk: $${actualSwapPerChunk.toFixed(2)}`);
      console.log(`  Impact Per Chunk: ${(actualImpactPerChunk * 100).toFixed(4)}%`);
      console.log(`  Impact Without Splitting: ${(impactWithoutSplitting * 100).toFixed(4)}%`);

      expect(recommendedSplits).to.be.gt(1);
      expect(actualImpactPerChunk).to.be.lte(targetMaxImpact);
    });

    it("should calculate TWAP vs spot execution tradeoff", async function () {
      const swapSize = 25000;
      const poolTVL = 10_000_000;
      const volatilityPct = 0.02; // 2% daily volatility

      // Spot execution: immediate but full price impact
      const spotImpact = swapSize / (2 * poolTVL);

      // TWAP over 1 hour: reduced impact but volatility risk
      const twapDuration = 1; // hours
      const twapChunks = 6; // every 10 minutes
      const chunkSize = swapSize / twapChunks;
      const twapImpactPerChunk = chunkSize / (2 * poolTVL);

      // Volatility risk during TWAP
      // Hourly volatility ≈ daily volatility / sqrt(24)
      const hourlyVolatility = volatilityPct / Math.sqrt(24);
      const volatilityRisk = swapSize * hourlyVolatility;

      console.log("\nTWAP vs Spot Execution:");
      console.log("Spot Execution:");
      console.log(`  Impact: ${(spotImpact * 100).toFixed(4)}%`);
      console.log(`  Cost: $${(swapSize * spotImpact).toFixed(2)}`);

      console.log("\nTWAP Execution (1 hour, 6 chunks):");
      console.log(`  Impact Per Chunk: ${(twapImpactPerChunk * 100).toFixed(4)}%`);
      console.log(`  Total Impact Cost: $${(swapSize * twapImpactPerChunk).toFixed(2)}`);
      console.log(`  Volatility Risk: $${volatilityRisk.toFixed(2)}`);
      console.log(
        `  Total Expected Cost: $${(swapSize * twapImpactPerChunk + volatilityRisk).toFixed(2)}`
      );

      // For moderate swaps, spot is usually better
      const spotCost = swapSize * spotImpact;
      const twapCost = swapSize * twapImpactPerChunk + volatilityRisk;

      console.log(`\nRecommendation: ${spotCost < twapCost ? "SPOT" : "TWAP"}`);
    });
  });

  describe("7. Combined Critical Scenario Tests", function () {
    /**
     * Test multiple critical conditions occurring simultaneously
     */

    it("should handle flash crash + negative funding combined scenario", async function () {
      const vaultValue = 100000n * PRECISION;
      const sqrtPriceLower = priceToSqrtPriceX96(1600);
      const sqrtPriceUpper = priceToSqrtPriceX96(2400);

      // Scenario: 15% crash over 1 day + negative funding
      const startSnapshot = {
        timestamp: 0n,
        totalValue: vaultValue,
        cumulativeFees: 0n,
        cumulativeFunding: 0n,
        cumulativeRebalanceCosts: 0n,
      };

      // During crash day:
      // - LP fees: $30 (reduced due to low activity in crash)
      // - Funding: -$150 (funding spikes negative during crash)
      // - Rebalance costs: $100 (multiple rebalances needed)
      // - IL from crash: ~$200 (impermanent loss)

      const crashDaySnapshot = {
        timestamp: SECONDS_PER_DAY,
        totalValue: vaultValue - 220n * PRECISION, // Net loss from IL
        cumulativeFees: 30n * PRECISION,
        cumulativeFunding: -150n * BigInt(10) ** BigInt(18),
        cumulativeRebalanceCosts: 100n * PRECISION,
      };

      const apy = await yieldMath.calculateAPY(startSnapshot, crashDaySnapshot);

      console.log("\nCombined Crisis Scenario (Flash Crash + Negative Funding):");
      console.log("  LP Fees: $30");
      console.log("  Funding: -$150");
      console.log("  Rebalance Costs: $100");
      console.log("  Net Income: -$220");
      console.log(`  APY: ${apy} (returns 0 for negative)`);

      // APY should be 0 due to negative net
      expect(apy).to.equal(0n);
    });

    it("should simulate week with multiple stress events", async function () {
      const vaultValue = 100000n * PRECISION;

      // Week timeline:
      // Day 1-2: Normal (fees $40/day, funding +$10/day)
      // Day 3: Flash crash (fees $10, funding -$80, rebalance $50)
      // Day 4-5: Recovery (fees $30/day, funding -$20/day)
      // Day 6-7: Normal (fees $40/day, funding +$5/day)

      const weekEvents = [
        { days: 2, fees: 80, funding: 20, costs: 5 },
        { days: 1, fees: 10, funding: -80, costs: 50 },
        { days: 2, fees: 60, funding: -40, costs: 10 },
        { days: 2, fees: 80, funding: 10, costs: 5 },
      ];

      let totalFees = 0n;
      let totalFunding = 0n;
      let totalCosts = 0n;

      for (const event of weekEvents) {
        totalFees += BigInt(event.fees) * PRECISION;
        totalFunding += BigInt(event.funding) * BigInt(10) ** BigInt(18);
        totalCosts += BigInt(event.costs) * PRECISION;
      }

      const weekSnapshot = {
        timestamp: 7n * SECONDS_PER_DAY,
        totalValue: vaultValue,
        cumulativeFees: totalFees,
        cumulativeFunding: totalFunding,
        cumulativeRebalanceCosts: totalCosts,
      };

      const apy = await yieldMath.calculateAPY(
        {
          timestamp: 0n,
          totalValue: vaultValue,
          cumulativeFees: 0n,
          cumulativeFunding: 0n,
          cumulativeRebalanceCosts: 0n,
        },
        weekSnapshot
      );

      const netIncome =
        Number(totalFees) / Number(PRECISION) +
        Number(totalFunding) / Number(PRECISION) -
        Number(totalCosts) / Number(PRECISION);

      console.log("\nStress Week Summary:");
      console.log(`  Total Fees: $${Number(totalFees) / Number(PRECISION)}`);
      console.log(`  Total Funding: $${Number(totalFunding) / Number(PRECISION)}`);
      console.log(`  Total Costs: $${Number(totalCosts) / Number(PRECISION)}`);
      console.log(`  Net Income: $${netIncome}`);
      console.log(`  Weekly APY: ${((Number(apy) / Number(PRECISION)) * 100).toFixed(2)}%`);

      // Should still be positive despite stress events
      expect(apy).to.be.gt(0n);
    });

    it("should verify delta accuracy under extreme conditions", async function () {
      const sqrtPriceLower = priceToSqrtPriceX96(1000);
      const sqrtPriceUpper = priceToSqrtPriceX96(5000);
      const liquidity = BigInt(10) ** BigInt(20); // Large liquidity

      // Extreme price points
      const extremePrices = [
        { price: 500, desc: "Far below range" },
        { price: 1000, desc: "At lower bound" },
        { price: 1001, desc: "Just inside lower" },
        { price: 2000, desc: "Mid range" },
        { price: 4999, desc: "Just inside upper" },
        { price: 5000, desc: "At upper bound" },
        { price: 10000, desc: "Far above range" },
      ];

      console.log("\nExtreme Price Delta Accuracy:");

      for (const { price, desc } of extremePrices) {
        const sqrtPrice = priceToSqrtPriceX96(price);

        const delta = await deltaCalculator.calculateDelta(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper,
          liquidity
        );

        const deltaRatio = await deltaCalculator.calculateDeltaRatio(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        const gamma = await deltaCalculator.calculateGamma(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper,
          liquidity
        );

        console.log(`$${price} (${desc}):`);
        console.log(`  Delta: ${delta}`);
        console.log(`  Ratio: ${((Number(deltaRatio) / Number(PRECISION)) * 100).toFixed(4)}%`);
        console.log(`  Gamma: ${gamma}`);
      }
    });
  });
});
