import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { MonitoringDatabase } from "../../src/utils/database";
import { calculateCapitalBandsReport, projectCapitalBands } from "../../src/utils/capital-bands";

describe("capital bands", () => {
  let db: MonitoringDatabase;
  let dbPath: string;
  const account = "0x1234567890123456789012345678901234567890";

  beforeEach(() => {
    dbPath = path.join(
      process.cwd(),
      "test-data",
      `capital-bands-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new MonitoringDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  it("computes costs and unexplained pnl with missing hedge cost estimation", () => {
    const rawDb = db.getDb();
    const now = Date.now();
    const start = now - 24 * 60 * 60 * 1000;
    const end = now;

    const insertSnapshot = rawDb.prepare(`
      INSERT INTO monitoring_snapshots (
        timestamp, account, total_nav_usd, total_lp_value_usd, gmx_net_value_usd,
        total_lp_delta, gmx_delta, net_delta, delta_drift, total_fees_usd,
        wallet_eth_usd, wallet_weth_usd, wallet_usdc_usd,
        recommendation_action, recommendation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertSnapshot.run(
      start,
      account,
      ethers.parseUnits("500", 30).toString(),
      ethers.parseUnits("420", 30).toString(),
      ethers.parseUnits("80", 30).toString(),
      "0",
      "0",
      "0",
      0,
      "0",
      "0",
      "0",
      ethers.parseUnits("100", 30).toString(),
      "NONE",
      "test"
    );

    insertSnapshot.run(
      end,
      account,
      ethers.parseUnits("490", 30).toString(),
      ethers.parseUnits("415", 30).toString(),
      ethers.parseUnits("75", 30).toString(),
      "0",
      "0",
      "0",
      0,
      "0",
      "0",
      "0",
      ethers.parseUnits("100", 30).toString(),
      "NONE",
      "test"
    );

    rawDb
      .prepare(
        `INSERT INTO fee_collection_history (timestamp, account, token_id, fees_collected_usd)
         VALUES (?, ?, ?, ?)`
      )
      .run(end - 1000, account, "1", ethers.parseUnits("10", 30).toString());

    rawDb
      .prepare(
        `INSERT INTO operation_history (timestamp, account, operation_type, gas_cost_usd, gmx_execution_fee_usd)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        end - 2000,
        account,
        "optimization",
        ethers.parseUnits("0.1", 30).toString(),
        ethers.parseUnits("0.2", 18).toString()
      );

    rawDb
      .prepare(
        `INSERT INTO hedge_adjustment_history (
          timestamp, account, direction, adjustment_size_usd, delta_drift_before, tx_hash
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        end - 1500,
        account,
        "increase",
        ethers.parseUnits("25", 30).toString(),
        0.09,
        "0xtx"
      );

    const report = calculateCapitalBandsReport(db, account, {
      startTime: start,
      endTime: end,
      hedgeGasCostAssumptionUsd30: ethers.parseUnits("0.1", 30),
      hedgeExecutionFeeAssumptionUsd30: ethers.parseUnits("0.2", 30),
    });

    expect(report.portfolioChangeUsd30).toBe(ethers.parseUnits("-10", 30));
    expect(report.feesCollectedUsd30).toBe(ethers.parseUnits("10", 30));
    expect(report.recordedOperationCostsUsd30).toBe(ethers.parseUnits("0.3", 30));
    expect(report.estimatedMissingHedgeCostsUsd30).toBe(ethers.parseUnits("0.3", 30));
    expect(report.totalEstimatedCostsUsd30).toBe(ethers.parseUnits("0.6", 30));
    expect(report.unexplainedPnlUsd30).toBe(ethers.parseUnits("-19.4", 30));
  });

  it("projects break-even and scenarios for multiple allocations", () => {
    const rawDb = db.getDb();
    const now = Date.now();
    const start = now - 24 * 60 * 60 * 1000;

    rawDb
      .prepare(
        `INSERT INTO monitoring_snapshots (
          timestamp, account, total_nav_usd, total_lp_value_usd, gmx_net_value_usd,
          total_lp_delta, gmx_delta, net_delta, delta_drift, total_fees_usd,
          wallet_eth_usd, wallet_weth_usd, wallet_usdc_usd,
          recommendation_action, recommendation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        start,
        account,
        ethers.parseUnits("500", 30).toString(),
        ethers.parseUnits("420", 30).toString(),
        ethers.parseUnits("80", 30).toString(),
        "0",
        "0",
        "0",
        0,
        "0",
        "0",
        "0",
        ethers.parseUnits("100", 30).toString(),
        "NONE",
        "test"
      );

    rawDb
      .prepare(
        `INSERT INTO monitoring_snapshots (
          timestamp, account, total_nav_usd, total_lp_value_usd, gmx_net_value_usd,
          total_lp_delta, gmx_delta, net_delta, delta_drift, total_fees_usd,
          wallet_eth_usd, wallet_weth_usd, wallet_usdc_usd,
          recommendation_action, recommendation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        now,
        account,
        ethers.parseUnits("505", 30).toString(),
        ethers.parseUnits("425", 30).toString(),
        ethers.parseUnits("80", 30).toString(),
        "0",
        "0",
        "0",
        0,
        "0",
        "0",
        "0",
        ethers.parseUnits("100", 30).toString(),
        "NONE",
        "test"
      );

    rawDb
      .prepare(
        `INSERT INTO fee_collection_history (timestamp, account, token_id, fees_collected_usd)
         VALUES (?, ?, ?, ?)`
      )
      .run(now - 1000, account, "1", ethers.parseUnits("8", 30).toString());

    rawDb
      .prepare(
        `INSERT INTO operation_history (timestamp, account, operation_type, gas_cost_usd, gmx_execution_fee_usd)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        now - 2000,
        account,
        "optimization",
        ethers.parseUnits("1", 30).toString(),
        ethers.parseUnits("0", 30).toString()
      );

    const report = calculateCapitalBandsReport(db, account, {
      startTime: start,
      endTime: now,
    });

    const projections = projectCapitalBands(report, [
      ethers.parseUnits("500", 30),
      ethers.parseUnits("1000", 30),
    ]);

    expect(projections).toHaveLength(2);
    expect(projections[0].scenarios).toHaveLength(3);
    expect(projections[0].scenarios[0].breakEvenCapitalUsd30).not.toBeNull();
  });
});
