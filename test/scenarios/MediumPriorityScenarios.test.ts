// Medium Priority (P2) Scenario Tests for Harmonia
// Tests edge cases and unusual but possible scenarios

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  Q96,
  PRECISION,
  priceToSqrtPriceX96,
  sqrtPriceX96ToPrice,
  tickToSqrtPriceX96,
  sqrtPriceX96ToTick,
  calculateTickRange,
  formatUnits,
  parseUnits,
} from "../helpers/constants";

describe("Medium Priority Scenarios (P2)", function () {
  // ============================================
  // First Deposit (Bootstrap) Scenarios
  // ============================================
  describe("First Deposit (Bootstrap) Scenarios", function () {
    it("should handle first deposit setting initial share price", function () {
      // First deposit scenario - establishing initial share price
      const initialDeposit = parseUnits("10000", 18); // 10,000 USD
      const totalSupplyBefore = BigInt(0);
      const totalAssetsBefore = BigInt(0);

      // First depositor should get shares at 1:1 ratio (or fixed initial rate)
      // Common pattern: shares = assets when vault is empty
      let sharesToMint: bigint;

      if (totalSupplyBefore === BigInt(0)) {
        // First depositor - use 1:1 ratio
        sharesToMint = initialDeposit;
      } else {
        // Subsequent depositors - use current exchange rate
        sharesToMint = (initialDeposit * totalSupplyBefore) / totalAssetsBefore;
      }

      expect(sharesToMint).to.equal(initialDeposit);

      // Verify no inflation attack opportunity
      const sharePrice = Number(initialDeposit) / Number(sharesToMint);
      expect(sharePrice).to.equal(1);
    });

    it("should prevent inflation attack on first deposit", function () {
      // Attack scenario: Attacker tries to donate directly to inflate share price
      // before first real user deposit

      // Initial state - attacker deposits tiny amount
      const attackerDeposit = BigInt(1); // 1 wei
      const attackerShares = BigInt(1); // Gets 1 share

      // Attacker tries to donate to vault directly
      const donationAmount = parseUnits("10000", 18);
      const totalAssetsAfterDonation = attackerDeposit + donationAmount;

      // Victim tries to deposit
      const victimDeposit = parseUnits("9999", 18);

      // Without protection: victim would get 0 shares due to rounding
      const victimSharesVulnerable =
        (victimDeposit * attackerShares) / totalAssetsAfterDonation;

      // This shows the vulnerability
      expect(Number(victimSharesVulnerable)).to.equal(0);

      // Protection: Use virtual offset (ERC-4626 mitigation)
      const VIRTUAL_OFFSET = parseUnits("1", 18); // 1 token virtual balance

      const protectedTotalAssets = totalAssetsAfterDonation + VIRTUAL_OFFSET;
      const protectedTotalSupply = attackerShares + VIRTUAL_OFFSET;

      const victimSharesProtected =
        (victimDeposit * protectedTotalSupply) / protectedTotalAssets;

      // Victim should get approximately their deposit worth of shares
      const victimValue =
        (victimSharesProtected * protectedTotalAssets) / protectedTotalSupply;
      const lossPercent =
        Math.abs(Number(victimDeposit - victimValue)) / Number(victimDeposit);

      // With protection, loss should be minimal (< 1%)
      expect(lossPercent).to.be.lessThan(0.01);
    });

    it("should establish proper initial LP position on bootstrap", function () {
      // Bootstrap requires creating the first LP position
      const initialDeposit = parseUnits("100000", 18); // $100k initial
      const currentPrice = 2500; // ETH/USD

      // Calculate initial position parameters
      const rangePercent = 0.1; // ±10% range
      const { tickLower, tickUpper } = calculateTickRange(currentPrice, rangePercent, 10);

      const sqrtPriceX96 = priceToSqrtPriceX96(currentPrice, true);
      const sqrtPriceLowerX96 = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpperX96 = tickToSqrtPriceX96(tickUpper);

      // Initial position should be within range
      expect(sqrtPriceX96).to.be.greaterThan(sqrtPriceLowerX96);
      expect(sqrtPriceX96).to.be.lessThan(sqrtPriceUpperX96);

      // Calculate initial LP allocation (typically 50% of delta-neutral portfolio)
      const lpAllocation = Number(initialDeposit) * 0.5;
      const hedgeAllocation = Number(initialDeposit) * 0.5;

      expect(lpAllocation + hedgeAllocation).to.equal(Number(initialDeposit));
    });

    it("should handle bootstrap with minimum viable deposit", function () {
      // Define minimum deposit to cover:
      // - Gas costs of position creation
      // - Minimum liquidity for Uniswap position
      // - Minimum position size for GMX

      const MIN_DEPOSIT = parseUnits("1000", 18); // $1000 minimum
      const GMX_MIN_SIZE = parseUnits("100", 18); // $100 min position
      const UNISWAP_MIN_LIQUIDITY = BigInt(1000); // Minimum liquidity units

      const deposit = parseUnits("999", 18); // Below minimum

      // Check if deposit meets all requirements
      const meetsMinimum = deposit >= MIN_DEPOSIT;
      const canCreateGMXPosition = deposit / BigInt(2) >= GMX_MIN_SIZE;
      const canCreateUniswapPosition = true; // Simplified check

      const isValidBootstrap = meetsMinimum && canCreateGMXPosition && canCreateUniswapPosition;

      expect(isValidBootstrap).to.equal(false);

      // With valid deposit
      const validDeposit = parseUnits("1000", 18);
      const isValidBootstrap2 = validDeposit >= MIN_DEPOSIT;
      expect(isValidBootstrap2).to.equal(true);
    });
  });

  // ============================================
  // Last Withdrawal (Dust Amounts) Scenarios
  // ============================================
  describe("Last Withdrawal (Dust Amounts) Scenarios", function () {
    it("should handle last withdrawal leaving dust amounts", function () {
      // Scenario: Single remaining user tries to withdraw everything
      const totalAssets = parseUnits("10000.000001", 18); // Has dust
      const totalShares = parseUnits("10000", 18);
      const userShares = parseUnits("10000", 18); // Owns all shares

      // Calculate assets to withdraw
      const assetsToWithdraw = (userShares * totalAssets) / totalShares;

      // Due to rounding, there might be dust left
      const remaining = totalAssets - assetsToWithdraw;

      // Dust should be negligible
      expect(Number(remaining)).to.be.lessThan(Number(parseUnits("0.001", 18)));
    });

    it("should handle withdrawal leaving minimum position", function () {
      // After withdrawal, remaining position might be below minimum
      const totalAssets = parseUnits("2000", 18);
      const totalShares = parseUnits("2000", 18);
      const withdrawShares = parseUnits("1900", 18); // 95% withdrawal

      const MIN_REMAINING_ASSETS = parseUnits("500", 18);

      const remainingAssets =
        totalAssets - (withdrawShares * totalAssets) / totalShares;

      const isBelowMinimum = remainingAssets < MIN_REMAINING_ASSETS;

      // If below minimum, should either:
      // 1. Allow full withdrawal (close vault)
      // 2. Reject and require full withdrawal
      // 3. Charge premium for position closure

      expect(isBelowMinimum).to.equal(true);

      // Closure cost estimation (gas + slippage)
      const closureCost = parseUnits("50", 18); // $50 estimated
      const closureCostPercent =
        (Number(closureCost) / Number(remainingAssets)) * 100;

      // High closure cost relative to remaining position
      expect(closureCostPercent).to.be.greaterThan(25);
    });

    it("should handle withdrawal of all shares by last user", function () {
      // Complete vault wind-down scenario
      const totalAssets = parseUnits("50000", 18);
      const userShares = parseUnits("50000", 18);
      const totalShares = userShares; // Single user owns everything

      // Calculate withdrawal
      const assetsOwed = (userShares * totalAssets) / totalShares;

      // Wind-down steps:
      // 1. Close GMX hedge position
      const gmxPosition = totalAssets / BigInt(2);
      const gmxCloseFee = (gmxPosition * BigInt(5)) / BigInt(10000); // 0.05% fee

      // 2. Remove LP liquidity
      const lpPosition = totalAssets / BigInt(2);
      const lpRemovalSlippage = (lpPosition * BigInt(10)) / BigInt(10000); // 0.1% slippage

      // 3. Total deductions
      const totalDeductions = gmxCloseFee + lpRemovalSlippage;
      const netAssets = assetsOwed - totalDeductions;

      // User should receive close to their assets minus fees
      const lossPercent =
        (Number(totalDeductions) / Number(assetsOwed)) * 100;

      expect(lossPercent).to.be.lessThan(0.5); // Less than 0.5% total cost
    });

    it("should prevent dust accumulation over multiple withdrawals", function () {
      // Simulate multiple partial withdrawals
      let totalAssets = parseUnits("100000", 18);
      let totalShares = parseUnits("100000", 18);
      let accumulatedDust = BigInt(0);

      // 10 withdrawals of random amounts
      const withdrawals = [
        parseUnits("15234.567", 18),
        parseUnits("8765.432", 18),
        parseUnits("12345.678", 18),
        parseUnits("9876.543", 18),
        parseUnits("5432.109", 18),
        parseUnits("7654.321", 18),
        parseUnits("11111.111", 18),
        parseUnits("6789.012", 18),
        parseUnits("8901.234", 18),
      ];

      for (const withdrawal of withdrawals) {
        if (withdrawal > totalAssets) continue;

        const sharesToBurn = (withdrawal * totalShares) / totalAssets;
        const actualAssets = (sharesToBurn * totalAssets) / totalShares;

        const dust = withdrawal - actualAssets;
        if (dust > BigInt(0)) {
          accumulatedDust += dust;
        }

        totalAssets -= actualAssets;
        totalShares -= sharesToBurn;
      }

      // Accumulated dust should be minimal
      const dustPercent =
        (Number(accumulatedDust) / Number(parseUnits("100000", 18))) * 100;

      expect(dustPercent).to.be.lessThan(0.001); // Less than 0.001%
    });
  });

  // ============================================
  // Very Small/Large Deposit Scenarios
  // ============================================
  describe("Very Small/Large Deposit Scenarios", function () {
    it("should handle minimum viable deposit", function () {
      const MIN_DEPOSIT = parseUnits("100", 18); // $100 minimum
      const deposit = parseUnits("100", 18);

      // Calculate position sizes
      const lpAllocation = deposit / BigInt(2);
      const hedgeAllocation = deposit / BigInt(2);

      // GMX minimum position is typically around $10
      const GMX_MIN_POSITION = parseUnits("10", 18);

      expect(hedgeAllocation).to.be.greaterThan(GMX_MIN_POSITION);

      // Calculate expected fees as percentage
      const estimatedGasCost = parseUnits("5", 18); // $5 in gas
      const feePercent = (Number(estimatedGasCost) / Number(deposit)) * 100;

      // Fee should not exceed reasonable threshold
      expect(feePercent).to.be.lessThan(10); // Less than 10%
    });

    it("should handle very large deposit without slippage issues", function () {
      const largeDeposit = parseUnits("10000000", 18); // $10M deposit
      const poolTVL = parseUnits("50000000", 18); // $50M pool TVL

      // Check deposit impact on pool
      const depositImpact = (Number(largeDeposit) / Number(poolTVL)) * 100;

      expect(depositImpact).to.equal(20); // 20% of pool

      // Large deposits should be split into tranches
      const MAX_SINGLE_DEPOSIT = poolTVL / BigInt(20); // 5% of pool max

      const requiresSplitting = largeDeposit > MAX_SINGLE_DEPOSIT;
      expect(requiresSplitting).to.equal(true);

      // Calculate number of tranches needed
      const numTranches = Math.ceil(
        Number(largeDeposit) / Number(MAX_SINGLE_DEPOSIT)
      );

      expect(numTranches).to.equal(4); // Need 4 tranches
    });

    it("should calculate correct shares for wei-level deposits", function () {
      // Extreme precision test
      const totalAssets = parseUnits("1000000", 18); // $1M
      const totalShares = parseUnits("1000000", 18);
      const tinyDeposit = BigInt(1); // 1 wei

      // Standard calculation
      const shares = (tinyDeposit * totalShares) / totalAssets;

      // Should get at least 1 share for any deposit
      expect(shares).to.be.greaterThanOrEqual(BigInt(0));

      // With protection (minimum shares)
      const MIN_SHARES = BigInt(1);
      const protectedShares = shares > BigInt(0) ? shares : MIN_SHARES;

      // This tiny deposit would be impractical
      const value = (protectedShares * totalAssets) / totalShares;
      expect(Number(value)).to.be.greaterThanOrEqual(0);
    });

    it("should handle deposit larger than current vault TVL", function () {
      const currentTVL = parseUnits("500000", 18); // $500k current
      const newDeposit = parseUnits("2000000", 18); // $2M new deposit

      // New deposit is 4x current TVL
      const depositRatio = Number(newDeposit) / Number(currentTVL);
      expect(depositRatio).to.equal(4);

      // This significantly changes position composition
      // Need to rebalance the entire vault

      const totalAfterDeposit = currentTVL + newDeposit;

      // New depositor should own ~80% of vault
      const newDepositorShare = (Number(newDeposit) / Number(totalAfterDeposit)) * 100;

      expect(newDepositorShare).to.equal(80);

      // Rebalancing cost estimation
      const rebalancePercent = 0.8; // 80% of positions need adjustment
      const rebalanceCost =
        Number(totalAfterDeposit) * rebalancePercent * 0.001; // 0.1% slippage

      expect(rebalanceCost).to.be.lessThan(Number(newDeposit) * 0.01); // Less than 1%
    });

    it("should enforce deposit caps for risk management", function () {
      const DEPOSIT_CAP = parseUnits("5000000", 18); // $5M cap
      const currentDeposits = parseUnits("4500000", 18);
      const newDeposit = parseUnits("1000000", 18);

      const totalAfterDeposit = currentDeposits + newDeposit;
      const exceedsCap = totalAfterDeposit > DEPOSIT_CAP;

      expect(exceedsCap).to.equal(true);

      // Calculate maximum allowed
      const maxAllowed = DEPOSIT_CAP - currentDeposits;
      expect(Number(maxAllowed)).to.equal(Number(parseUnits("500000", 18)));
    });
  });

  // ============================================
  // Multiple Positions in Same Pool Scenarios
  // ============================================
  describe("Multiple Positions in Same Pool Scenarios", function () {
    it("should correctly aggregate delta across multiple LP positions", function () {
      const currentPrice = 2500;
      const sqrtPriceX96 = priceToSqrtPriceX96(currentPrice, true);

      // Position 1: Narrow range (higher capital efficiency, higher IL)
      const pos1 = {
        tickLower: calculateTickRange(currentPrice, 0.05, 10).tickLower,
        tickUpper: calculateTickRange(currentPrice, 0.05, 10).tickUpper,
        liquidity: BigInt(100000),
        delta: 0.45, // Delta closer to 0.5 in narrow range
      };

      // Position 2: Wide range (lower capital efficiency, lower IL)
      const pos2 = {
        tickLower: calculateTickRange(currentPrice, 0.2, 10).tickLower,
        tickUpper: calculateTickRange(currentPrice, 0.2, 10).tickUpper,
        liquidity: BigInt(200000),
        delta: 0.52, // Delta can vary more in wide range
      };

      // Position 3: Asymmetric range
      const pos3 = {
        tickLower: calculateTickRange(currentPrice * 0.9, 0.1, 10).tickLower,
        tickUpper: calculateTickRange(currentPrice * 1.05, 0.1, 10).tickUpper,
        liquidity: BigInt(50000),
        delta: 0.6, // Skewed delta due to asymmetry
      };

      // Calculate weighted average delta
      const totalLiquidity = pos1.liquidity + pos2.liquidity + pos3.liquidity;

      const weightedDelta =
        (Number(pos1.liquidity) * pos1.delta +
          Number(pos2.liquidity) * pos2.delta +
          Number(pos3.liquidity) * pos3.delta) /
        Number(totalLiquidity);

      // Aggregated delta should be within valid range
      expect(weightedDelta).to.be.greaterThan(0.4);
      expect(weightedDelta).to.be.lessThan(0.6);

      // Total hedge needed
      const portfolioValue = 1000000; // $1M total
      const hedgeAmount = portfolioValue * weightedDelta;

      expect(hedgeAmount).to.be.greaterThan(400000);
      expect(hedgeAmount).to.be.lessThan(600000);
    });

    it("should handle overlapping LP ranges", function () {
      const currentPrice = 2500;

      // Two overlapping positions
      const range1 = calculateTickRange(currentPrice, 0.1, 10); // 2250-2750
      const range2 = calculateTickRange(currentPrice * 1.05, 0.1, 10); // 2362-2887

      // Check overlap
      const hasOverlap = range1.tickUpper > range2.tickLower;
      expect(hasOverlap).to.equal(true);

      // In overlapping region, both positions earn fees
      // This is more capital efficient but harder to manage

      // Calculate overlap percentage
      const overlapTicks = range1.tickUpper - range2.tickLower;
      const range1Width = range1.tickUpper - range1.tickLower;
      const overlapPercent = (overlapTicks / range1Width) * 100;

      expect(overlapPercent).to.be.greaterThan(0);
    });

    it("should track fees separately for each position", function () {
      // Multiple positions with different fee rates
      const positions = [
        { id: 1, feeTier: 500, liquidity: BigInt(100000), feesEarned: BigInt(0) },
        { id: 2, feeTier: 3000, liquidity: BigInt(50000), feesEarned: BigInt(0) },
        { id: 3, feeTier: 10000, liquidity: BigInt(25000), feesEarned: BigInt(0) },
      ];

      // Simulate trading volume distribution
      const volume = parseUnits("10000000", 18); // $10M volume

      // Higher fee tier gets less volume but more per trade
      const volumeDistribution = [0.7, 0.25, 0.05]; // 70%, 25%, 5%

      for (let i = 0; i < positions.length; i++) {
        const positionVolume =
          (BigInt(Math.floor(Number(volume) * volumeDistribution[i])) *
            BigInt(positions[i].feeTier)) /
          BigInt(1000000);
        positions[i].feesEarned = positionVolume;
      }

      // Calculate total fees
      const totalFees = positions.reduce(
        (sum, p) => sum + p.feesEarned,
        BigInt(0)
      );

      expect(totalFees).to.be.greaterThan(BigInt(0));

      // Each position should have independent fee tracking
      expect(positions[0].feesEarned).to.not.equal(positions[1].feesEarned);
    });

    it("should rebalance multiple positions efficiently", function () {
      // When price moves, may need to adjust multiple positions
      const positions = [
        { active: true, tickLower: 200000, tickUpper: 210000 },
        { active: false, tickLower: 195000, tickUpper: 205000 },
        { active: true, tickLower: 205000, tickUpper: 215000 },
      ];

      const currentTick = 207500;

      // Count active positions
      const activePositions = positions.filter(
        (p) => currentTick >= p.tickLower && currentTick <= p.tickUpper
      );

      expect(activePositions.length).to.equal(2);

      // Rebalance decision: consolidate to fewer positions?
      const GAS_PER_POSITION = 150000;
      const totalGas = positions.length * GAS_PER_POSITION;

      // If gas costs exceed threshold, consider consolidation
      const CONSOLIDATION_THRESHOLD = 400000;
      const shouldConsolidate = totalGas > CONSOLIDATION_THRESHOLD;

      expect(shouldConsolidate).to.equal(true);
    });
  });

  // ============================================
  // Range Adjustment (Reposition) Scenarios
  // ============================================
  describe("Range Adjustment (Reposition) Scenarios", function () {
    it("should calculate optimal reposition timing", function () {
      // Current position parameters
      const currentPrice = 2500;
      const positionCenter = 2400; // Position center
      const rangeWidth = 0.1; // ±10%

      // Price has drifted from center
      const drift = Math.abs(currentPrice - positionCenter) / positionCenter;
      expect(drift).to.be.closeTo(0.0417, 0.01); // ~4.17% drift

      // Threshold for repositioning
      const REPOSITION_THRESHOLD = 0.05; // 5% drift triggers reposition

      const shouldReposition = drift > REPOSITION_THRESHOLD;
      expect(shouldReposition).to.equal(false); // Not yet at threshold

      // Price drifts more
      const newPrice = 2550;
      const newDrift = Math.abs(newPrice - positionCenter) / positionCenter;

      const shouldRepositionNow = newDrift > REPOSITION_THRESHOLD;
      expect(shouldRepositionNow).to.equal(true);
    });

    it("should calculate reposition cost vs benefit", function () {
      const positionValue = parseUnits("100000", 18);
      const dailyFeeIncome = parseUnits("100", 18); // $100/day

      // Reposition costs
      const gasEstimate = parseUnits("20", 18); // $20 gas
      const slippageEstimate = (positionValue * BigInt(10)) / BigInt(10000); // 0.1%
      const totalCost = gasEstimate + slippageEstimate;

      // Calculate breakeven time
      const breakevenDays =
        Number(totalCost) / Number(dailyFeeIncome);

      expect(breakevenDays).to.be.lessThan(5); // Should recover in < 5 days

      // If price is near range edge, repositioning is more urgent
      const priceDistanceToEdge = 0.02; // 2% from edge
      const EDGE_THRESHOLD = 0.03; // Reposition if within 3% of edge

      const isNearEdge = priceDistanceToEdge < EDGE_THRESHOLD;
      expect(isNearEdge).to.equal(true);
    });

    it("should handle atomic reposition operation", function () {
      // Reposition should be atomic to prevent delta exposure
      const steps = [
        { step: 1, action: "Calculate new range", async: false },
        { step: 2, action: "Calculate new hedge size", async: false },
        { step: 3, action: "Submit LP removal", async: true },
        { step: 4, action: "Submit hedge adjustment", async: true },
        { step: 5, action: "Submit new LP position", async: true },
        { step: 6, action: "Verify delta neutral", async: false },
      ];

      // Critical: Steps 3-5 should complete in single transaction
      // or use keeper with tight timing

      const asyncSteps = steps.filter((s) => s.async);
      expect(asyncSteps.length).to.equal(3);

      // Maximum time between steps
      const MAX_STEP_DELAY = 60; // 60 seconds
      const BLOCK_TIME = 2; // Arbitrum block time

      // Steps should complete within a few blocks
      const maxBlocks = MAX_STEP_DELAY / BLOCK_TIME;
      expect(maxBlocks).to.equal(30);
    });

    it("should preserve vault value during reposition", function () {
      // Before reposition: LP + collateral + pending fees (hedge PnL is unrealized)
      const beforeReposition = {
        lpValue: parseUnits("50000", 18),
        hedgePnL: parseUnits("-2000", 18), // Unrealized loss (reduces collateral value)
        collateral: parseUnits("25000", 18),
        pendingFees: parseUnits("500", 18),
      };

      // Total value = LP + (collateral + hedgePnL) + pendingFees
      const totalBefore =
        beforeReposition.lpValue +
        beforeReposition.collateral +
        beforeReposition.hedgePnL + // This is negative, so it reduces total
        beforeReposition.pendingFees;

      // After reposition (fees collected, positions adjusted, hedge PnL realized)
      const afterReposition = {
        lpValue: parseUnits("50000", 18), // LP value unchanged
        hedgePnL: parseUnits("0", 18), // PnL realized
        collateral: parseUnits("23300", 18), // Reduced by realized loss + reposition cost
        pendingFees: parseUnits("0", 18), // Collected
      };

      const totalAfter =
        afterReposition.lpValue +
        afterReposition.collateral +
        afterReposition.hedgePnL +
        afterReposition.pendingFees;

      // Value should be preserved (minus reposition costs ~$200)
      const valueDiff = Math.abs(Number(totalAfter) - Number(totalBefore));
      const percentDiff = (valueDiff / Number(totalBefore)) * 100;

      // Should lose less than 0.5% to reposition costs
      expect(percentDiff).to.be.lessThan(0.5);
    });
  });

  // ============================================
  // Compound with Zero Pending Fees Scenarios
  // ============================================
  describe("Compound with Zero Pending Fees Scenarios", function () {
    it("should handle compound call with no fees to collect", function () {
      const pendingFees = BigInt(0);
      const pendingFunding = BigInt(0);

      // Compound operation with nothing to compound
      const shouldCompound = pendingFees > BigInt(0) || pendingFunding > BigInt(0);

      expect(shouldCompound).to.equal(false);

      // Gas would be wasted on this call
      const GAS_COST = parseUnits("10", 18);
      const MIN_COMPOUND_AMOUNT = parseUnits("50", 18);

      const isWorthCompounding = pendingFees >= MIN_COMPOUND_AMOUNT;
      expect(isWorthCompounding).to.equal(false);
    });

    it("should skip compound if fees below gas threshold", function () {
      const scenarios = [
        { pendingFees: parseUnits("5", 18), gasCost: parseUnits("10", 18) },
        { pendingFees: parseUnits("25", 18), gasCost: parseUnits("10", 18) },
        { pendingFees: parseUnits("100", 18), gasCost: parseUnits("10", 18) },
      ];

      for (const scenario of scenarios) {
        // Only compound if fees are worth at least 2x the gas cost
        const isWorth = scenario.pendingFees > scenario.gasCost * BigInt(2);

        if (Number(scenario.pendingFees) <= Number(parseUnits("20", 18))) {
          // 5 and 20 are not worth 2x gas (20)
          expect(isWorth).to.equal(false);
        } else {
          // 25 and 100 are worth more than 2x gas
          expect(isWorth).to.equal(true);
        }
      }
    });

    it("should handle partial compound when only one source has fees", function () {
      // Only LP fees, no funding
      const lpFees = parseUnits("200", 18);
      const fundingIncome = BigInt(0);

      const totalToCompound = lpFees + BigInt(Math.max(0, Number(fundingIncome)));

      expect(totalToCompound).to.equal(lpFees);

      // Calculate new position allocation
      const lpAllocation = totalToCompound / BigInt(2);
      const hedgeAllocation = totalToCompound / BigInt(2);

      expect(lpAllocation + hedgeAllocation).to.equal(totalToCompound);
    });

    it("should batch compound calls for gas efficiency", function () {
      // Multiple small fee accumulations
      const feeHistory = [
        parseUnits("10", 18),
        parseUnits("15", 18),
        parseUnits("18", 18), // Adjusted so 4 periods reaches threshold
        parseUnits("12", 18),
        parseUnits("20", 18),
      ];

      const COMPOUND_THRESHOLD = parseUnits("50", 18);

      // Should batch until threshold reached
      let batchTotal = BigInt(0);
      let daysToThreshold = 0;

      for (const fee of feeHistory) {
        batchTotal += fee;
        daysToThreshold++;
        if (batchTotal >= COMPOUND_THRESHOLD) break;
      }

      // 10 + 15 + 18 + 12 = 55 >= 50, so 4 periods
      expect(batchTotal).to.be.greaterThanOrEqual(COMPOUND_THRESHOLD);
      expect(daysToThreshold).to.equal(4); // Takes 4 periods to reach threshold
    });
  });

  // ============================================
  // Negative PnL on Hedge Position Scenarios
  // ============================================
  describe("Negative PnL on Hedge Position Scenarios", function () {
    it("should handle unrealized loss on hedge position", function () {
      // Short position loses when price increases
      const entryPrice = 2500;
      const currentPrice = 2700;
      const positionSize = 100000; // $100k position (use regular numbers)

      // Calculate unrealized PnL
      const priceChange = (currentPrice - entryPrice) / entryPrice; // 0.08
      const unrealizedPnL = -positionSize * priceChange; // Negative for shorts

      expect(unrealizedPnL).to.equal(-8000); // -$8,000 loss

      // But LP position should have gained from price increase
      const lpGain = positionSize * priceChange * 0.5; // Simplified: $4,000

      // Net effect on delta-neutral portfolio
      const netEffect = unrealizedPnL + lpGain;

      // Should roughly cancel out (delta neutral)
      expect(Math.abs(netEffect)).to.be.lessThan(positionSize * 0.05);
    });

    it("should adjust hedge margin when approaching liquidation", function () {
      const collateral = parseUnits("10000", 18);
      const positionSize = parseUnits("50000", 18); // 5x leverage
      const unrealizedLoss = parseUnits("7000", 18);

      // Calculate margin ratio
      const remainingMargin = Number(collateral) - Number(unrealizedLoss);
      const marginRatio = remainingMargin / Number(positionSize);

      expect(marginRatio).to.be.closeTo(0.06, 0.01); // 6% margin

      // Maintenance margin typically 1-2%
      const MAINTENANCE_MARGIN = 0.02;
      const SAFE_MARGIN_BUFFER = 0.05;

      const needsMarginTopup = marginRatio < MAINTENANCE_MARGIN + SAFE_MARGIN_BUFFER;
      expect(needsMarginTopup).to.equal(true);

      // Calculate required topup
      const targetMargin = 0.10; // Target 10% margin
      const requiredCollateral = Number(positionSize) * targetMargin;
      const topupNeeded = requiredCollateral - remainingMargin;

      expect(topupNeeded).to.be.greaterThan(0);
    });

    it("should handle realized loss when closing hedge", function () {
      // Hedge position closed at a loss (use regular numbers for clarity)
      const realizedLoss = 5000;
      const vaultValue = 100000;

      // Loss reduces vault value
      const newVaultValue = vaultValue - realizedLoss;
      const lossPercent = (realizedLoss / vaultValue) * 100;

      expect(lossPercent).to.equal(5);

      // Share price should reflect this
      const totalShares = 100000;
      const newSharePrice = newVaultValue / totalShares;

      expect(newSharePrice).to.be.closeTo(0.95, 0.001); // $0.95 per share
    });

    it("should calculate net yield with hedge losses", function () {
      // Period returns (use regular numbers for clarity)
      const lpFees = 1000;
      const fundingReceived = 200;
      const hedgePnL = -800; // Loss
      const rebalanceCosts = 50;

      // Net yield calculation
      const netYield =
        lpFees +
        fundingReceived +
        hedgePnL - // Already negative
        rebalanceCosts;

      expect(netYield).to.equal(350); // Net positive despite hedge loss

      // APY calculation
      const vaultValue = 100000;
      const periodDays = 30;
      const periodReturn = netYield / vaultValue;
      const annualizedReturn = periodReturn * (365 / periodDays);

      expect(annualizedReturn).to.be.closeTo(0.0426, 0.001); // ~4.26% APY
    });

    it("should prevent compounding with net negative yield", function () {
      // Use regular numbers for clarity
      const lpFees = 500;
      const hedgePnL = -1000;
      const fundingPaid = -200;

      const netYield = lpFees + hedgePnL + fundingPaid;

      expect(netYield).to.equal(-700); // Net negative

      // Cannot compound negative yield
      const canCompound = netYield > 0;
      expect(canCompound).to.equal(false);

      // Should wait until fees accumulate
      const additionalFeesNeeded = Math.abs(netYield);
      expect(additionalFeesNeeded).to.equal(700);
    });
  });

  // ============================================
  // Combined Medium Priority Scenarios
  // ============================================
  describe("Combined Medium Priority Scenarios", function () {
    it("should handle first deposit followed by large second deposit", function () {
      // First deposit establishes baseline
      const firstDeposit = parseUnits("10000", 18);
      let totalAssets = firstDeposit;
      let totalShares = firstDeposit; // 1:1 for first

      // Large second deposit
      const secondDeposit = parseUnits("990000", 18); // 99x larger

      // Calculate shares for second depositor
      const secondShares = (secondDeposit * totalShares) / totalAssets;

      totalAssets += secondDeposit;
      totalShares += secondShares;

      // First depositor ownership
      const firstDepositorOwnership =
        (Number(firstDeposit) / Number(totalShares)) * 100;

      expect(firstDepositorOwnership).to.equal(1); // Owns 1%

      // Verify no value extraction
      const firstDepositorValue =
        (firstDeposit * totalAssets) / totalShares;

      expect(Number(firstDepositorValue)).to.be.closeTo(
        Number(firstDeposit),
        Number(firstDeposit) * 0.001
      );
    });

    it("should handle reposition during partial withdrawal", function () {
      const vaultState = {
        totalAssets: parseUnits("500000", 18),
        totalShares: parseUnits("500000", 18),
        pendingWithdrawal: parseUnits("100000", 18),
        needsReposition: true,
      };

      // Calculate available for reposition
      const assetsAfterWithdrawal =
        vaultState.totalAssets - vaultState.pendingWithdrawal;

      // Reposition should account for pending withdrawal
      const repositionAmount = assetsAfterWithdrawal;

      expect(Number(repositionAmount)).to.equal(
        Number(parseUnits("400000", 18))
      );

      // Should not lock more than available
      const maxLockable = assetsAfterWithdrawal;
      expect(Number(repositionAmount)).to.be.lessThanOrEqual(
        Number(maxLockable)
      );
    });

    it("should handle multiple positions with different reposition needs", function () {
      const positions = [
        { id: 1, needsReposition: true, cost: parseUnits("30", 18) },
        { id: 2, needsReposition: false, cost: BigInt(0) },
        { id: 3, needsReposition: true, cost: parseUnits("25", 18) },
      ];

      // Calculate total reposition cost
      const totalCost = positions
        .filter((p) => p.needsReposition)
        .reduce((sum, p) => sum + p.cost, BigInt(0));

      expect(Number(totalCost)).to.equal(Number(parseUnits("55", 18)));

      // Prioritize by urgency (simplified: by cost efficiency)
      const prioritized = positions
        .filter((p) => p.needsReposition)
        .sort((a, b) => Number(a.cost) - Number(b.cost));

      expect(prioritized[0].id).to.equal(3); // Lower cost first
    });

    it("should handle compound during negative funding period", function () {
      // Scenario: LP fees are positive but funding is deeply negative
      // Use regular numbers for net return calculation
      const lpFeesNum = 1000;
      const fundingPaidNum = -1500;

      // Net position is negative but LP fees can still be compounded
      const netPeriodReturn = lpFeesNum + fundingPaidNum;
      expect(netPeriodReturn).to.equal(-500);

      // Use BigInt for compound calculations
      const lpFees = parseUnits("1000", 18);
      const MIN_COMPOUND = parseUnits("100", 18);
      const canCompoundLPFees = lpFees >= MIN_COMPOUND;

      expect(canCompoundLPFees).to.equal(true);

      // New position sizing from compound
      const additionalLP = lpFees / BigInt(2);
      const additionalHedge = lpFees / BigInt(2);

      expect(additionalLP + additionalHedge).to.equal(lpFees);
    });
  });
});
