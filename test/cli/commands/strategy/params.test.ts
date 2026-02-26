import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

vi.mock("../../../../src/cli/commands/base", () => ({
  getSignerAndAccount: vi.fn().mockResolvedValue({
    signer: {},
    account: "0x1234567890123456789012345678901234567890",
  }),
}));

import {
  clearStrategyParam,
  setAutoTuning,
  setStrategyParam,
} from "../../../../src/cli/commands/strategy/params";
import { MonitoringDatabase } from "../../../../src/utils/database";
import { getRuntimeControlValue, loadEffectiveStrategyConfig } from "../../../../src/strategy/runtime-config";

describe("strategy params commands", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(
      process.cwd(),
      "test-data",
      `strategy-params-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  it("set updates effective runtime config", async () => {
    await setStrategyParam({
      account: "0x1234567890123456789012345678901234567890",
      key: "defaultRangeWidth",
      value: "0.08",
      dbPath,
    });

    const db = new MonitoringDatabase(dbPath);
    const effective = loadEffectiveStrategyConfig(
      db,
      "0x1234567890123456789012345678901234567890"
    ).config;
    expect(effective.defaultRangeWidth).toBe(0.08);
    db.close();
  });

  it("clear removes runtime override", async () => {
    await setStrategyParam({
      account: "0x1234567890123456789012345678901234567890",
      key: "hedgeDeltaThreshold",
      value: "0.04",
      dbPath,
    });

    await clearStrategyParam({
      account: "0x1234567890123456789012345678901234567890",
      key: "hedgeDeltaThreshold",
      dbPath,
    });

    const db = new MonitoringDatabase(dbPath);
    const effective = loadEffectiveStrategyConfig(
      db,
      "0x1234567890123456789012345678901234567890"
    ).config;
    expect(effective.hedgeDeltaThreshold).toBe(0.05);
    db.close();
  });

  it("auto command toggles auto-tuner runtime flag", async () => {
    await setAutoTuning({
      account: "0x1234567890123456789012345678901234567890",
      enable: true,
      dbPath,
    });

    const db = new MonitoringDatabase(dbPath);
    const enabled = getRuntimeControlValue<boolean>(
      db,
      "autoTuningEnabled",
      "0x1234567890123456789012345678901234567890"
    );

    expect(enabled).toBe(true);
    db.close();
  });
});
