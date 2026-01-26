import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MonitoringDatabase } from "../../src/utils/database";
import { StateManager, StrategyState } from "../../src/utils/state";
import { StrategyStatus, Recommendation, StrategyAction } from "../../src/strategy/types";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

describe("StateManager", () => {
  let db: MonitoringDatabase;
  let stateManager: StateManager;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = path.join(
      process.cwd(),
      "test-data",
      `test-state-${Date.now()}-${Math.random().toString(36).substring(7)}.db`
    );
    db = new MonitoringDatabase(testDbPath);
    stateManager = new StateManager(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    const testDataDir = path.dirname(testDbPath);
    try {
      if (fs.existsSync(testDataDir) && fs.readdirSync(testDataDir).length === 0) {
        fs.rmdirSync(testDataDir);
      }
    } catch (e) {
      // Ignore errors
    }
  });

  describe("loadState", () => {
    it("should load empty state for new account", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      const state = await stateManager.loadState(account);

      expect(state.lastCheck).toBeGreaterThan(0);
      expect(state.lastRebalance).toBeNull();
      expect(state.lastCompound).toBeNull();
      expect(state.lastRangeAdjustment).toBeNull();
      expect(state.lastOptimization).toBeNull();
      expect(state.metrics.totalFeesCollected).toBe(0n);
      expect(state.metrics.totalGasSpent).toBe(0n);
      expect(state.metrics.rebalanceCount).toBe(0);
      expect(state.metrics.compoundCount).toBe(0);
      expect(state.metrics.rangeAdjustmentCount).toBe(0);
      expect(state.metrics.optimizationCount).toBe(0);
    });

    it("should load state with operation history", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      const timestamp1 = Date.now() - 20000;
      const timestamp2 = Date.now() - 10000;
      const timestamp3 = Date.now() - 5000;

      // Record operations
      await stateManager.recordOperation(account, "rebalance", ethers.parseUnits("10", 30));
      await stateManager.recordOperation(account, "compound", ethers.parseUnits("5", 30));
      await stateManager.recordOperation(account, "range_adjustment", ethers.parseUnits("3", 30));

      // Manually set timestamps for testing
      const updateStmt = db.getDb().prepare(`
        UPDATE operation_history SET timestamp = ? WHERE account = ? AND operation_type = ?
      `);
      updateStmt.run(timestamp1, account, "rebalance");
      updateStmt.run(timestamp2, account, "compound");
      updateStmt.run(timestamp3, account, "range_adjustment");

      const state = await stateManager.loadState(account);

      expect(state.lastRebalance).toBe(timestamp1);
      expect(state.lastCompound).toBe(timestamp2);
      expect(state.lastRangeAdjustment).toBe(timestamp3);
    });

    it("should load state with metrics", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.updateMetrics(account, {
        totalFeesCollected: ethers.parseUnits("100", 30),
        totalGasSpent: ethers.parseUnits("20", 30),
        rebalanceCount: 5,
        compoundCount: 3,
        rangeAdjustmentCount: 2,
        optimizationCount: 1,
      });

      const state = await stateManager.loadState(account);

      expect(state.metrics.totalFeesCollected).toBe(ethers.parseUnits("100", 30));
      expect(state.metrics.totalGasSpent).toBe(ethers.parseUnits("20", 30));
      expect(state.metrics.rebalanceCount).toBe(5);
      expect(state.metrics.compoundCount).toBe(3);
      expect(state.metrics.rangeAdjustmentCount).toBe(2);
      expect(state.metrics.optimizationCount).toBe(1);
    });
  });

  describe("saveState", () => {
    it("should save metrics updates", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.saveState(account, {
        metrics: {
          totalFeesCollected: ethers.parseUnits("50", 30),
          totalGasSpent: ethers.parseUnits("10", 30),
          rebalanceCount: 2,
          compoundCount: 1,
          rangeAdjustmentCount: 0,
          optimizationCount: 0,
        },
      });

      const metrics = await stateManager.getMetrics(account);
      expect(metrics.totalFeesCollected).toBe(ethers.parseUnits("50", 30));
      expect(metrics.totalGasSpent).toBe(ethers.parseUnits("10", 30));
      expect(metrics.rebalanceCount).toBe(2);
      expect(metrics.compoundCount).toBe(1);
    });
  });

  describe("recordOperation", () => {
    it("should record operation and update metrics", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      const operationId = await stateManager.recordOperation(
        account,
        "rebalance",
        ethers.parseUnits("10", 30),
        { deltaAdjustment: "0.5" }
      );

      expect(operationId).toBeGreaterThan(0);

      const metrics = await stateManager.getMetrics(account);
      expect(metrics.rebalanceCount).toBe(1);
      expect(metrics.totalGasSpent).toBe(ethers.parseUnits("10", 30));

      const history = await stateManager.getOperationHistory(account);
      expect(history.length).toBe(1);
      expect(history[0].operationType).toBe("rebalance");
      expect(history[0].gasCostUsd).toBe(ethers.parseUnits("10", 30).toString());
    });

    it("should increment operation counts correctly", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.recordOperation(account, "rebalance", ethers.parseUnits("10", 30));
      await stateManager.recordOperation(account, "compound", ethers.parseUnits("5", 30));
      await stateManager.recordOperation(account, "range_adjustment", ethers.parseUnits("3", 30));
      await stateManager.recordOperation(account, "optimization", ethers.parseUnits("15", 30));

      const metrics = await stateManager.getMetrics(account);
      expect(metrics.rebalanceCount).toBe(1);
      expect(metrics.compoundCount).toBe(1);
      expect(metrics.rangeAdjustmentCount).toBe(1);
      expect(metrics.optimizationCount).toBe(1);
      expect(metrics.totalGasSpent).toBe(ethers.parseUnits("33", 30)); // 10 + 5 + 3 + 15
    });

    it("should record operation without gas cost", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.recordOperation(account, "rebalance", undefined, {
        testData: "value",
      });

      const metrics = await stateManager.getMetrics(account);
      expect(metrics.rebalanceCount).toBe(1);
      expect(metrics.totalGasSpent).toBe(0n); // Should not update gas if not provided

      const history = await stateManager.getOperationHistory(account);
      expect(history[0].gasCostUsd).toBeUndefined(); // Should be undefined when not provided
      expect(history[0].operationData?.testData).toBe("value");
    });
  });

  describe("getLastOperationTime", () => {
    it("should return null when no operations exist", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      const time = await stateManager.getLastOperationTime(account, "rebalance");
      expect(time).toBeNull();
    });

    it("should return last operation time", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      const timestamp = Date.now() - 5000;
      await stateManager.recordOperation(account, "rebalance");

      // Manually set timestamp for testing
      const updateStmt = db.getDb().prepare(`
        UPDATE operation_history SET timestamp = ? WHERE account = ? AND operation_type = ?
      `);
      updateStmt.run(timestamp, account, "rebalance");

      const lastTime = await stateManager.getLastOperationTime(account, "rebalance");
      expect(lastTime).toBe(timestamp);
    });
  });

  describe("getOperationHistory", () => {
    it("should return operation history", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.recordOperation(account, "rebalance", ethers.parseUnits("10", 30));
      await stateManager.recordOperation(account, "compound", ethers.parseUnits("5", 30));
      await stateManager.recordOperation(account, "rebalance", ethers.parseUnits("8", 30));

      const history = await stateManager.getOperationHistory(account);
      expect(history.length).toBe(3);
      expect(history[0].operationType).toBe("rebalance"); // Most recent first

      const rebalanceHistory = await stateManager.getOperationHistory(account, "rebalance");
      expect(rebalanceHistory.length).toBe(2);
    });

    it("should limit operation history", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      for (let i = 0; i < 10; i++) {
        await stateManager.recordOperation(account, "rebalance");
      }

      const limitedHistory = await stateManager.getOperationHistory(account, undefined, 5);
      expect(limitedHistory.length).toBe(5);
    });
  });

  describe("alert suppression", () => {
    it("should suppress and check alerts", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.suppressAlert(account, "delta_drift_high", 3600);

      const isSuppressed = await stateManager.isAlertSuppressed(account, "delta_drift_high");
      expect(isSuppressed).toBe(true);

      const isNotSuppressed = await stateManager.isAlertSuppressed(account, "other_alert");
      expect(isNotSuppressed).toBe(false);
    });

    it("should clear suppressed alerts", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.suppressAlert(account, "delta_drift_high", 3600);
      await stateManager.suppressAlert(account, "position_out_of_range", 3600);

      await stateManager.clearSuppressedAlerts(account, "delta_drift_high");
      expect(await stateManager.isAlertSuppressed(account, "delta_drift_high")).toBe(false);
      expect(await stateManager.isAlertSuppressed(account, "position_out_of_range")).toBe(true);

      await stateManager.clearSuppressedAlerts(account);
      expect(await stateManager.isAlertSuppressed(account, "position_out_of_range")).toBe(false);
    });
  });

  describe("config overrides", () => {
    it("should set and get config overrides", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.setConfigOverride(account, "optimizationDeltaThreshold", 0.15);

      const value = await stateManager.getConfigOverride(account, "optimizationDeltaThreshold");
      expect(value).toBe(0.15);
    });

    it("should support global config overrides", async () => {
      await stateManager.setConfigOverride(null, "optimizationDeltaThreshold", 0.12);

      const value = await stateManager.getConfigOverride(null, "optimizationDeltaThreshold");
      expect(value).toBe(0.12);
    });

    it("should clear config overrides", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.setConfigOverride(account, "testKey", "testValue");
      await stateManager.clearConfigOverride(account, "testKey");

      const value = await stateManager.getConfigOverride(account, "testKey");
      expect(value).toBeNull();
    });
  });

  describe("metrics", () => {
    it("should update metrics", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.updateMetrics(account, {
        totalFeesCollected: ethers.parseUnits("100", 30),
        rebalanceCount: 5,
      });

      const metrics = await stateManager.getMetrics(account);
      expect(metrics.totalFeesCollected).toBe(ethers.parseUnits("100", 30));
      expect(metrics.rebalanceCount).toBe(5);
    });

    it("should get metrics", async () => {
      const account = "0x1234567890123456789012345678901234567890";
      await stateManager.updateMetrics(account, {
        totalFeesCollected: ethers.parseUnits("50", 30),
        totalGasSpent: ethers.parseUnits("10", 30),
        compoundCount: 3,
      });

      const metrics = await stateManager.getMetrics(account);
      expect(metrics.totalFeesCollected).toBe(ethers.parseUnits("50", 30));
      expect(metrics.totalGasSpent).toBe(ethers.parseUnits("10", 30));
      expect(metrics.compoundCount).toBe(3);
    });
  });

  describe("getDatabase", () => {
    it("should return the underlying database instance", () => {
      const returnedDb = stateManager.getDatabase();
      expect(returnedDb).toBe(db);
    });
  });
});
