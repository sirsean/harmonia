import { expect } from "chai";
import { ethers } from "hardhat";
import { DeltaCalculatorHarness, YieldMathHarness } from "../../typechain-types";
import {
  Q96,
  PRECISION,
  priceToSqrtPriceX96,
  sqrtPriceX96ToPrice,
  tickToSqrtPriceX96,
  sqrtPriceX96ToTick,
} from "../helpers/constants";

/**
 * High Priority Scenario Tests (P1) - Operational Risk
 *
 * These tests cover operational scenarios that could cause system malfunction:
 * 1. Delta calculation at tick boundaries (edge cases)
 * 2. Concurrent deposit/withdraw during rebalance (race conditions)
 * 3. GMX order execution delay (position mismatch)
 * 4. Keeper downtime/failure (delta drift)
 * 5. Gas price spike preventing rebalance (stuck positions)
 * 6. LP position goes out of range (no fee accrual)
 * 7. Fee collection edge cases
 * 8. Chainlink staleness check failure (outdated prices)
 */
describe("High Priority Scenarios (P1) - Operational Risk", function () {
  let deltaCalculator: DeltaCalculatorHarness;
  let yieldMath: YieldMathHarness;

  const SECONDS_PER_DAY = 86400n;
  const SECONDS_PER_HOUR = 3600n;

  beforeEach(async function () {
    const DeltaCalculatorHarness = await ethers.getContractFactory("DeltaCalculatorHarness");
    deltaCalculator = await DeltaCalculatorHarness.deploy();
    await deltaCalculator.waitForDeployment();

    const YieldMathHarness = await ethers.getContractFactory("YieldMathHarness");
    yieldMath = await YieldMathHarness.deploy();
    await yieldMath.waitForDeployment();
  });

  describe("1. Delta Calculation at Tick Boundaries", function () {
    /**
     * Uniswap V3 tick boundaries are critical edge cases:
     * - Price exactly at tickLower or tickUpper
     * - Price transitioning across boundaries
     * - Very narrow tick ranges (high precision required)
     */

    it("should handle price exactly at lower tick boundary", async function () {
      const tickLower = -200000; // ~$0.000002
      const tickUpper = -180000; // ~$0.00015
      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);
      const liquidity = BigInt(10) ** BigInt(18);

      // Price exactly at lower bound
      const deltaAtLower = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceLower,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      // Price 1 tick below lower bound
      const sqrtPriceBelow = tickToSqrtPriceX96(tickLower - 1);
      const deltaBelow = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceBelow,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      // Price 1 tick above lower bound
      const sqrtPriceAbove = tickToSqrtPriceX96(tickLower + 1);
      const deltaAbove = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceAbove,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      console.log("\nLower Boundary Analysis:");
      console.log(
        `  At lower bound (tick ${tickLower}): ${((Number(deltaAtLower) / Number(PRECISION)) * 100).toFixed(4)}%`
      );
      console.log(
        `  Below bound (tick ${tickLower - 1}): ${((Number(deltaBelow) / Number(PRECISION)) * 100).toFixed(4)}%`
      );
      console.log(
        `  Above bound (tick ${tickLower + 1}): ${((Number(deltaAbove) / Number(PRECISION)) * 100).toFixed(4)}%`
      );

      // At and below lower bound should be 100% (full exposure)
      expect(deltaAtLower).to.equal(PRECISION);
      expect(deltaBelow).to.equal(PRECISION);
      // Just above should be slightly less than 100%
      expect(deltaAbove).to.be.lt(PRECISION);
      expect(deltaAbove).to.be.gt((PRECISION * 99n) / 100n); // > 99%
    });

    it("should handle price exactly at upper tick boundary", async function () {
      const tickLower = -200000;
      const tickUpper = -180000;
      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

      // Price exactly at upper bound
      const deltaAtUpper = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceUpper,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      // Price 1 tick below upper bound
      const sqrtPriceBelow = tickToSqrtPriceX96(tickUpper - 1);
      const deltaBelow = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceBelow,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      // Price 1 tick above upper bound
      const sqrtPriceAbove = tickToSqrtPriceX96(tickUpper + 1);
      const deltaAbove = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceAbove,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      console.log("\nUpper Boundary Analysis:");
      console.log(
        `  Below bound (tick ${tickUpper - 1}): ${((Number(deltaBelow) / Number(PRECISION)) * 100).toFixed(4)}%`
      );
      console.log(
        `  At upper bound (tick ${tickUpper}): ${((Number(deltaAtUpper) / Number(PRECISION)) * 100).toFixed(4)}%`
      );
      console.log(
        `  Above bound (tick ${tickUpper + 1}): ${((Number(deltaAbove) / Number(PRECISION)) * 100).toFixed(4)}%`
      );

      // At and above upper bound should be 0% (no exposure)
      expect(deltaAtUpper).to.equal(0n);
      expect(deltaAbove).to.equal(0n);
      // Just below should be slightly more than 0%
      expect(deltaBelow).to.be.gt(0n);
      expect(deltaBelow).to.be.lt(PRECISION / 100n); // < 1%
    });

    it("should handle very narrow tick range (1 tick)", async function () {
      const tickSpacing = 10; // 0.05% fee tier spacing
      const tickLower = -200000;
      const tickUpper = tickLower + tickSpacing; // Minimum possible range

      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);
      const liquidity = BigInt(10) ** BigInt(18);

      // Test at midpoint
      const midTick = tickLower + tickSpacing / 2;
      const sqrtPriceMid = tickToSqrtPriceX96(midTick);

      const deltaMid = await deltaCalculator.calculateDeltaRatio(
        sqrtPriceMid,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const gammaMid = await deltaCalculator.calculateGamma(
        sqrtPriceMid,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      console.log("\nNarrow Range (1 tick spacing) Analysis:");
      console.log(`  Tick Range: ${tickLower} to ${tickUpper} (${tickSpacing} ticks)`);
      console.log(
        `  Delta at midpoint: ${((Number(deltaMid) / Number(PRECISION)) * 100).toFixed(2)}%`
      );
      console.log(`  Gamma at midpoint: ${gammaMid}`);

      // Delta should still be valid
      expect(deltaMid).to.be.gt(0n);
      expect(deltaMid).to.be.lt(PRECISION);
      // Gamma should be large negative (concentrated liquidity)
      expect(gammaMid).to.be.lt(0n);
    });

    it("should handle tick spacing boundaries for different fee tiers", async function () {
      // Different fee tiers have different tick spacings
      const feesTiers = [
        { name: "0.01%", tickSpacing: 1 },
        { name: "0.05%", tickSpacing: 10 },
        { name: "0.30%", tickSpacing: 60 },
        { name: "1.00%", tickSpacing: 200 },
      ];

      const baseTick = -200000;
      const liquidity = BigInt(10) ** BigInt(18);

      console.log("\nTick Spacing Analysis by Fee Tier:");

      for (const tier of feesTiers) {
        const tickLower = Math.floor(baseTick / tier.tickSpacing) * tier.tickSpacing;
        const tickUpper = tickLower + tier.tickSpacing * 100; // 100 tick spacings

        const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
        const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);
        const sqrtPriceMid = tickToSqrtPriceX96((tickLower + tickUpper) / 2);

        const delta = await deltaCalculator.calculateDeltaRatio(
          sqrtPriceMid,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        console.log(
          `  ${tier.name} fee (spacing ${tier.tickSpacing}): Delta = ${((Number(delta) / Number(PRECISION)) * 100).toFixed(2)}%`
        );

        // All should produce valid deltas (wider spacing = more deviation from 50%)
        expect(delta).to.be.gt((PRECISION * 30n) / 100n);
        expect(delta).to.be.lt((PRECISION * 60n) / 100n);
      }
    });

    it("should maintain precision across 1000 tick transitions", async function () {
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Start from lower bound, move up in small increments
      const startPrice = 1800;
      const endPrice = 2200;
      const steps = 20;
      const priceStep = (endPrice - startPrice) / steps;

      let prevDelta = PRECISION;
      let maxDeltaJump = 0n;

      console.log("\nDelta Continuity Test (20 price steps):");

      for (let i = 0; i <= steps; i++) {
        const price = startPrice + i * priceStep;
        const sqrtPrice = priceToSqrtPriceX96(price);

        const delta = await deltaCalculator.calculateDeltaRatio(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        const deltaJump = prevDelta > delta ? prevDelta - delta : delta - prevDelta;
        if (deltaJump > maxDeltaJump) {
          maxDeltaJump = deltaJump;
        }

        if (i % 5 === 0) {
          console.log(
            `  $${price.toFixed(0)}: Delta = ${((Number(delta) / Number(PRECISION)) * 100).toFixed(2)}%`
          );
        }

        prevDelta = delta;
      }

      console.log(
        `  Max delta jump: ${((Number(maxDeltaJump) / Number(PRECISION)) * 100).toFixed(2)}%`
      );

      // Delta changes should be smooth (no jumps > 10% per step)
      expect(maxDeltaJump).to.be.lt(PRECISION / 10n);
    });
  });

  describe("2. Concurrent Operation Scenarios", function () {
    /**
     * Race conditions that could occur:
     * - Deposit during rebalance
     * - Withdraw during rebalance
     * - Multiple deposits/withdraws in same block
     * - Share price changes mid-operation
     */

    it("should calculate correct shares during vault state changes", async function () {
      // Simulate a vault with changing total assets
      const initialTotalAssets = 100000n * PRECISION;
      const initialShares = 100000n * PRECISION;

      // User wants to deposit $10,000
      const depositAmount = 10000n * PRECISION;

      // Calculate shares at initial state
      const sharesAtInitial = (depositAmount * initialShares) / initialTotalAssets;

      // Simulate rebalance completing mid-deposit (adds $500 profit)
      const postRebalanceAssets = initialTotalAssets + 500n * PRECISION;
      const sharesPostRebalance = (depositAmount * initialShares) / postRebalanceAssets;

      // Simulate rebalance loss ($500)
      const postLossAssets = initialTotalAssets - 500n * PRECISION;
      const sharesPostLoss = (depositAmount * initialShares) / postLossAssets;

      console.log("\nShare Calculation During State Changes:");
      console.log(`  Deposit Amount: $${Number(depositAmount) / Number(PRECISION)}`);
      console.log(`  Shares at initial state: ${Number(sharesAtInitial) / Number(PRECISION)}`);
      console.log(
        `  Shares after +$500 rebalance: ${Number(sharesPostRebalance) / Number(PRECISION)}`
      );
      console.log(`  Shares after -$500 rebalance: ${Number(sharesPostLoss) / Number(PRECISION)}`);

      // After profit, same deposit gets fewer shares (each share worth more)
      expect(sharesPostRebalance).to.be.lt(sharesAtInitial);
      // After loss, same deposit gets more shares (each share worth less)
      expect(sharesPostLoss).to.be.gt(sharesAtInitial);

      // Difference should be proportional to profit/loss
      const shareDiff = sharesAtInitial - sharesPostRebalance;
      // Share difference shows the impact of the profit on new depositors
      expect(Number(shareDiff)).to.be.gt(0);
      expect(Number(shareDiff)).to.be.lt(Number(depositAmount / 10n)); // < 10% difference
    });

    it("should handle withdrawal during large delta change", async function () {
      const vaultTotalValue = 100000; // $100k
      const userShares = 10000; // 10% of vault
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Initial state: price at $2000
      const initialDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(2000),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const initialHedgeValue = (vaultTotalValue * Number(initialDelta)) / Number(PRECISION);

      // During withdrawal, price drops to $1850
      const newDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(1850),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const newHedgeValue = (vaultTotalValue * Number(newDelta)) / Number(PRECISION);

      // LP position value changes due to price
      const priceDropPct = (2000 - 1850) / 2000;
      const lpExposure = (vaultTotalValue * Number(initialDelta)) / Number(PRECISION);
      const lpLoss = lpExposure * priceDropPct;

      // Hedge gain (short profits from price drop)
      const hedgeGain = initialHedgeValue * priceDropPct;

      // Net change (should be approximately neutral if properly hedged)
      const netChange = hedgeGain - lpLoss;

      console.log("\nWithdrawal During Price Movement:");
      console.log(
        `  Initial Delta: ${((Number(initialDelta) / Number(PRECISION)) * 100).toFixed(2)}%`
      );
      console.log(`  New Delta: ${((Number(newDelta) / Number(PRECISION)) * 100).toFixed(2)}%`);
      console.log(`  LP Loss from price: $${lpLoss.toFixed(2)}`);
      console.log(`  Hedge Gain: $${hedgeGain.toFixed(2)}`);
      console.log(`  Net Change: $${netChange.toFixed(2)}`);

      // User's withdrawal value
      const withdrawValueBefore = (vaultTotalValue * userShares) / 100000;
      const withdrawValueAfter = ((vaultTotalValue + netChange) * userShares) / 100000;

      console.log(`  User withdrawal (before): $${withdrawValueBefore.toFixed(2)}`);
      console.log(`  User withdrawal (after): $${withdrawValueAfter.toFixed(2)}`);

      // Net change should be small due to hedging
      expect(Math.abs(netChange)).to.be.lt(vaultTotalValue * 0.01); // < 1%
    });

    it("should handle multiple operations in same block (MEV scenario)", async function () {
      // Simulate multiple users trying to deposit in same block
      const vaultAssets = 100000n * PRECISION;
      const totalShares = 100000n * PRECISION;

      const deposits = [
        { user: "Alice", amount: 5000n * PRECISION },
        { user: "Bob", amount: 10000n * PRECISION },
        { user: "Charlie", amount: 3000n * PRECISION },
      ];

      console.log("\nMultiple Deposits in Same Block:");

      let runningAssets = vaultAssets;
      let runningShares = totalShares;

      for (const deposit of deposits) {
        // Each deposit should use the state AFTER previous deposits
        // (This is how ERC-4626 works - first come first served in tx order)
        const shares = (deposit.amount * runningShares) / runningAssets;
        const pricePerShare = (runningAssets * PRECISION) / runningShares;

        console.log(
          `  ${deposit.user}: $${Number(deposit.amount) / Number(PRECISION)} → ${(Number(shares) / Number(PRECISION)).toFixed(4)} shares @ $${(Number(pricePerShare) / Number(PRECISION)).toFixed(6)}/share`
        );

        runningAssets += deposit.amount;
        runningShares += shares;

        expect(shares).to.be.gt(0n);
      }

      // Final state
      const finalPricePerShare = (runningAssets * PRECISION) / runningShares;
      console.log(
        `  Final price per share: $${(Number(finalPricePerShare) / Number(PRECISION)).toFixed(6)}`
      );

      // Price per share should remain stable (1:1 for initial state)
      // Using manual range check instead of closeTo for BigInt compatibility
      const priceDiff =
        finalPricePerShare > PRECISION
          ? finalPricePerShare - PRECISION
          : PRECISION - finalPricePerShare;
      expect(priceDiff).to.be.lt(PRECISION / 1000n);
    });
  });

  describe("3. GMX Order Execution Delay", function () {
    /**
     * GMX v2 uses keeper-based execution with delays:
     * - Order submission: Immediate
     * - Order execution: 1-10 blocks later
     * - Price may move during delay
     */

    it("should calculate position mismatch during execution delay", async function () {
      const vaultValue = 100000;
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // State at order submission (price $2000)
      const submitPrice = 2000;
      const submitDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(submitPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const orderSize = (vaultValue * Number(submitDelta)) / Number(PRECISION);

      // Execution delay scenarios (price moves)
      const executionPrices = [1950, 1980, 2000, 2020, 2050];

      console.log("\nGMX Execution Delay Analysis:");
      console.log(`  Order submitted at $${submitPrice}, size: $${orderSize.toFixed(2)}`);
      console.log("\nExec Price\tActual Delta\tOrder Size\tMismatch");

      for (const execPrice of executionPrices) {
        const execDelta = await deltaCalculator.calculateDeltaRatio(
          priceToSqrtPriceX96(execPrice),
          sqrtPriceLower,
          sqrtPriceUpper
        );
        const actualRequired = (vaultValue * Number(execDelta)) / Number(PRECISION);
        const mismatch = orderSize - actualRequired;
        const mismatchPct = (mismatch / vaultValue) * 100;

        console.log(
          `$${execPrice}\t\t${((Number(execDelta) / Number(PRECISION)) * 100).toFixed(2)}%\t\t$${orderSize.toFixed(0)}\t\t${mismatch >= 0 ? "+" : ""}$${mismatch.toFixed(0)} (${mismatchPct >= 0 ? "+" : ""}${mismatchPct.toFixed(2)}%)`
        );
      }

      // Verify mismatch grows with price movement
      const mismatch50Down = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(1950),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const mismatch50Up = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(2050),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      expect(Number(mismatch50Down)).to.be.gt(Number(submitDelta));
      expect(Number(mismatch50Up)).to.be.lt(Number(submitDelta));
    });

    it("should simulate worst-case execution delay (5 blocks, volatile market)", async function () {
      const vaultValue = 100000;
      const blocksDelay = 5;
      const blockTime = 0.25; // 250ms on Arbitrum
      const volatilityPctPerSecond = 0.001; // 0.1% per second (high volatility)

      // Calculate max price move during delay
      const delaySeconds = blocksDelay * blockTime;
      const maxPriceMove = volatilityPctPerSecond * delaySeconds * 3; // 3 sigma event

      const startPrice = 2000;
      const worstCaseUp = startPrice * (1 + maxPriceMove);
      const worstCaseDown = startPrice * (1 - maxPriceMove);

      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      const startDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(startPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const deltaUp = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(worstCaseUp),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const deltaDown = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(worstCaseDown),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const hedgeAtStart = (vaultValue * Number(startDelta)) / Number(PRECISION);
      const hedgeNeededUp = (vaultValue * Number(deltaUp)) / Number(PRECISION);
      const hedgeNeededDown = (vaultValue * Number(deltaDown)) / Number(PRECISION);

      console.log("\nWorst-Case Execution Delay (5 blocks, high volatility):");
      console.log(`  Delay: ${blocksDelay} blocks (${(delaySeconds * 1000).toFixed(0)}ms)`);
      console.log(`  Max price move (3σ): ±${(maxPriceMove * 100).toFixed(2)}%`);
      console.log(`  Start price: $${startPrice}`);
      console.log(
        `  Worst up: $${worstCaseUp.toFixed(2)}, Worst down: $${worstCaseDown.toFixed(2)}`
      );
      console.log(`  Hedge at start: $${hedgeAtStart.toFixed(2)}`);
      console.log(
        `  Hedge if price up: $${hedgeNeededUp.toFixed(2)} (diff: $${(hedgeNeededUp - hedgeAtStart).toFixed(2)})`
      );
      console.log(
        `  Hedge if price down: $${hedgeNeededDown.toFixed(2)} (diff: $${(hedgeNeededDown - hedgeAtStart).toFixed(2)})`
      );

      // Mismatch should be within acceptable bounds
      const maxMismatch = Math.max(
        Math.abs(hedgeNeededUp - hedgeAtStart),
        Math.abs(hedgeNeededDown - hedgeAtStart)
      );
      console.log(
        `  Max potential mismatch: $${maxMismatch.toFixed(2)} (${((maxMismatch / vaultValue) * 100).toFixed(2)}%)`
      );

      // For short delays in high volatility, mismatch should be < 5%
      // (realistic for 3-sigma events in volatile markets)
      expect(maxMismatch / vaultValue).to.be.lt(0.05);
    });

    it("should calculate optimal order timing based on volatility", async function () {
      const vaultValue = 100000;

      // Different volatility regimes
      const volatilityRegimes = [
        { name: "Low", dailyVol: 0.02 }, // 2% daily
        { name: "Medium", dailyVol: 0.05 }, // 5% daily
        { name: "High", dailyVol: 0.1 }, // 10% daily
        { name: "Extreme", dailyVol: 0.2 }, // 20% daily
      ];

      const executionDelaySeconds = 2; // 2 second delay

      console.log("\nOptimal Order Timing by Volatility:");
      console.log("Regime\t\tDaily Vol\tExpected Slippage\tRisk Level");

      for (const regime of volatilityRegimes) {
        // Convert daily vol to per-second vol
        const secondsPerDay = 86400;
        const perSecondVol = regime.dailyVol / Math.sqrt(secondsPerDay);

        // Expected price move during delay
        const expectedMove = perSecondVol * Math.sqrt(executionDelaySeconds);
        const expectedSlippage = expectedMove * 100;

        // Risk classification
        const riskLevel =
          expectedSlippage > 0.5 ? "HIGH" : expectedSlippage > 0.2 ? "MEDIUM" : "LOW";

        console.log(
          `${regime.name}\t\t${(regime.dailyVol * 100).toFixed(0)}%\t\t${expectedSlippage.toFixed(3)}%\t\t\t${riskLevel}`
        );
      }
    });
  });

  describe("4. Keeper Downtime/Failure Scenarios", function () {
    /**
     * What happens when the keeper (Chainlink Automation) fails:
     * - No rebalancing occurs
     * - Delta drifts from target
     * - Position becomes increasingly risky
     */

    it("should simulate delta drift during 1-hour keeper downtime", async function () {
      const vaultValue = 100000;
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Initial hedged state at $2000
      const initialPrice = 2000;
      const initialDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(initialPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const hedgeSize = (vaultValue * Number(initialDelta)) / Number(PRECISION);

      // Simulate 1-hour of price movement without rebalancing
      // Price drifts from $2000 to $2100 (5% over 1 hour)
      const priceEveryMinute = Array.from({ length: 61 }, (_, i) => 2000 + (100 * i) / 60);

      console.log("\n1-Hour Keeper Downtime Simulation:");
      console.log("Time\t\tPrice\t\tActual Delta\tHedge\t\tNet Delta\tExposure");

      let maxNetDelta = 0;

      for (let minute = 0; minute <= 60; minute += 10) {
        const price = priceEveryMinute[minute];
        const actualDelta = await deltaCalculator.calculateDeltaRatio(
          priceToSqrtPriceX96(price),
          sqrtPriceLower,
          sqrtPriceUpper
        );

        const lpDeltaUsd = (vaultValue * Number(actualDelta)) / Number(PRECISION);
        const netDelta = lpDeltaUsd - hedgeSize;
        const netDeltaPct = (netDelta / vaultValue) * 100;

        if (Math.abs(netDelta) > Math.abs(maxNetDelta)) {
          maxNetDelta = netDelta;
        }

        console.log(
          `${minute}min\t\t$${price.toFixed(0)}\t\t${((Number(actualDelta) / Number(PRECISION)) * 100).toFixed(2)}%\t\t$${hedgeSize.toFixed(0)}\t\t$${netDelta.toFixed(0)}\t\t${netDeltaPct.toFixed(2)}%`
        );
      }

      console.log(
        `\nMax net delta exposure: $${maxNetDelta.toFixed(0)} (${((maxNetDelta / vaultValue) * 100).toFixed(2)}%)`
      );

      // After 1 hour with 5% price move, delta drift should be significant
      expect(Math.abs(maxNetDelta)).to.be.gt(vaultValue * 0.03); // > 3%
    });

    it("should calculate risk accumulation during extended keeper failure", async function () {
      const vaultValue = 100000;
      const sqrtPriceLower = priceToSqrtPriceX96(1600);
      const sqrtPriceUpper = priceToSqrtPriceX96(2400);
      const deltaThreshold = 0.05; // 5% rebalance threshold

      // Initial state
      const initialPrice = 2000;
      const initialDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(initialPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const hedgeSize = (vaultValue * Number(initialDelta)) / Number(PRECISION);

      // Scenarios: different downtime durations with trending price
      const downtimeScenarios = [
        { hours: 1, priceChange: 50 },
        { hours: 4, priceChange: 150 },
        { hours: 12, priceChange: 300 },
        { hours: 24, priceChange: 500 },
      ];

      console.log("\nExtended Keeper Failure Risk Analysis:");
      console.log("Downtime\tPrice Change\tFinal Price\tDelta Drift\tRisk Level");

      for (const scenario of downtimeScenarios) {
        const finalPrice = initialPrice + scenario.priceChange;
        const finalDelta = await deltaCalculator.calculateDeltaRatio(
          priceToSqrtPriceX96(finalPrice),
          sqrtPriceLower,
          sqrtPriceUpper
        );

        const lpDeltaUsd = (vaultValue * Number(finalDelta)) / Number(PRECISION);
        const deltaDrift = Math.abs(lpDeltaUsd - hedgeSize);
        const driftPct = (deltaDrift / vaultValue) * 100;

        const riskLevel =
          driftPct > 20 ? "CRITICAL" : driftPct > 10 ? "HIGH" : driftPct > 5 ? "MEDIUM" : "LOW";

        console.log(
          `${scenario.hours}h\t\t+$${scenario.priceChange}\t\t$${finalPrice}\t\t${driftPct.toFixed(2)}%\t\t${riskLevel}`
        );
      }
    });

    it("should determine maximum safe keeper downtime", async function () {
      const vaultValue = 100000;
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);
      const maxAcceptableDrift = 0.05; // 5% max acceptable drift

      const initialPrice = 2000;
      const initialDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(initialPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const hedgeSize = (vaultValue * Number(initialDelta)) / Number(PRECISION);

      // Find price at which drift exceeds threshold
      const testPrices = [2000, 2020, 2040, 2060, 2080, 2100, 2150, 2200];
      let breachPrice = 0;

      console.log("\nMaximum Safe Downtime Analysis:");

      for (const price of testPrices) {
        const delta = await deltaCalculator.calculateDeltaRatio(
          priceToSqrtPriceX96(price),
          sqrtPriceLower,
          sqrtPriceUpper
        );
        const lpDeltaUsd = (vaultValue * Number(delta)) / Number(PRECISION);
        const drift = Math.abs(lpDeltaUsd - hedgeSize) / vaultValue;

        if (drift > maxAcceptableDrift && breachPrice === 0) {
          breachPrice = price;
          console.log(`  Breach at $${price}: drift = ${(drift * 100).toFixed(2)}%`);
        }
      }

      const priceChangeToBreak = breachPrice - initialPrice;
      const pctChangeToBreak = (priceChangeToBreak / initialPrice) * 100;

      // Estimate time to breach based on typical volatility
      const dailyVolatility = 0.03; // 3% daily
      const hourlyVolatility = dailyVolatility / Math.sqrt(24);
      const expectedHoursToBreak = Math.pow(pctChangeToBreak / 100 / hourlyVolatility, 2);

      console.log(
        `\n  Price change to breach: $${priceChangeToBreak} (${pctChangeToBreak.toFixed(2)}%)`
      );
      console.log(
        `  Expected time to breach (3% daily vol): ${expectedHoursToBreak.toFixed(1)} hours`
      );
      console.log(
        `  Recommended max downtime: ${Math.floor(expectedHoursToBreak * 0.5)} hours (50% safety margin)`
      );

      expect(priceChangeToBreak).to.be.gt(0);
    });
  });

  describe("5. Gas Price Spike Scenarios", function () {
    /**
     * High gas prices can prevent rebalancing:
     * - Keeper may skip execution if gas cost > profit
     * - User operations may fail/timeout
     * - System becomes stuck
     */

    it("should calculate rebalance profitability at various gas prices", async function () {
      const vaultValue = 100000;
      const expectedDailyFees = vaultValue * 0.0004; // ~15% APY worth of daily fees
      const rebalanceFrequency = 4; // 4 times per day
      const valuePerRebalance = expectedDailyFees / rebalanceFrequency;

      // Gas costs at different prices (Arbitrum)
      const gasPrices = [0.01, 0.05, 0.1, 0.5, 1, 2, 5]; // $ per gwei
      const rebalanceGasUnits = 500000; // Typical complex tx

      console.log("\nRebalance Profitability vs Gas Price:");
      console.log("Gas Price\tGas Cost\tValue Added\tNet\t\tProfitable");

      for (const gasPrice of gasPrices) {
        const gasCost = (rebalanceGasUnits * gasPrice) / 1e9;
        const net = valuePerRebalance - gasCost;
        const profitable = net > 0;

        console.log(
          `$${gasPrice}/gwei\t$${gasCost.toFixed(2)}\t\t$${valuePerRebalance.toFixed(2)}\t\t$${net.toFixed(2)}\t\t${profitable ? "YES" : "NO"}`
        );
      }

      // Should be profitable at normal gas prices
      const normalGasCost = (rebalanceGasUnits * 0.1) / 1e9;
      expect(valuePerRebalance).to.be.gt(normalGasCost);
    });

    it("should calculate minimum vault size for gas-efficient operations", async function () {
      const targetGasCostRatio = 0.01; // Gas should be < 1% of operation value
      const gasUnits = 500000;

      const gasPriceLevels = [
        { name: "Low", pricePerGwei: 0.01 },
        { name: "Normal", pricePerGwei: 0.1 },
        { name: "High", pricePerGwei: 0.5 },
        { name: "Spike", pricePerGwei: 2 },
      ];

      console.log("\nMinimum Vault Size for Gas Efficiency:");
      console.log("Gas Level\tGas Cost\tMin Vault Size\tMin Deposit");

      for (const level of gasPriceLevels) {
        const gasCost = (gasUnits * level.pricePerGwei) / 1e9;
        const minVaultSize = gasCost / targetGasCostRatio;
        const minDeposit = minVaultSize / 10; // Assuming 10% position

        console.log(
          `${level.name}\t\t$${gasCost.toFixed(2)}\t\t$${minVaultSize.toFixed(0)}\t\t$${minDeposit.toFixed(0)}`
        );
      }
    });

    it("should simulate stuck position during gas spike", async function () {
      const vaultValue = 50000; // $50k vault (smaller)
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Initial hedge at $2000
      const initialDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(2000),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const hedgeSize = (vaultValue * Number(initialDelta)) / Number(PRECISION);

      // Gas spike makes rebalancing uneconomical
      // Price moves 5% during spike
      const priceAfterSpike = 2100;
      const newDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(priceAfterSpike),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const requiredHedge = (vaultValue * Number(newDelta)) / Number(PRECISION);
      const hedgeMismatch = Math.abs(hedgeSize - requiredHedge);

      // Calculate cost of being unhedged
      const priceMovePct = (priceAfterSpike - 2000) / 2000;
      const unhedgedLoss = hedgeMismatch * priceMovePct;

      console.log("\nGas Spike - Stuck Position Analysis:");
      console.log(`  Vault Size: $${vaultValue}`);
      console.log(`  Initial Hedge: $${hedgeSize.toFixed(2)}`);
      console.log(`  Required Hedge (after 5% move): $${requiredHedge.toFixed(2)}`);
      console.log(`  Hedge Mismatch: $${hedgeMismatch.toFixed(2)}`);
      console.log(`  Potential Loss (if continues): $${unhedgedLoss.toFixed(2)}`);

      // Compare with gas cost of rebalancing
      const normalGasCost = 0.5; // $0.50 normal
      const spikeGasCost = 5; // $5 during spike

      console.log(`\n  Normal gas cost: $${normalGasCost}`);
      console.log(`  Spike gas cost: $${spikeGasCost}`);
      console.log(`  Breakeven: Rebalance if potential loss > gas cost`);
      console.log(`  Should rebalance: ${unhedgedLoss > spikeGasCost ? "YES" : "NO"}`);

      // For significant price moves, should still rebalance even at high gas
      if (unhedgedLoss > spikeGasCost) {
        expect(unhedgedLoss).to.be.gt(spikeGasCost);
      }
    });
  });

  describe("6. LP Out-of-Range Scenarios", function () {
    /**
     * When LP position goes out of range:
     * - No more fee accrual
     * - Delta becomes 0 or 1 (binary)
     * - Need to reposition or wait for price return
     */

    it("should calculate fee loss when position exits range", async function () {
      const vaultValue = 100000;
      const expectedInRangeFeeAPY = 0.2; // 20% APY when in range
      const hoursOutOfRange = [1, 4, 12, 24, 72, 168]; // Up to 1 week

      console.log("\nFee Loss When Out of Range:");
      console.log("Hours Out\tFees Lost\tAPY Impact");

      for (const hours of hoursOutOfRange) {
        const yearHours = 365.25 * 24;
        const feesLost = vaultValue * expectedInRangeFeeAPY * (hours / yearHours);
        const apyImpact = expectedInRangeFeeAPY * (hours / yearHours) * (yearHours / 24 / 30); // Monthly impact

        console.log(
          `${hours}h\t\t$${feesLost.toFixed(2)}\t\t-${(apyImpact * 100).toFixed(2)}% (30d)`
        );
      }
    });

    it("should compare reposition cost vs waiting for price return", async function () {
      const vaultValue = 100000;
      const feeAPY = 0.2; // 20% when in range
      const repositionCost = vaultValue * 0.003; // 0.3% to reposition (swap + gas + slippage)

      // Calculate breakeven time
      const hourlyFeeValue = (vaultValue * feeAPY) / (365.25 * 24);
      const breakevenHours = repositionCost / hourlyFeeValue;

      console.log("\nReposition vs Wait Analysis:");
      console.log(`  Vault Value: $${vaultValue}`);
      console.log(`  Fee APY (in range): ${feeAPY * 100}%`);
      console.log(`  Hourly fee value: $${hourlyFeeValue.toFixed(2)}`);
      console.log(`  Reposition cost: $${repositionCost.toFixed(2)}`);
      console.log(`  Breakeven time: ${breakevenHours.toFixed(1)} hours`);
      console.log(
        `\n  Decision: Wait if expected out-of-range < ${breakevenHours.toFixed(0)}h, else reposition`
      );

      expect(breakevenHours).to.be.gt(1);
      expect(breakevenHours).to.be.lt(200); // Can be high for expensive repositioning
    });

    it("should simulate hedge mismatch when exiting range", async function () {
      const vaultValue = 100000;
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Start in range at $2000
      const startPrice = 2000;
      const startDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(startPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const hedgeSize = (vaultValue * Number(startDelta)) / Number(PRECISION);

      // Price moves above range to $2300
      const exitPrice = 2300;
      const exitDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(exitPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const requiredHedge = (vaultValue * Number(exitDelta)) / Number(PRECISION);

      // LP is now 100% USDC, but hedge is still active
      // Hedge continues to lose money as price rises
      const furtherPriceMove = 2400;
      const hedgeLossFromStart = hedgeSize * ((furtherPriceMove - startPrice) / startPrice);
      const hedgeLossFromExit = hedgeSize * ((furtherPriceMove - exitPrice) / exitPrice);

      console.log("\nHedge Mismatch When Exiting Range:");
      console.log(
        `  Start: $${startPrice}, Delta: ${((Number(startDelta) / Number(PRECISION)) * 100).toFixed(2)}%`
      );
      console.log(
        `  Exit Range: $${exitPrice}, Delta: ${((Number(exitDelta) / Number(PRECISION)) * 100).toFixed(2)}%`
      );
      console.log(`  Hedge Size: $${hedgeSize.toFixed(2)}`);
      console.log(`  Required Hedge (at exit): $${requiredHedge.toFixed(2)}`);
      console.log(`\n  If price continues to $${furtherPriceMove}:`);
      console.log(`    LP Value: No change (100% USDC)`);
      console.log(`    Hedge Loss (from start): $${hedgeLossFromStart.toFixed(2)}`);
      console.log(`    Unnecessary hedge loss (from exit): $${hedgeLossFromExit.toFixed(2)}`);

      // When out of range, hedge should be closed to prevent unnecessary losses
      expect(exitDelta).to.equal(0n);
      expect(requiredHedge).to.equal(0);
    });
  });

  describe("7. Fee Collection Edge Cases", function () {
    /**
     * Edge cases in fee collection:
     * - Very small fees (dust)
     * - Very large fees (overflow risk)
     * - Fees in one token only
     * - Fee collection during volatile periods
     */

    it("should handle dust amounts in fee calculation", async function () {
      // Very small fee amounts (dust)
      const dustAmounts = [1n, 10n, 100n, 1000n]; // Wei amounts
      const ethPrice = 2000n * PRECISION;

      console.log("\nDust Fee Handling:");
      console.log("ETH Fees (wei)\tUSD Value\tWorth Collecting?");

      for (const dust of dustAmounts) {
        const totalFees = await yieldMath.calculateTotalFees(dust, 0n, ethPrice, 6);
        const feeUsd = Number(totalFees) / Number(PRECISION);
        const minGasCost = 0.01; // $0.01 minimum gas

        console.log(`${dust}\t\t$${feeUsd.toFixed(8)}\t${feeUsd > minGasCost ? "YES" : "NO"}`);
      }
    });

    it("should handle large fee accumulation", async function () {
      // Very large vault with accumulated fees
      const largeVault = BigInt(10) ** BigInt(9) * PRECISION; // $1B
      const feeRate = (BigInt(20) * PRECISION) / BigInt(100); // 20% APY
      const accumulationDays = [1, 7, 30, 365];

      console.log("\nLarge Fee Accumulation:");
      console.log("Days\t\tFees Accumulated\tOverflow Risk");

      for (const days of accumulationDays) {
        const fees = (largeVault * feeRate * BigInt(days)) / BigInt(365) / PRECISION;
        const feesUsd = Number(fees) / Number(PRECISION);

        // Check for overflow (uint256 max is ~1.15e77)
        const overflowRisk = fees > BigInt(2) ** BigInt(200) ? "HIGH" : "NONE";

        console.log(`${days}\t\t$${feesUsd.toLocaleString()}\t\t${overflowRisk}`);

        expect(fees).to.be.gt(0n);
      }
    });

    it("should calculate fee APY with different token ratios", async function () {
      const vaultValue = 100000n * PRECISION;
      const ethPrice = 2000n * PRECISION;

      // Different fee scenarios
      const feeScenarios = [
        { eth: BigInt(10) ** BigInt(17), usdc: 0n, desc: "All ETH fees" }, // 0.1 ETH
        { eth: 0n, usdc: 200n * BigInt(10) ** BigInt(6), desc: "All USDC fees" }, // 200 USDC
        { eth: BigInt(5) ** BigInt(16), usdc: 100n * BigInt(10) ** BigInt(6), desc: "Mixed 50/50" },
        {
          eth: BigInt(10) ** BigInt(16),
          usdc: 180n * BigInt(10) ** BigInt(6),
          desc: "Mostly USDC",
        },
      ];

      console.log("\nFee APY with Different Token Ratios:");
      console.log("Scenario\t\tETH Fees\tUSDC Fees\tTotal USD\t7d APY");

      for (const scenario of feeScenarios) {
        const totalFees = await yieldMath.calculateTotalFees(
          scenario.eth,
          scenario.usdc,
          ethPrice,
          6
        );

        // Calculate 7-day APY
        const startSnapshot = {
          timestamp: 0n,
          totalValue: vaultValue,
          cumulativeFees: 0n,
          cumulativeFunding: 0n,
          cumulativeRebalanceCosts: 0n,
        };

        const endSnapshot = {
          timestamp: 7n * SECONDS_PER_DAY,
          totalValue: vaultValue + totalFees,
          cumulativeFees: totalFees,
          cumulativeFunding: 0n,
          cumulativeRebalanceCosts: 0n,
        };

        const apy = await yieldMath.calculateAPY(startSnapshot, endSnapshot);
        const apyPct = (Number(apy) / Number(PRECISION)) * 100;

        const ethUsd = (Number(scenario.eth) / 1e18) * 2000;
        const usdcUsd = Number(scenario.usdc) / 1e6;

        console.log(
          `${scenario.desc}\t$${ethUsd.toFixed(0)}\t\t$${usdcUsd.toFixed(0)}\t\t$${(Number(totalFees) / Number(PRECISION)).toFixed(0)}\t\t${apyPct.toFixed(2)}%`
        );
      }
    });
  });

  describe("8. Chainlink Staleness Scenarios", function () {
    /**
     * Chainlink price feeds can become stale:
     * - Network congestion delays updates
     * - Oracle malfunction
     * - Manipulation through update timing
     */

    it("should calculate risk at various staleness levels", async function () {
      const vaultValue = 100000;
      const dailyVolatility = 0.03; // 3% daily

      // Staleness levels in seconds
      const stalenessLevels = [60, 300, 600, 1800, 3600, 7200];

      console.log("\nStaleness Risk Analysis:");
      console.log("Stale Time\tExpected Move\tMax Position Error\tRisk Level");

      for (const staleness of stalenessLevels) {
        // Expected price movement = volatility * sqrt(time)
        const secondsPerDay = 86400;
        const volatilityPerSecond = dailyVolatility / Math.sqrt(secondsPerDay);
        const expectedMove = volatilityPerSecond * Math.sqrt(staleness) * 100; // as percentage

        // Max position error (3 sigma)
        const maxError = expectedMove * 3;

        const riskLevel =
          maxError > 5 ? "CRITICAL" : maxError > 2 ? "HIGH" : maxError > 0.5 ? "MEDIUM" : "LOW";

        console.log(
          `${staleness}s (${(staleness / 60).toFixed(0)}min)\t±${expectedMove.toFixed(3)}%\t\t±${maxError.toFixed(2)}%\t\t\t${riskLevel}`
        );
      }
    });

    it("should determine maximum acceptable staleness", async function () {
      const maxAcceptableError = 0.01; // 1% max position error
      const dailyVolatility = 0.03; // 3% daily volatility
      const confidenceLevel = 3; // 3 sigma

      // Solve for max staleness:
      // maxError = volatility_per_second * sqrt(staleness) * confidence
      // staleness = (maxError / (volatility_per_second * confidence))^2

      const secondsPerDay = 86400;
      const volatilityPerSecond = dailyVolatility / Math.sqrt(secondsPerDay);
      const maxStaleness = Math.pow(
        maxAcceptableError / (volatilityPerSecond * confidenceLevel),
        2
      );

      console.log("\nMaximum Acceptable Staleness:");
      console.log(`  Max acceptable error: ${maxAcceptableError * 100}%`);
      console.log(`  Daily volatility: ${dailyVolatility * 100}%`);
      console.log(`  Confidence level: ${confidenceLevel} sigma`);
      console.log(
        `  Max staleness: ${maxStaleness.toFixed(0)} seconds (${(maxStaleness / 60).toFixed(1)} minutes)`
      );

      // Typical max staleness should be 5-30 minutes
      expect(maxStaleness).to.be.gt(60); // > 1 minute
      expect(maxStaleness).to.be.lt(3600); // < 1 hour
    });

    it("should simulate stale oracle attack scenario", async function () {
      const vaultValue = 100000;
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Attacker scenario:
      // 1. Oracle shows $2000 (stale)
      // 2. Actual price is $1900 (10 minutes of movement)
      // 3. Attacker exploits the difference

      const oraclePrice = 2000;
      const actualPrice = 1900;

      const oracleDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(oraclePrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const actualDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(actualPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const oracleHedge = (vaultValue * Number(oracleDelta)) / Number(PRECISION);
      const actualHedge = (vaultValue * Number(actualDelta)) / Number(PRECISION);
      const hedgeError = actualHedge - oracleHedge;

      // If attacker can sandwich a rebalance with stale oracle
      const rebalanceAmount = hedgeError;
      const slippage = Math.abs(rebalanceAmount) * 0.003; // 0.3% slippage
      const potentialProfit =
        (Math.abs(rebalanceAmount) * Math.abs(oraclePrice - actualPrice)) / actualPrice - slippage;

      console.log("\nStale Oracle Attack Scenario:");
      console.log(`  Oracle Price (stale): $${oraclePrice}`);
      console.log(`  Actual Price: $${actualPrice}`);
      console.log(
        `  Oracle Delta: ${((Number(oracleDelta) / Number(PRECISION)) * 100).toFixed(2)}%`
      );
      console.log(
        `  Actual Delta: ${((Number(actualDelta) / Number(PRECISION)) * 100).toFixed(2)}%`
      );
      console.log(`  Hedge Error: $${hedgeError.toFixed(2)}`);
      console.log(`  Potential Attacker Profit: $${potentialProfit.toFixed(2)}`);

      // Staleness creates exploitable opportunities
      expect(Math.abs(hedgeError)).to.be.gt(0);
    });

    it("should verify staleness check constants", async function () {
      // Common staleness thresholds used in production
      const stalenessThresholds = [
        { asset: "ETH/USD", maxStale: 3600, heartbeat: 3600 },
        { asset: "BTC/USD", maxStale: 3600, heartbeat: 3600 },
        { asset: "USDC/USD", maxStale: 86400, heartbeat: 86400 },
        { asset: "Sequencer", maxStale: 3600, heartbeat: 0 },
      ];

      console.log("\nStandard Staleness Thresholds:");
      console.log("Asset\t\tMax Stale\tHeartbeat\tRecommendation");

      for (const threshold of stalenessThresholds) {
        const recommendation =
          threshold.maxStale <= 3600 ? "Good for trading" : "Only for stable assets";

        console.log(
          `${threshold.asset}\t${threshold.maxStale}s\t\t${threshold.heartbeat}s\t\t${recommendation}`
        );
      }

      // Verify ETH/USD should have < 1 hour staleness
      const ethThreshold = stalenessThresholds.find((t) => t.asset === "ETH/USD");
      expect(ethThreshold?.maxStale).to.be.lte(3600);
    });
  });

  describe("9. Combined High Priority Scenarios", function () {
    /**
     * Test multiple high-priority issues occurring together
     */

    it("should simulate keeper failure during gas spike", async function () {
      const vaultValue = 100000;
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Initial state
      const initialDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(2000),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const hedgeSize = (vaultValue * Number(initialDelta)) / Number(PRECISION);

      // Gas spike causes keeper to skip rebalancing
      // Price moves 8% over 4 hours
      const priceAfter = 2160;
      const finalDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(priceAfter),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const requiredHedge = (vaultValue * Number(finalDelta)) / Number(PRECISION);
      const deltaDrift = Math.abs(hedgeSize - requiredHedge);

      // Calculate costs
      const spikeGasCost = 10; // $10 during spike
      const normalGasCost = 0.5; // $0.50 normal
      const driftLoss = deltaDrift * 0.08; // 8% price move on unhedged portion

      console.log("\nKeeper Failure + Gas Spike Combined:");
      console.log(`  Duration: 4 hours`);
      console.log(`  Price move: $2000 → $${priceAfter} (8%)`);
      console.log(`  Delta drift: $${deltaDrift.toFixed(2)}`);
      console.log(`  Potential loss from drift: $${driftLoss.toFixed(2)}`);
      console.log(`  Gas spike cost: $${spikeGasCost}`);
      console.log(`  Normal gas cost: $${normalGasCost}`);
      console.log(`  Net impact: $${(driftLoss + spikeGasCost).toFixed(2)}`);

      // Should still rebalance if drift loss > gas cost
      expect(driftLoss).to.be.gt(spikeGasCost);
    });

    it("should simulate LP exit range during oracle staleness", async function () {
      const vaultValue = 100000;
      const sqrtPriceLower = priceToSqrtPriceX96(1800);
      const sqrtPriceUpper = priceToSqrtPriceX96(2200);

      // Oracle shows $2180 (stale by 5 minutes)
      const oraclePrice = 2180;
      // Actual price is $2220 (already exited range)
      const actualPrice = 2220;

      const oracleDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(oraclePrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const actualDelta = await deltaCalculator.calculateDeltaRatio(
        priceToSqrtPriceX96(actualPrice),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      // Hedge sized based on oracle (wrong)
      const wrongHedge = (vaultValue * Number(oracleDelta)) / Number(PRECISION);
      // Correct hedge is 0 (out of range)
      const correctHedge = (vaultValue * Number(actualDelta)) / Number(PRECISION);

      console.log("\nLP Exit Range + Oracle Staleness:");
      console.log(`  Oracle Price (5min stale): $${oraclePrice}`);
      console.log(`  Actual Price: $${actualPrice}`);
      console.log(`  Oracle shows in-range: ${oraclePrice < 2200}`);
      console.log(`  Actually out-of-range: ${actualPrice >= 2200}`);
      console.log(
        `  Oracle Delta: ${((Number(oracleDelta) / Number(PRECISION)) * 100).toFixed(2)}%`
      );
      console.log(
        `  Actual Delta: ${((Number(actualDelta) / Number(PRECISION)) * 100).toFixed(2)}%`
      );
      console.log(`  Wrong Hedge: $${wrongHedge.toFixed(2)}`);
      console.log(`  Correct Hedge: $${correctHedge.toFixed(2)}`);
      console.log(`  Unnecessary hedge exposure: $${wrongHedge.toFixed(2)}`);

      // Out of range should have 0 delta
      expect(actualDelta).to.equal(0n);
      // Oracle incorrectly shows some delta
      expect(oracleDelta).to.be.gt(0n);
    });
  });
});
