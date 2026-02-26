import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { MonitoringDatabase } from "../../src/utils/database";
import { runAutoTuner } from "../../src/strategy/auto-tuner";
import { loadEffectiveStrategyConfig, setRuntimeControlValue } from "../../src/strategy/runtime-config";

describe("auto-tuner", () => {
  let db: MonitoringDatabase;
  let dbPath: string;
  const account = "0x1234567890123456789012345678901234567890";

  beforeEach(() => {
    dbPath = path.join(
      process.cwd(),
      "test-data",
      `auto-tuner-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new MonitoringDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  function insertSnapshot(params: {
    timestamp: number;
    price: number;
    outOfRange?: boolean;
  }): void {
    const insertSnapshot = db.getDb().prepare(`
      INSERT INTO monitoring_snapshots (
        timestamp, account, total_nav_usd, total_lp_value_usd, gmx_net_value_usd,
        total_lp_delta, gmx_delta, net_delta, delta_drift, total_fees_usd,
        wallet_eth_usd, wallet_weth_usd, wallet_usdc_usd,
        recommendation_action, recommendation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertSnapshot.run(
      params.timestamp,
      account,
      "1000000000000000000000000000000",
      "700000000000000000000000000000",
      "300000000000000000000000000000",
      "1000000000000000000",
      "-1000000000000000000",
      "0",
      0.0,
      "1000000000000000000000000000",
      "0",
      "0",
      "0",
      "NONE",
      params.outOfRange ? "One or more positions are out of range" : "Strategy is healthy"
    );

    const snapshotId = Number(result.lastInsertRowid);

    db.getDb()
      .prepare(
        `
      INSERT INTO position_snapshots (
        snapshot_id, token_id, position_type, current_price, delta
      ) VALUES (?, ?, 'uniswap', ?, ?)
    `
      )
      .run(snapshotId, "123", params.price, "1000000000000000000");
  }

  it("applies regime changes with hysteresis and step-size caps", () => {
    const now = Date.now();

    setRuntimeControlValue({
      db,
      account,
      key: "autoTuningEnabled",
      value: true,
      source: "manual",
      isLocked: true,
    });

    // 10 snapshots in the last hour, one out-of-range => 10% frequency => volatile regime
    for (let i = 0; i < 10; i++) {
      insertSnapshot({
        timestamp: now - (10 - i) * 5 * 60 * 1000,
        price: 2000,
        outOfRange: i === 2,
      });
    }

    const effectiveBefore = loadEffectiveStrategyConfig(db, account).config;

    const firstRun = runAutoTuner({
      db,
      account,
      effectiveConfig: effectiveBefore,
      now,
    });

    expect(firstRun.enabled).toBe(true);
    expect(firstRun.candidateRegime).toBe("volatile");
    expect(firstRun.applied).toBe(false);

    const secondRun = runAutoTuner({
      db,
      account,
      effectiveConfig: loadEffectiveStrategyConfig(db, account).config,
      now: now + 1,
    });

    expect(secondRun.applied).toBe(true);
    expect(secondRun.regime).toBe("volatile");

    const widthParam = db.getRuntimeParam(account, "defaultRangeWidth");
    expect(widthParam).not.toBeNull();
    // Step cap is 0.02 from default 0.06 toward volatile target 0.10.
    expect(widthParam?.value).toBeCloseTo(0.08, 8);
  });

  it("does not override manually locked parameters", () => {
    const now = Date.now();

    setRuntimeControlValue({
      db,
      account,
      key: "autoTuningEnabled",
      value: true,
      source: "manual",
      isLocked: true,
    });

    db.setRuntimeParam(account, "defaultRangeWidth", 0.07, {
      source: "manual",
      isLocked: true,
      reason: "manual lock",
    });

    // High out-of-range frequency => extreme regime
    for (let i = 0; i < 10; i++) {
      insertSnapshot({
        timestamp: now - (10 - i) * 5 * 60 * 1000,
        price: 2000,
        outOfRange: i < 3,
      });
    }

    runAutoTuner({
      db,
      account,
      effectiveConfig: loadEffectiveStrategyConfig(db, account).config,
      now,
    });

    const secondRun = runAutoTuner({
      db,
      account,
      effectiveConfig: loadEffectiveStrategyConfig(db, account).config,
      now: now + 1,
    });

    const widthChange = secondRun.changes.find((change) => change.key === "defaultRangeWidth");
    expect(widthChange).toBeDefined();
    expect(widthChange?.skipped).toBe(true);
    expect(widthChange?.reason).toBe("manual-lock");

    const widthParam = db.getRuntimeParam(account, "defaultRangeWidth");
    expect(widthParam?.value).toBe(0.07);
    expect(widthParam?.source).toBe("manual");
  });
});
