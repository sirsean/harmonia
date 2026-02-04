/**
 * Tests for the hedge adjustment decision logic in DeltaNeutralMonitor.
 * Covers the full decision tree from issue #86:
 *
 * 1. Out of range → OPTIMIZE
 * 2. Within hedge cooldown → NONE
 * 3. Within optimization cooldown (past hedge cooldown):
 *    - Emergency delta → OPTIMIZE
 *    - Delta >= hedge threshold → HEDGE_ADJUST
 *    - else → NONE
 * 4. Past optimization cooldown:
 *    - Delta >= optimization threshold → OPTIMIZE
 *    - Delta >= hedge threshold → HEDGE_ADJUST
 *    - Range issues → OPTIMIZE
 *    - Fees → OPTIMIZE
 *    - else → NONE
 */

import { vi } from "vitest";

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();

  const MockContract = vi.fn().mockImplementation((address: string, abi: any, provider: any) => {
    return {
      decimals: vi.fn().mockImplementation(async () => {
        if (address === "0xCollat") return 6n;
        if (address === "0xRisk") return 18n;
        return 18n;
      }),
      symbol: vi.fn().mockImplementation(async () => {
        if (address === "0xCollat") return "USDC";
        if (address === "0xRisk") return "ETH";
        return "TOKEN";
      }),
      balanceOf: vi.fn(),
      tokenOfOwnerByIndex: vi.fn(),
    };
  });

  const mockedEthers = {
    ...actual.ethers,
    Contract: MockContract,
  };

  return {
    ...actual,
    ethers: mockedEthers,
    Contract: MockContract,
  };
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DeltaNeutralMonitor } from "../../src/strategy/monitor";
import * as gmxReader from "../../src/modules/gmx/reader";
import * as uniswapReader from "../../src/modules/uniswap/reader";
import { ethers } from "ethers";
import { StrategyAction } from "../../src/strategy/types";
import { UniswapPosition } from "../../src/modules/uniswap/types";
import { getSqrtRatioAtTick } from "../../src/modules/math/ticks";
import { DEFAULT_STRATEGY_CONFIG, PRECISION } from "../../src/config/strategy";
import { MonitoringDatabase } from "../../src/utils/database";
import * as path from "path";
import * as fs from "fs";

vi.mock("../../src/modules/gmx/reader");
vi.mock("../../src/modules/uniswap/reader");

const mockProvider = {} as ethers.Provider;

describe("DeltaNeutralMonitor - Hedge Adjustments", () => {
  let monitor: DeltaNeutralMonitor;
  let db: MonitoringDatabase;
  let testDbPath: string;

  // Use token0=ETH(18dec), token1=USDC(6dec) so calculateDelta returns
  // the ETH amount (token0), which is the risk token exposure to hedge.
  // Tick -196260 gives ~$3000/ETH with this ordering.
  const centerTick = -196260;
  const mockPoolState = {
    sqrtPriceX96: getSqrtRatioAtTick(centerTick),
    tick: centerTick,
    liquidity: 1000000000000000000n,
  };

  // Position with ±300 ticks ≈ ±3% range
  const mockUniswapPosition: UniswapPosition = {
    nonce: 0n,
    operator: "0xOp",
    token0: "0xRisk",
    token1: "0xCollat",
    fee: 3000,
    tickLower: centerTick - 300,
    tickUpper: centerTick + 300,
    liquidity: 10000000000000000000000n, // large liquidity
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
  };

  const config = {
    ...DEFAULT_STRATEGY_CONFIG,
    hedgeDeltaThreshold: 0.05,
    minHedgeInterval: 300,
    minHedgeAdjustmentUsd: PRECISION.GMX_USD / 100n, // $0.01 minimum for tests
    maxHedgeLeverage: 10.0,
  };

  const context = {
    uniswap: {
      positionManager: "0xPM",
      pool: "0xPool",
      tokenIds: [123n],
    },
    gmx: {
      reader: "0xGMXReader",
      dataStore: "0xDataStore",
      account: "0xAccount",
      market: "0xMarket",
      collateralToken: "0xCollat",
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();

    testDbPath = path.join(
      process.cwd(),
      "test-data",
      `hedge-monitor-test-${Date.now()}-${Math.random().toString(36).substring(7)}.db`
    );
    db = new MonitoringDatabase(testDbPath);

    (ethers.Contract as any).mockImplementation((address: string) => ({
      decimals: vi.fn().mockImplementation(async () => {
        if (address === "0xCollat") return 6n;
        if (address === "0xRisk") return 18n;
        return 18n;
      }),
      symbol: vi.fn().mockImplementation(async () => {
        if (address === "0xCollat") return "USDC";
        if (address === "0xRisk") return "ETH";
        return "TOKEN";
      }),
      balanceOf: vi.fn(),
      tokenOfOwnerByIndex: vi.fn(),
    }));

    const mockPoolContract = {
      token0: vi.fn().mockResolvedValue("0xRisk"),
      token1: vi.fn().mockResolvedValue("0xCollat"),
    };

    vi.mocked(uniswapReader.createPool).mockReturnValue(mockPoolContract as any);
    vi.mocked(uniswapReader.createPositionManager).mockReturnValue({} as any);
    vi.mocked(gmxReader.createReader).mockReturnValue({} as any);

    vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
    vi.mocked(uniswapReader.getPosition).mockResolvedValue(mockUniswapPosition);
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(mockUniswapPosition);
    vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([
      { tokenId: 123n, position: mockUniswapPosition },
    ]);

    monitor = new DeltaNeutralMonitor(mockProvider, config, context, db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    try {
      const dir = path.dirname(testDbPath);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch (e) {
      // Ignore
    }
  });

  /**
   * Helper: get LP delta by checking with no GMX position
   */
  async function getLpDelta(): Promise<bigint> {
    vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);
    const result = await monitor.check();
    return result.status.totalLpDelta;
  }

  /**
   * Helper: set GMX position with a given short size and collateral.
   * Default collateral gives ~3x leverage at ~$3000/ETH.
   */
  function setGmxPosition(sizeInTokens: bigint, collateralAmount?: bigint, sizeInUsd?: bigint) {
    const computedSizeInUsd = sizeInUsd ?? sizeInTokens * 3000n * 10n ** 12n; // ~$3000/ETH
    // Default collateral for ~3x leverage: collateral$ = sizeInUsd / 3
    // sizeInUsd is 30 dec, collateral is 6 dec USDC → divide by 10^24 then by 3
    const defaultCollateral = sizeInTokens * 1000n / (10n ** 9n);
    const finalCollateral = collateralAmount ?? (defaultCollateral > 0n ? defaultCollateral : 1_000_000n);
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
      addresses: {} as any,
      numbers: {
        sizeInTokens,
        collateralAmount: finalCollateral,
        sizeInUsd: computedSizeInUsd,
        shortTokenClaimableFundingAmountPerSize: 0n,
        fundingFeeAmountPerSize: 0n,
      } as any,
      flags: { isLong: false },
    });
  }

  /**
   * Helper: insert an optimization record with an explicit timestamp.
   */
  function insertOptimizationAt(timestampMs: number) {
    db.getDb()
      .prepare(
        "INSERT INTO optimization_history (timestamp, account, delta_drift, total_fees_usd) VALUES (?, ?, ?, ?)"
      )
      .run(timestampMs, "0xAccount", 0.01, "0");
  }

  describe("Priority 1: Out of range always triggers OPTIMIZE", () => {
    it("should return OPTIMIZE when position is out of range regardless of hedge state", async () => {
      const outOfRangePos = {
        ...mockUniswapPosition,
        tickLower: -100000,
        tickUpper: -99900,
        liquidity: 100n,
      };

      vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(outOfRangePos);
      vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([
        { tokenId: 123n, position: outOfRangePos },
      ]);
      vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.OPTIMIZE);
      expect(result.recommendation.reason).toContain("out of range");
    });
  });

  describe("Priority 2: Hedge cooldown rate limiting", () => {
    it("should return NONE when within hedge cooldown", async () => {
      const lpDelta = await getLpDelta();
      // 90% hedged → 10% drift
      const shortSize = (lpDelta * 90n) / 100n;
      setGmxPosition(shortSize);

      // Record a recent hedge adjustment (just now)
      db.recordHedgeAdjustment("0xAccount", "increase", 10n * PRECISION.GMX_USD, 0.08);

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.NONE);
      expect(result.recommendation.reason).toContain("hedge");
    });
  });

  describe("Priority 3: Within optimization cooldown (past hedge cooldown)", () => {
    it("should return HEDGE_ADJUST when delta exceeds hedge threshold and within optimization cooldown", async () => {
      const lpDelta = await getLpDelta();
      // 93% hedged → ~7% drift
      const shortSize = (lpDelta * 93n) / 100n;
      setGmxPosition(shortSize);

      // Optimization 10 min ago: past hedge cooldown (5 min) but within optimization cooldown (1 hour)
      insertOptimizationAt(Date.now() - 600_000);

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.HEDGE_ADJUST);
      expect(result.recommendation.hedgeData).toBeDefined();
      expect(result.recommendation.reason).toContain("hedge threshold");
    });

    it("should return OPTIMIZE for emergency delta even within optimization cooldown", async () => {
      const lpDelta = await getLpDelta();
      // 75% hedged → 25% drift (above 20% emergency)
      const shortSize = (lpDelta * 75n) / 100n;
      setGmxPosition(shortSize);

      // Optimization 10 min ago: within optimization cooldown, past hedge cooldown
      insertOptimizationAt(Date.now() - 600_000);

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.OPTIMIZE);
      expect(result.recommendation.reason).toContain("Emergency");
    });

    it("should return NONE when delta is below hedge threshold and within optimization cooldown", async () => {
      const lpDelta = await getLpDelta();
      // Perfect hedge (no drift)
      setGmxPosition(lpDelta);

      // Optimization 10 min ago: within optimization cooldown, past hedge cooldown
      insertOptimizationAt(Date.now() - 600_000);

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.NONE);
      expect(result.recommendation.reason).toContain("optimization cooldown");
    });
  });

  describe("Priority 4+: Past optimization cooldown", () => {
    it("should return HEDGE_ADJUST when delta exceeds hedge threshold but below optimization threshold", async () => {
      const lpDelta = await getLpDelta();
      // ~7% drift
      const shortSize = (lpDelta * 93n) / 100n;
      setGmxPosition(shortSize);

      // No recent optimization → past cooldown
      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.HEDGE_ADJUST);
      expect(result.recommendation.hedgeData).toBeDefined();
      expect(result.recommendation.hedgeData!.adjustmentSizeUsd).not.toBe(0n);
    });

    it("should return OPTIMIZE when delta exceeds optimization threshold with favorable cost/benefit", async () => {
      const lpDelta = await getLpDelta();
      // ~15% drift (above optimization threshold of 10%)
      const shortSize = (lpDelta * 85n) / 100n;
      setGmxPosition(shortSize);

      // Add fees to ensure favorable cost/benefit ratio
      const highFeesPos = {
        ...mockUniswapPosition,
        tokensOwed0: 6000000000000000000n, // 6 ETH in fees (token0=ETH, 18 dec)
      };
      vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(highFeesPos);
      vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([
        { tokenId: 123n, position: highFeesPos },
      ]);

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.OPTIMIZE);
    });

    it("should return NONE when delta is below hedge threshold", async () => {
      const lpDelta = await getLpDelta();
      // ~2% drift (below hedge threshold of 5%)
      const shortSize = (lpDelta * 98n) / 100n;
      setGmxPosition(shortSize);

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.NONE);
      expect(result.recommendation.reason).toContain("healthy");
    });
  });

  describe("HedgeAdjustmentData", () => {
    it("should include correct direction data for under-hedged position (need to increase short)", async () => {
      const lpDelta = await getLpDelta();
      // Under-hedged: short is smaller than LP delta → need to increase
      const shortSize = (lpDelta * 93n) / 100n;
      setGmxPosition(shortSize);

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.HEDGE_ADJUST);
      expect(result.recommendation.hedgeData).toBeDefined();
      // adjustmentSizeUsd > 0 means increase short
      expect(result.recommendation.hedgeData!.adjustmentSizeUsd).toBeGreaterThan(0n);
      expect(result.recommendation.hedgeData!.targetShortSizeTokens).toBe(lpDelta);
    });

    it("should include correct direction data for over-hedged position (need to decrease short)", async () => {
      const lpDelta = await getLpDelta();
      // Over-hedged: short is larger than LP delta → need to decrease
      const shortSize = (lpDelta * 107n) / 100n;
      setGmxPosition(shortSize);

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.HEDGE_ADJUST);
      expect(result.recommendation.hedgeData).toBeDefined();
      // adjustmentSizeUsd < 0 means decrease short
      expect(result.recommendation.hedgeData!.adjustmentSizeUsd).toBeLessThan(0n);
    });

    it("should include leverage estimates", async () => {
      const lpDelta = await getLpDelta();
      const shortSize = (lpDelta * 93n) / 100n;
      setGmxPosition(shortSize);

      const result = await monitor.check();
      expect(result.recommendation.hedgeData).toBeDefined();
      expect(result.recommendation.hedgeData!.currentLeverage).toBeGreaterThan(0);
      expect(result.recommendation.hedgeData!.estimatedLeverageAfter).toBeGreaterThan(0);
    });
  });

  describe("Leverage safety guard", () => {
    it("should not recommend HEDGE_ADJUST when resulting leverage would exceed maxHedgeLeverage", async () => {
      const lpDelta = await getLpDelta();

      // Small collateral with small sizeInUsd → ~9x leverage
      // The hedge adjustment will add tokens valued at the pool's ~$3000/ETH price,
      // pushing estimated leverage far above 10x.
      const collateral = 10_000_000n; // 10 USDC
      const sizeUsd = 90n * PRECISION.GMX_USD; // $90 → 9x leverage
      const shortSize = (lpDelta * 93n) / 100n; // Under-hedged
      setGmxPosition(shortSize, collateral, sizeUsd);

      const result = await monitor.check();
      // Should NOT recommend HEDGE_ADJUST because leverage would be too high
      expect(result.recommendation.action).not.toBe(StrategyAction.HEDGE_ADJUST);
    });
  });

  describe("Cooldown interactions", () => {
    it("should allow hedge after optimization resets hedge cooldown", async () => {
      const lpDelta = await getLpDelta();
      const shortSize = (lpDelta * 93n) / 100n;
      setGmxPosition(shortSize);

      // Old optimization: well past both cooldowns
      insertOptimizationAt(Date.now() - 2 * 3600_000); // 2 hours ago

      const result = await monitor.check();
      expect(result.recommendation.action).toBe(StrategyAction.HEDGE_ADJUST);
    });

    it("should respect hedge cooldown set by recent optimization", async () => {
      const lpDelta = await getLpDelta();
      const shortSize = (lpDelta * 93n) / 100n;
      setGmxPosition(shortSize);

      // Very recent optimization → sets both cooldowns via getLastHedgeAdjustmentTime
      db.recordOptimization("0xAccount", 0.01, 0n);

      const result = await monitor.check();
      // getLastHedgeAdjustmentTime returns max(lastHedge, lastOpt)
      // Since optimization just happened, we're within hedge cooldown
      expect(result.recommendation.action).toBe(StrategyAction.NONE);
    });
  });

  describe("Minimum adjustment size", () => {
    it("should not recommend HEDGE_ADJUST for tiny adjustments below minHedgeAdjustmentUsd", async () => {
      // Use a very small position (tiny liquidity) to get small USD values
      const tinyPos = {
        ...mockUniswapPosition,
        liquidity: 100n,
      };
      vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(tinyPos);
      vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([
        { tokenId: 123n, position: tinyPos },
      ]);

      // Get LP delta for tiny position
      vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);
      const tinyResult = await monitor.check();
      const tinyLpDelta = tinyResult.status.totalLpDelta;

      // Set a short that's 93% of tiny LP delta
      const tinyShort = (tinyLpDelta * 93n) / 100n;
      if (tinyShort === 0n) {
        // Position so small it rounds to zero, skip
        return;
      }
      setGmxPosition(tinyShort);

      const result = await monitor.check();
      // The adjustment USD value might be below minimum, so hedge should be skipped
      if (result.recommendation.action === StrategyAction.HEDGE_ADJUST) {
        // If it DID recommend hedge, the adjustment must be >= minimum
        expect(result.recommendation.hedgeData).toBeDefined();
        const absAdj = result.recommendation.hedgeData!.adjustmentSizeUsd;
        const absAdjUsd = absAdj < 0n ? -absAdj : absAdj;
        expect(absAdjUsd).toBeGreaterThanOrEqual(config.minHedgeAdjustmentUsd);
      }
      // Otherwise NONE is acceptable (dust filter worked)
    });
  });
});
