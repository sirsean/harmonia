import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MonitoringDatabase, MonitoringSnapshot, PositionSnapshot, NavHistory } from "../../src/utils/database";
import { StrategyStatus, Recommendation, StrategyAction } from "../../src/strategy/types";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

describe("MonitoringDatabase", () => {
  let db: MonitoringDatabase;
  let testDbPath: string;

  beforeEach(() => {
    // Create a temporary database file for each test
    testDbPath = path.join(process.cwd(), "test-data", `test-${Date.now()}-${Math.random().toString(36).substring(7)}.db`);
    db = new MonitoringDatabase(testDbPath);
  });

  afterEach(() => {
    // Clean up: close database and remove test file
    db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    // Remove test-data directory if empty
    const testDataDir = path.dirname(testDbPath);
    try {
      if (fs.existsSync(testDataDir) && fs.readdirSync(testDataDir).length === 0) {
        fs.rmdirSync(testDataDir);
      }
    } catch (e) {
      // Ignore errors
    }
  });

  describe("Schema initialization", () => {
    it("should create all required tables", () => {
      const dbInstance = db.getDb();
      const tables = dbInstance
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name).sort();
      expect(tableNames).toContain("monitoring_snapshots");
      expect(tableNames).toContain("position_snapshots");
      expect(tableNames).toContain("nav_history");
    });

    it("should create all required indexes", () => {
      const dbInstance = db.getDb();
      const indexes = dbInstance
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IS NOT NULL")
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name).sort();
      expect(indexNames).toContain("idx_snapshots_timestamp");
      expect(indexNames).toContain("idx_snapshots_account");
      expect(indexNames).toContain("idx_positions_snapshot_id");
      expect(indexNames).toContain("idx_positions_token_id");
      expect(indexNames).toContain("idx_nav_history_timestamp");
      expect(indexNames).toContain("idx_nav_history_account");
    });

    it("should enable foreign keys", () => {
      const dbInstance = db.getDb();
      const foreignKeys = dbInstance.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(foreignKeys.foreign_keys).toBe(1);
    });

    it("should enable WAL mode", () => {
      const dbInstance = db.getDb();
      const journalMode = dbInstance.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(journalMode.journal_mode.toLowerCase()).toBe("wal");
    });
  });

  describe("storeSnapshot", () => {
    const createMockStatus = (): StrategyStatus => ({
      uniswap: [
        {
          tokenId: "123",
          liquidity: ethers.parseEther("100"),
          tickLower: 69000,
          tickUpper: 70000,
          currentTick: 69500,
          sqrtPriceX96: 2n ** 96n, // Q96 format
          priceLower: 2000.0,
          priceUpper: 2100.0,
          currentPrice: 2050.0,
          priceLabel: "USDC/ETH",
          unclaimedFees: {
            amount0: ethers.parseUnits("10", 6),
            amount1: ethers.parseEther("0.01"),
          },
          delta: {
            delta: ethers.parseEther("0.5"),
            deltaRatio: ethers.parseEther("0.5"),
            zone: "in",
          },
        },
        {
          tokenId: "456",
          liquidity: ethers.parseEther("50"),
          tickLower: 70000,
          tickUpper: 71000,
          currentTick: 70500,
          sqrtPriceX96: 2n ** 96n, // Q96 format
          priceLower: 2100.0,
          priceUpper: 2200.0,
          currentPrice: 2150.0,
          priceLabel: "USDC/ETH",
          unclaimedFees: {
            amount0: ethers.parseUnits("5", 6),
            amount1: ethers.parseEther("0.005"),
          },
          delta: {
            delta: ethers.parseEther("0.25"),
            deltaRatio: ethers.parseEther("0.25"),
            zone: "in",
          },
        },
      ],
      totalLpDelta: ethers.parseEther("0.75"),
      gmx: {
        positionSizeTokens: ethers.parseEther("0.7"),
        collateralAmount: ethers.parseUnits("1000", 6),
        netValueUsd: ethers.parseUnits("1500", 30),
        pendingFundingRewards: ethers.parseEther("0.001"),
        delta: ethers.parseEther("-0.7"),
      },
      netDelta: ethers.parseEther("0.05"),
      deltaDrift: 0.0667,
      timestamp: Date.now(),
    });

    const createMockRecommendation = (): Recommendation => ({
      action: StrategyAction.NONE,
      reason: "Strategy is healthy",
    });

    it("should store a complete snapshot with all positions", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status = createMockStatus();
      const recommendation = createMockRecommendation();
      const totalLpValueUsd = ethers.parseUnits("2000", 30);
      const totalFeesUsd = ethers.parseUnits("15", 30);

      const snapshotId = db.storeSnapshot(account, status, recommendation, totalLpValueUsd, totalFeesUsd);

      expect(snapshotId).toBeGreaterThan(0);

      // Verify snapshot was stored
      const snapshot = db.getLatestSnapshot(account);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.account).toBe(account);
      expect(snapshot!.totalNavUsd).toBe((totalLpValueUsd + status.gmx.netValueUsd).toString());
      expect(snapshot!.totalLpValueUsd).toBe(totalLpValueUsd.toString());
      expect(snapshot!.gmxNetValueUsd).toBe(status.gmx.netValueUsd.toString());
      expect(snapshot!.totalLpDelta).toBe(status.totalLpDelta.toString());
      expect(snapshot!.gmxDelta).toBe(status.gmx.delta.toString());
      expect(snapshot!.netDelta).toBe(status.netDelta.toString());
      expect(snapshot!.deltaDrift).toBe(status.deltaDrift);
      expect(snapshot!.recommendationAction).toBe(recommendation.action);
      expect(snapshot!.recommendationReason).toBe(recommendation.reason);
    });

    it("should store all Uniswap positions", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status = createMockStatus();
      const recommendation = createMockRecommendation();
      const totalLpValueUsd = ethers.parseUnits("2000", 30);
      const totalFeesUsd = ethers.parseUnits("15", 30);

      const snapshotId = db.storeSnapshot(account, status, recommendation, totalLpValueUsd, totalFeesUsd);

      const positions = db.getPositionSnapshots(snapshotId);
      const uniswapPositions = positions.filter((p) => p.positionType === "uniswap");

      expect(uniswapPositions.length).toBe(2);
      expect(uniswapPositions[0].tokenId).toBe("123");
      expect(uniswapPositions[0].liquidity).toBe(status.uniswap[0].liquidity.toString());
      expect(uniswapPositions[0].delta).toBe(status.uniswap[0].delta.delta.toString());
      expect(uniswapPositions[0].deltaZone).toBe("in");
      expect(uniswapPositions[1].tokenId).toBe("456");
    });

    it("should store GMX position", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status = createMockStatus();
      const recommendation = createMockRecommendation();
      const totalLpValueUsd = ethers.parseUnits("2000", 30);
      const totalFeesUsd = ethers.parseUnits("15", 30);

      const snapshotId = db.storeSnapshot(account, status, recommendation, totalLpValueUsd, totalFeesUsd);

      const positions = db.getPositionSnapshots(snapshotId);
      const gmxPosition = positions.find((p) => p.positionType === "gmx");

      expect(gmxPosition).not.toBeUndefined();
      expect(gmxPosition!.tokenId).toBe("gmx-hedge");
      expect(gmxPosition!.delta).toBe(status.gmx.delta.toString());
      expect(gmxPosition!.positionSizeTokens).toBe(status.gmx.positionSizeTokens.toString());
      expect(gmxPosition!.collateralAmount).toBe(status.gmx.collateralAmount.toString());
    });

    it("should store NAV history entry", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status = createMockStatus();
      const recommendation = createMockRecommendation();
      const totalLpValueUsd = ethers.parseUnits("2000", 30);
      const totalFeesUsd = ethers.parseUnits("15", 30);

      db.storeSnapshot(account, status, recommendation, totalLpValueUsd, totalFeesUsd);

      const navHistory = db.getNavHistory(account);
      expect(navHistory.length).toBe(1);
      expect(navHistory[0].navUsd).toBe((totalLpValueUsd + status.gmx.netValueUsd).toString());
      expect(navHistory[0].timestamp).toBe(status.timestamp);
    });

    it("should handle empty Uniswap positions array", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status: StrategyStatus = {
        uniswap: [],
        totalLpDelta: 0n,
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("-0.7"),
        deltaDrift: 1.0,
        timestamp: Date.now(),
      };
      const recommendation = createMockRecommendation();
      const totalLpValueUsd = 0n;
      const totalFeesUsd = 0n;

      const snapshotId = db.storeSnapshot(account, status, recommendation, totalLpValueUsd, totalFeesUsd);

      const positions = db.getPositionSnapshots(snapshotId);
      const uniswapPositions = positions.filter((p) => p.positionType === "uniswap");
      expect(uniswapPositions.length).toBe(0);

      const gmxPosition = positions.find((p) => p.positionType === "gmx");
      expect(gmxPosition).not.toBeUndefined();
    });

    it("should handle different recommendation actions", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status = createMockStatus();
      const recommendation: Recommendation = {
        action: StrategyAction.OPTIMIZE,
        reason: "Delta drift exceeds threshold",
        data: {
          deltaDrift: 0.12,
          anyOutOfRange: false,
          totalFeesUsd: ethers.parseUnits("15", 30),
          estimatedGasCostUsd: ethers.parseUnits("2", 30),
          estimatedBenefitUsd: ethers.parseUnits("15", 30),
        },
      };
      const totalLpValueUsd = ethers.parseUnits("2000", 30);
      const totalFeesUsd = ethers.parseUnits("15", 30);

      db.storeSnapshot(account, status, recommendation, totalLpValueUsd, totalFeesUsd);

      const snapshot = db.getLatestSnapshot(account);
      expect(snapshot!.recommendationAction).toBe(StrategyAction.OPTIMIZE);
      expect(snapshot!.recommendationReason).toBe("Delta drift exceeds threshold");
    });
  });

  describe("getLatestSnapshot", () => {
    it("should return null when no snapshots exist", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const snapshot = db.getLatestSnapshot(account);
      expect(snapshot).toBeNull();
    });

    it("should return the most recent snapshot", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status1: StrategyStatus = {
        uniswap: [],
        totalLpDelta: ethers.parseEther("0.75"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("0.05"),
        deltaDrift: 0.0667,
        timestamp: 1000,
      };
      const status2: StrategyStatus = {
        ...status1,
        timestamp: 2000,
        gmx: {
          ...status1.gmx,
          netValueUsd: ethers.parseUnits("1600", 30),
        },
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      db.storeSnapshot(account, status1, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status2, recommendation, ethers.parseUnits("2000", 30), 0n);

      const snapshot = db.getLatestSnapshot(account);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.timestamp).toBe(2000);
      expect(snapshot!.gmxNetValueUsd).toBe(ethers.parseUnits("1600", 30).toString());
    });

    it("should return snapshot for correct account only", () => {
      const account1 = "0x1111111111111111111111111111111111111111";
      const account2 = "0x2222222222222222222222222222222222222222";
      const status: StrategyStatus = {
        uniswap: [],
        totalLpDelta: ethers.parseEther("0.75"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("0.05"),
        deltaDrift: 0.0667,
        timestamp: Date.now(),
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      db.storeSnapshot(account1, status, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account2, status, recommendation, ethers.parseUnits("2000", 30), 0n);

      const snapshot1 = db.getLatestSnapshot(account1);
      const snapshot2 = db.getLatestSnapshot(account2);

      expect(snapshot1).not.toBeNull();
      expect(snapshot2).not.toBeNull();
      expect(snapshot1!.account).toBe(account1);
      expect(snapshot2!.account).toBe(account2);
    });
  });

  describe("getNavHistory", () => {
    it("should return empty array when no history exists", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const history = db.getNavHistory(account);
      expect(history).toEqual([]);
    });

    it("should return all NAV history for an account", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status1: StrategyStatus = {
        uniswap: [],
        totalLpDelta: ethers.parseEther("0.75"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("0.05"),
        deltaDrift: 0.0667,
        timestamp: 1000,
      };
      const status2: StrategyStatus = {
        ...status1,
        timestamp: 2000,
        gmx: {
          ...status1.gmx,
          netValueUsd: ethers.parseUnits("1600", 30),
        },
      };
      const status3: StrategyStatus = {
        ...status1,
        timestamp: 3000,
        gmx: {
          ...status1.gmx,
          netValueUsd: ethers.parseUnits("1700", 30),
        },
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      db.storeSnapshot(account, status1, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status2, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status3, recommendation, ethers.parseUnits("2000", 30), 0n);

      const history = db.getNavHistory(account);
      expect(history.length).toBe(3);
      expect(history[0].timestamp).toBe(1000);
      expect(history[1].timestamp).toBe(2000);
      expect(history[2].timestamp).toBe(3000);
    });

    it("should filter by start time", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status1: StrategyStatus = {
        uniswap: [],
        totalLpDelta: ethers.parseEther("0.75"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("0.05"),
        deltaDrift: 0.0667,
        timestamp: 1000,
      };
      const status2: StrategyStatus = {
        ...status1,
        timestamp: 2000,
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      db.storeSnapshot(account, status1, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status2, recommendation, ethers.parseUnits("2000", 30), 0n);

      const history = db.getNavHistory(account, 1500);
      expect(history.length).toBe(1);
      expect(history[0].timestamp).toBe(2000);
    });

    it("should filter by end time", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status1: StrategyStatus = {
        uniswap: [],
        totalLpDelta: ethers.parseEther("0.75"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("0.05"),
        deltaDrift: 0.0667,
        timestamp: 1000,
      };
      const status2: StrategyStatus = {
        ...status1,
        timestamp: 2000,
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      db.storeSnapshot(account, status1, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status2, recommendation, ethers.parseUnits("2000", 30), 0n);

      const history = db.getNavHistory(account, undefined, 1500);
      expect(history.length).toBe(1);
      expect(history[0].timestamp).toBe(1000);
    });

    it("should filter by both start and end time", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status1: StrategyStatus = {
        uniswap: [],
        totalLpDelta: ethers.parseEther("0.75"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("0.05"),
        deltaDrift: 0.0667,
        timestamp: 1000,
      };
      const status2: StrategyStatus = {
        ...status1,
        timestamp: 2000,
      };
      const status3: StrategyStatus = {
        ...status1,
        timestamp: 3000,
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      db.storeSnapshot(account, status1, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status2, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status3, recommendation, ethers.parseUnits("2000", 30), 0n);

      const history = db.getNavHistory(account, 1500, 2500);
      expect(history.length).toBe(1);
      expect(history[0].timestamp).toBe(2000);
    });
  });

  describe("getPositionSnapshots", () => {
    it("should return all positions for a snapshot", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status: StrategyStatus = {
        uniswap: [
          {
            tokenId: "123",
            liquidity: ethers.parseEther("100"),
            tickLower: 69000,
            tickUpper: 70000,
            currentTick: 69500,
            sqrtPriceX96: 2n ** 96n, // Q96 format
            priceLower: 2000.0,
            priceUpper: 2100.0,
            currentPrice: 2050.0,
            priceLabel: "USDC/ETH",
            unclaimedFees: {
              amount0: ethers.parseUnits("10", 6),
              amount1: ethers.parseEther("0.01"),
            },
            delta: {
              delta: ethers.parseEther("0.5"),
              deltaRatio: ethers.parseEther("0.5"),
              zone: "in",
            },
          },
        ],
        totalLpDelta: ethers.parseEther("0.5"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("-0.2"),
        deltaDrift: 0.4,
        timestamp: Date.now(),
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      const snapshotId = db.storeSnapshot(account, status, recommendation, ethers.parseUnits("2000", 30), 0n);

      const positions = db.getPositionSnapshots(snapshotId);
      expect(positions.length).toBe(2); // 1 Uniswap + 1 GMX

      const uniswapPos = positions.find((p) => p.positionType === "uniswap");
      expect(uniswapPos).not.toBeUndefined();
      expect(uniswapPos!.tokenId).toBe("123");

      const gmxPos = positions.find((p) => p.positionType === "gmx");
      expect(gmxPos).not.toBeUndefined();
      expect(gmxPos!.tokenId).toBe("gmx-hedge");
    });

    it("should return empty array for non-existent snapshot", () => {
      const positions = db.getPositionSnapshots(99999);
      expect(positions).toEqual([]);
    });
  });

  describe("getSnapshots", () => {
    it("should return all snapshots for an account", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status1: StrategyStatus = {
        uniswap: [],
        totalLpDelta: ethers.parseEther("0.75"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("0.05"),
        deltaDrift: 0.0667,
        timestamp: 1000,
      };
      const status2: StrategyStatus = {
        ...status1,
        timestamp: 2000,
      };
      const status3: StrategyStatus = {
        ...status1,
        timestamp: 3000,
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      db.storeSnapshot(account, status1, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status2, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status3, recommendation, ethers.parseUnits("2000", 30), 0n);

      const snapshots = db.getSnapshots(account);
      expect(snapshots.length).toBe(3);
      // Should be ordered by timestamp DESC
      expect(snapshots[0].timestamp).toBe(3000);
      expect(snapshots[1].timestamp).toBe(2000);
      expect(snapshots[2].timestamp).toBe(1000);
    });

    it("should respect limit parameter", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status: StrategyStatus = {
        uniswap: [],
        totalLpDelta: ethers.parseEther("0.75"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("0.05"),
        deltaDrift: 0.0667,
        timestamp: Date.now(),
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      // Store 5 snapshots
      for (let i = 0; i < 5; i++) {
        db.storeSnapshot(
          account,
          { ...status, timestamp: status.timestamp + i * 1000 },
          recommendation,
          ethers.parseUnits("2000", 30),
          0n
        );
      }

      const snapshots = db.getSnapshots(account, undefined, undefined, 3);
      expect(snapshots.length).toBe(3);
    });

    it("should filter by time range", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const status1: StrategyStatus = {
        uniswap: [],
        totalLpDelta: ethers.parseEther("0.75"),
        gmx: {
          positionSizeTokens: ethers.parseEther("0.7"),
          collateralAmount: ethers.parseUnits("1000", 6),
          netValueUsd: ethers.parseUnits("1500", 30),
          pendingFundingRewards: 0n,
          delta: ethers.parseEther("-0.7"),
        },
        netDelta: ethers.parseEther("0.05"),
        deltaDrift: 0.0667,
        timestamp: 1000,
      };
      const status2: StrategyStatus = {
        ...status1,
        timestamp: 2000,
      };
      const status3: StrategyStatus = {
        ...status1,
        timestamp: 3000,
      };
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      db.storeSnapshot(account, status1, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status2, recommendation, ethers.parseUnits("2000", 30), 0n);
      db.storeSnapshot(account, status3, recommendation, ethers.parseUnits("2000", 30), 0n);

      const snapshots = db.getSnapshots(account, 1500, 2500);
      expect(snapshots.length).toBe(1);
      expect(snapshots[0].timestamp).toBe(2000);
    });
  });

  describe("getStatistics", () => {
    it("should return empty statistics when no snapshots exist", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const stats = db.getStatistics(account);
      expect(stats.snapshotCount).toBe(0);
      expect(stats.firstSnapshot).toBeNull();
      expect(stats.lastSnapshot).toBeNull();
      expect(stats.minNav).toBeNull();
      expect(stats.maxNav).toBeNull();
      expect(stats.avgNav).toBeNull();
    });

    it("should calculate statistics correctly", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      // Store snapshots with different NAV values
      // Note: storeSnapshot calculates totalNavUsd = totalLpValueUsd + status.gmx.netValueUsd
      // So we need to account for the LP value (2000) when setting expectations
      const gmxValues = [
        ethers.parseUnits("1500", 30),
        ethers.parseUnits("1600", 30),
        ethers.parseUnits("1700", 30),
        ethers.parseUnits("1550", 30),
        ethers.parseUnits("1650", 30),
      ];
      const totalLpValueUsd = ethers.parseUnits("2000", 30);
      
      // Expected NAVs = LP value + GMX value
      const expectedNavs = gmxValues.map(gmx => (totalLpValueUsd + gmx).toString());
      const minNavExpected = expectedNavs[0]; // 2000 + 1500 = 3500
      const maxNavExpected = expectedNavs[2]; // 2000 + 1700 = 3700
      // Average: (3500 + 3600 + 3700 + 3550 + 3650) / 5 = 3600
      const avgNavExpected = (BigInt(expectedNavs[0]) + BigInt(expectedNavs[1]) + BigInt(expectedNavs[2]) + BigInt(expectedNavs[3]) + BigInt(expectedNavs[4])) / 5n;

      for (let i = 0; i < gmxValues.length; i++) {
        const status: StrategyStatus = {
          uniswap: [],
          totalLpDelta: ethers.parseEther("0.75"),
          gmx: {
            positionSizeTokens: ethers.parseEther("0.7"),
            collateralAmount: ethers.parseUnits("1000", 6),
            netValueUsd: gmxValues[i],
            pendingFundingRewards: 0n,
            delta: ethers.parseEther("-0.7"),
          },
          netDelta: ethers.parseEther("0.05"),
          deltaDrift: 0.0667,
          timestamp: 1000 + i * 1000,
        };
        db.storeSnapshot(account, status, recommendation, totalLpValueUsd, 0n);
      }

      const stats = db.getStatistics(account);
      expect(stats.snapshotCount).toBe(5);
      expect(stats.firstSnapshot).toBe(1000);
      expect(stats.lastSnapshot).toBe(5000);
      
      expect(stats.minNav).toBe(minNavExpected);
      expect(stats.maxNav).toBe(maxNavExpected);
      // Average calculation with BigInt division truncation
      const avgNavActual = BigInt(stats.avgNav!);
      // Allow for truncation in integer division (should be within 1 unit)
      const diff = avgNavActual > avgNavExpected 
        ? avgNavActual - avgNavExpected 
        : avgNavExpected - avgNavActual;
      expect(Number(diff)).toBeLessThanOrEqual(1);
    });

    it("should filter statistics by time range", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };

      for (let i = 0; i < 5; i++) {
        const status: StrategyStatus = {
          uniswap: [],
          totalLpDelta: ethers.parseEther("0.75"),
          gmx: {
            positionSizeTokens: ethers.parseEther("0.7"),
            collateralAmount: ethers.parseUnits("1000", 6),
            netValueUsd: ethers.parseUnits("1500", 30),
            pendingFundingRewards: 0n,
            delta: ethers.parseEther("-0.7"),
          },
          netDelta: ethers.parseEther("0.05"),
          deltaDrift: 0.0667,
          timestamp: 1000 + i * 1000,
        };
        db.storeSnapshot(account, status, recommendation, ethers.parseUnits("2000", 30), 0n);
      }

      const stats = db.getStatistics(account, 2000, 4000);
      expect(stats.snapshotCount).toBe(3);
      expect(stats.firstSnapshot).toBe(2000);
      expect(stats.lastSnapshot).toBe(4000);
    });
  });

  describe("close", () => {
    it("should close database connection", () => {
      expect(() => db.close()).not.toThrow();
      // Verify database is closed by attempting to query (should throw)
      expect(() => {
        db.getDb().prepare("SELECT 1").get();
      }).toThrow();
    });
  });

  describe("operation history", () => {
    it("should record an operation", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const operationId = db.recordOperation(account, "rebalance", ethers.parseUnits("10", 30), {
        deltaAdjustment: "0.5",
      });

      expect(operationId).toBeGreaterThan(0);

      const history = db.getOperationHistory(account);
      expect(history.length).toBe(1);
      expect(history[0].operationType).toBe("rebalance");
      expect(history[0].gasCostUsd).toBe(ethers.parseUnits("10", 30).toString());
      expect(history[0].operationData?.deltaAdjustment).toBe("0.5");
    });

    it("should get last operation time", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const timestamp1 = Date.now() - 10000;
      const timestamp2 = Date.now();

      // Manually insert operations with specific timestamps
      const insert = db.getDb().prepare(`
        INSERT INTO operation_history (timestamp, account, operation_type, gas_cost_usd)
        VALUES (?, ?, ?, ?)
      `);
      insert.run(timestamp1, account, "rebalance", ethers.parseUnits("10", 30).toString());
      insert.run(timestamp2, account, "compound", ethers.parseUnits("5", 30).toString());

      const lastRebalance = db.getLastOperationTime(account, "rebalance");
      const lastCompound = db.getLastOperationTime(account, "compound");
      const lastRangeAdjustment = db.getLastOperationTime(account, "range_adjustment");

      expect(lastRebalance).toBe(timestamp1);
      expect(lastCompound).toBe(timestamp2);
      expect(lastRangeAdjustment).toBeUndefined();
    });

    it("should filter operation history by type", () => {
      const account = "0x1234567890123456789012345678901234567890";
      db.recordOperation(account, "rebalance", ethers.parseUnits("10", 30));
      db.recordOperation(account, "compound", ethers.parseUnits("5", 30));
      db.recordOperation(account, "rebalance", ethers.parseUnits("8", 30));

      const rebalanceHistory = db.getOperationHistory(account, "rebalance");
      const compoundHistory = db.getOperationHistory(account, "compound");

      expect(rebalanceHistory.length).toBe(2);
      expect(compoundHistory.length).toBe(1);
      expect(rebalanceHistory.every((op) => op.operationType === "rebalance")).toBe(true);
      expect(compoundHistory.every((op) => op.operationType === "compound")).toBe(true);
    });

    it("should limit operation history results", () => {
      const account = "0x1234567890123456789012345678901234567890";
      for (let i = 0; i < 10; i++) {
        db.recordOperation(account, "rebalance", ethers.parseUnits("10", 30));
      }

      const limitedHistory = db.getOperationHistory(account, undefined, 5);
      expect(limitedHistory.length).toBe(5);
    });
  });

  describe("alert suppressions", () => {
    it("should suppress an alert", () => {
      const account = "0x1234567890123456789012345678901234567890";
      db.suppressAlert(account, "delta_drift_high", 3600); // 1 hour

      const isSuppressed = db.isAlertSuppressed(account, "delta_drift_high");
      expect(isSuppressed).toBe(true);
    });

    it("should return false for non-suppressed alerts", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const isSuppressed = db.isAlertSuppressed(account, "delta_drift_high");
      expect(isSuppressed).toBe(false);
    });

    it("should return false for expired suppressions", () => {
      const account = "0x1234567890123456789012345678901234567890";
      // Insert expired suppression
      const insert = db.getDb().prepare(`
        INSERT INTO alert_suppressions (account, alert_type, expires_at)
        VALUES (?, ?, ?)
      `);
      insert.run(account, "delta_drift_high", Date.now() - 1000); // Expired 1 second ago

      const isSuppressed = db.isAlertSuppressed(account, "delta_drift_high");
      expect(isSuppressed).toBe(false);

      // Verify it was cleaned up
      const check = db.getDb().prepare(`
        SELECT COUNT(*) as count FROM alert_suppressions
        WHERE account = ? AND alert_type = ?
      `);
      const result = check.get(account, "delta_drift_high") as { count: number };
      expect(result.count).toBe(0);
    });

    it("should clear suppressed alerts", () => {
      const account = "0x1234567890123456789012345678901234567890";
      db.suppressAlert(account, "delta_drift_high", 3600);
      db.suppressAlert(account, "position_out_of_range", 3600);

      db.clearSuppressedAlerts(account, "delta_drift_high");

      expect(db.isAlertSuppressed(account, "delta_drift_high")).toBe(false);
      expect(db.isAlertSuppressed(account, "position_out_of_range")).toBe(true);

      db.clearSuppressedAlerts(account);
      expect(db.isAlertSuppressed(account, "position_out_of_range")).toBe(false);
    });
  });

  describe("config overrides", () => {
    it("should set and get config override", () => {
      const account = "0x1234567890123456789012345678901234567890";
      db.setConfigOverride(account, "optimizationDeltaThreshold", 0.15);

      const value = db.getConfigOverride(account, "optimizationDeltaThreshold");
      expect(value).toBe(0.15);
    });

    it("should support global config overrides", () => {
      db.setConfigOverride(null, "optimizationDeltaThreshold", 0.12);

      const value = db.getConfigOverride(null, "optimizationDeltaThreshold");
      expect(value).toBe(0.12);
    });

    it("should return null for non-existent override", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const value = db.getConfigOverride(account, "nonExistentKey");
      expect(value).toBeNull();
    });

    it("should handle expired overrides", () => {
      const account = "0x1234567890123456789012345678901234567890";
      // Insert expired override
      const insert = db.getDb().prepare(`
        INSERT INTO config_overrides (account, config_key, config_value, expires_at)
        VALUES (?, ?, ?, ?)
      `);
      insert.run(account, "testKey", JSON.stringify("testValue"), Date.now() - 1000);

      const value = db.getConfigOverride(account, "testKey");
      expect(value).toBeNull();

      // Verify it was cleaned up
      const check = db.getDb().prepare(`
        SELECT COUNT(*) as count FROM config_overrides
        WHERE account = ? AND config_key = ?
      `);
      const result = check.get(account, "testKey") as { count: number };
      expect(result.count).toBe(0);
    });

    it("should clear config override", () => {
      const account = "0x1234567890123456789012345678901234567890";
      db.setConfigOverride(account, "testKey", "testValue");
      db.clearConfigOverride(account, "testKey");

      const value = db.getConfigOverride(account, "testKey");
      expect(value).toBeNull();
    });
  });

  describe("strategy metrics", () => {
    it("should initialize metrics on first access", () => {
      const account = "0x1234567890123456789012345678901234567890";
      const metrics = db.getMetrics(account);

      expect(metrics.totalFeesCollected).toBe(0n);
      expect(metrics.totalGasSpent).toBe(0n);
      expect(metrics.rebalanceCount).toBe(0);
      expect(metrics.compoundCount).toBe(0);
      expect(metrics.rangeAdjustmentCount).toBe(0);
      expect(metrics.optimizationCount).toBe(0);
    });

    it("should update metrics", () => {
      const account = "0x1234567890123456789012345678901234567890";
      db.updateMetrics(account, {
        totalFeesCollected: ethers.parseUnits("100", 30),
        totalGasSpent: ethers.parseUnits("10", 30),
        rebalanceCount: 5,
        compoundCount: 3,
      });

      const metrics = db.getMetrics(account);
      expect(metrics.totalFeesCollected).toBe(ethers.parseUnits("100", 30));
      expect(metrics.totalGasSpent).toBe(ethers.parseUnits("10", 30));
      expect(metrics.rebalanceCount).toBe(5);
      expect(metrics.compoundCount).toBe(3);
    });

    it("should increment metrics correctly", () => {
      const account = "0x1234567890123456789012345678901234567890";
      db.updateMetrics(account, {
        rebalanceCount: 1,
        totalGasSpent: ethers.parseUnits("5", 30),
      });

      db.updateMetrics(account, {
        rebalanceCount: 2,
        totalGasSpent: ethers.parseUnits("10", 30),
      });

      const metrics = db.getMetrics(account);
      expect(metrics.rebalanceCount).toBe(2);
      expect(metrics.totalGasSpent).toBe(ethers.parseUnits("10", 30));
    });

    it("should update partial metrics", () => {
      const account = "0x1234567890123456789012345678901234567890";
      db.updateMetrics(account, {
        rebalanceCount: 5,
        compoundCount: 3,
      });

      db.updateMetrics(account, {
        rangeAdjustmentCount: 2,
      });

      const metrics = db.getMetrics(account);
      expect(metrics.rebalanceCount).toBe(5);
      expect(metrics.compoundCount).toBe(3);
      expect(metrics.rangeAdjustmentCount).toBe(2);
    });
  });
});
