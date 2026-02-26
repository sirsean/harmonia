import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { MonitoringDatabase } from "../../src/utils/database";
import {
  clearRuntimeStrategyParam,
  getRuntimeControlValue,
  loadEffectiveStrategyConfig,
  setRuntimeControlValue,
  setRuntimeStrategyParam,
} from "../../src/strategy/runtime-config";

describe("runtime-config", () => {
  let db: MonitoringDatabase;
  let dbPath: string;
  const account = "0x1234567890123456789012345678901234567890";

  beforeEach(() => {
    dbPath = path.join(
      process.cwd(),
      "test-data",
      `runtime-config-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new MonitoringDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  it("applies account overrides over global overrides over defaults", () => {
    db.setRuntimeParam(null, "defaultRangeWidth", 0.08, {
      source: "manual",
      isLocked: true,
    });
    db.setRuntimeParam(account, "defaultRangeWidth", 0.1, {
      source: "manual",
      isLocked: true,
    });

    const accountEffective = loadEffectiveStrategyConfig(db, account).config;
    const globalEffective = loadEffectiveStrategyConfig(db).config;

    expect(globalEffective.defaultRangeWidth).toBe(0.08);
    expect(accountEffective.defaultRangeWidth).toBe(0.1);
  });

  it("validates full strategy invariants on runtime updates", () => {
    expect(() =>
      setRuntimeStrategyParam({
        db,
        account,
        key: "rangeCenterDriftThreshold",
        value: 0.04,
      })
    ).toThrow(/half of defaultRangeWidth/);
  });

  it("clears runtime strategy parameters and restores effective defaults", () => {
    setRuntimeStrategyParam({
      db,
      account,
      key: "hedgeDeltaThreshold",
      value: 0.04,
    });

    let effective = loadEffectiveStrategyConfig(db, account).config;
    expect(effective.hedgeDeltaThreshold).toBe(0.04);

    const clearResult = clearRuntimeStrategyParam({
      db,
      account,
      key: "hedgeDeltaThreshold",
    });

    expect(clearResult.cleared).toBe(true);
    effective = loadEffectiveStrategyConfig(db, account).config;
    expect(effective.hedgeDeltaThreshold).toBe(0.05);
  });

  it("resolves runtime control flags with account precedence", () => {
    setRuntimeControlValue({
      db,
      account: null,
      key: "autoTuningEnabled",
      value: false,
      source: "manual",
      isLocked: true,
    });
    setRuntimeControlValue({
      db,
      account,
      key: "autoTuningEnabled",
      value: true,
      source: "manual",
      isLocked: true,
    });

    const accountValue = getRuntimeControlValue<boolean>(db, "autoTuningEnabled", account);
    const globalValue = getRuntimeControlValue<boolean>(db, "autoTuningEnabled");

    expect(globalValue).toBe(false);
    expect(accountValue).toBe(true);
  });
});
