import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MonitoringDatabase } from "../../src/utils/database";
import { PRECISION } from "../../src/config/strategy";
import * as path from "path";
import * as fs from "fs";

describe("MonitoringDatabase - Hedge Adjustments", () => {
  let db: MonitoringDatabase;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = path.join(
      process.cwd(),
      "test-data",
      `db-hedge-test-${Date.now()}-${Math.random().toString(36).substring(7)}.db`
    );
    db = new MonitoringDatabase(testDbPath);
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

  describe("recordHedgeAdjustment", () => {
    it("should record an increase hedge adjustment", () => {
      const id = db.recordHedgeAdjustment(
        "0xAccount",
        "increase",
        10n * PRECISION.GMX_USD,
        0.08,
        3.0,
        3.5,
        "0xTxHash123"
      );

      expect(id).toBeGreaterThan(0);

      const recent = db.getRecentHedgeAdjustments("0xAccount", 1);
      expect(recent).toHaveLength(1);
      expect(recent[0].direction).toBe("increase");
      expect(recent[0].deltaDriftBefore).toBe(0.08);
      expect(recent[0].currentLeverage).toBe(3.0);
      expect(recent[0].estimatedLeverageAfter).toBe(3.5);
      expect(recent[0].txHash).toBe("0xTxHash123");
    });

    it("should record a decrease hedge adjustment", () => {
      const id = db.recordHedgeAdjustment(
        "0xAccount",
        "decrease",
        5n * PRECISION.GMX_USD,
        0.06,
        3.5,
        3.0
      );

      expect(id).toBeGreaterThan(0);

      const recent = db.getRecentHedgeAdjustments("0xAccount", 1);
      expect(recent).toHaveLength(1);
      expect(recent[0].direction).toBe("decrease");
      expect(recent[0].txHash).toBeUndefined();
    });

    it("should record multiple adjustments and return in reverse chronological order", () => {
      // Insert with explicit timestamps to ensure deterministic ordering
      const rawDb = db.getDb();
      const insert = rawDb.prepare(`
        INSERT INTO hedge_adjustment_history (timestamp, account, direction, adjustment_size_usd, delta_drift_before)
        VALUES (?, ?, ?, ?, ?)
      `);
      insert.run(1000, "0xAccount", "increase", (10n * PRECISION.GMX_USD).toString(), 0.08);
      insert.run(2000, "0xAccount", "decrease", (5n * PRECISION.GMX_USD).toString(), 0.06);
      insert.run(3000, "0xAccount", "increase", (15n * PRECISION.GMX_USD).toString(), 0.07);

      const recent = db.getRecentHedgeAdjustments("0xAccount", 10);
      expect(recent).toHaveLength(3);
      // Most recent first (highest timestamp)
      expect(recent[0].deltaDriftBefore).toBe(0.07);
      expect(recent[1].deltaDriftBefore).toBe(0.06);
      expect(recent[2].deltaDriftBefore).toBe(0.08);
    });

    it("should respect the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        db.recordHedgeAdjustment("0xAccount", "increase", 10n * PRECISION.GMX_USD, 0.08);
      }

      const recent = db.getRecentHedgeAdjustments("0xAccount", 3);
      expect(recent).toHaveLength(3);
    });

    it("should isolate records by account", () => {
      db.recordHedgeAdjustment("0xAccount1", "increase", 10n * PRECISION.GMX_USD, 0.08);
      db.recordHedgeAdjustment("0xAccount2", "decrease", 5n * PRECISION.GMX_USD, 0.06);

      const account1 = db.getRecentHedgeAdjustments("0xAccount1", 10);
      const account2 = db.getRecentHedgeAdjustments("0xAccount2", 10);

      expect(account1).toHaveLength(1);
      expect(account1[0].direction).toBe("increase");
      expect(account2).toHaveLength(1);
      expect(account2[0].direction).toBe("decrease");
    });
  });

  describe("getLastHedgeAdjustmentTime", () => {
    it("should return undefined when no adjustments or optimizations exist", () => {
      const time = db.getLastHedgeAdjustmentTime("0xAccount");
      expect(time).toBeUndefined();
    });

    it("should return the hedge adjustment timestamp", () => {
      const before = Date.now();
      db.recordHedgeAdjustment("0xAccount", "increase", 10n * PRECISION.GMX_USD, 0.08);
      const after = Date.now();

      const time = db.getLastHedgeAdjustmentTime("0xAccount");
      expect(time).toBeDefined();
      expect(time).toBeGreaterThanOrEqual(before);
      expect(time).toBeLessThanOrEqual(after);
    });

    it("should return optimization time when it is more recent than hedge", () => {
      // Record old hedge
      const rawDb = db.getDb();
      const oldTimestamp = Date.now() - 600_000; // 10 minutes ago
      rawDb
        .prepare(
          "INSERT INTO hedge_adjustment_history (timestamp, account, direction, adjustment_size_usd, delta_drift_before) VALUES (?, ?, ?, ?, ?)"
        )
        .run(oldTimestamp, "0xAccount", "increase", "0", 0.05);

      // Record recent optimization
      db.recordOptimization("0xAccount", 0.01, 0n);

      const time = db.getLastHedgeAdjustmentTime("0xAccount");
      expect(time).toBeDefined();
      // Should be the optimization time (more recent)
      expect(time!).toBeGreaterThan(oldTimestamp);
    });

    it("should return hedge time when it is more recent than optimization", () => {
      // Record old optimization
      const rawDb = db.getDb();
      const oldTimestamp = Date.now() - 600_000;
      rawDb
        .prepare(
          "INSERT INTO optimization_history (timestamp, account, delta_drift, total_fees_usd) VALUES (?, ?, ?, ?)"
        )
        .run(oldTimestamp, "0xAccount", 0.01, "0");

      // Record recent hedge
      db.recordHedgeAdjustment("0xAccount", "increase", 10n * PRECISION.GMX_USD, 0.08);

      const time = db.getLastHedgeAdjustmentTime("0xAccount");
      expect(time).toBeDefined();
      expect(time!).toBeGreaterThan(oldTimestamp);
    });

    it("should return optimization time when only optimizations exist (no hedges)", () => {
      db.recordOptimization("0xAccount", 0.01, 0n);

      const time = db.getLastHedgeAdjustmentTime("0xAccount");
      expect(time).toBeDefined();
    });

    it("should return hedge time when only hedges exist (no optimizations)", () => {
      db.recordHedgeAdjustment("0xAccount", "increase", 10n * PRECISION.GMX_USD, 0.08);

      const time = db.getLastHedgeAdjustmentTime("0xAccount");
      expect(time).toBeDefined();
    });
  });

  describe("migration creates table correctly", () => {
    it("should have hedge_adjustment_history table after migration", () => {
      const rawDb = db.getDb();
      const tables = rawDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='hedge_adjustment_history'"
        )
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
    });

    it("should enforce direction check constraint", () => {
      const rawDb = db.getDb();
      expect(() => {
        rawDb
          .prepare(
            "INSERT INTO hedge_adjustment_history (timestamp, account, direction, adjustment_size_usd, delta_drift_before) VALUES (?, ?, ?, ?, ?)"
          )
          .run(Date.now(), "0xAccount", "invalid_direction", "0", 0.05);
      }).toThrow();
    });
  });
});
