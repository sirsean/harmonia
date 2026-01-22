import { describe, expect, it } from "vitest";
import {
  computeCollateralUsd30,
  computeEntryPrice12,
  computeLiquidationPrice12,
  computePnlUsd30FromPrices,
  getPositionKey,
} from "../../src/modules/gmx/position";

const account = "0x0000000000000000000000000000000000000001";
const market = "0x0000000000000000000000000000000000000002";
const collateral = "0x0000000000000000000000000000000000000003";

describe("gmx position helpers", () => {
  it("computes position key", () => {
    const key = getPositionKey(account, market, collateral, false);
    expect(key).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("computes entry price", () => {
    const price = computeEntryPrice12(100n * 10n ** 30n, 1n * 10n ** 18n, 18);
    expect(price).toBe(100n * 10n ** 12n);
  });

  it("computes pnl for short", () => {
    const pnl = computePnlUsd30FromPrices(1n * 10n ** 18n, 2000n * 10n ** 12n, 2500n * 10n ** 12n, 18, false);
    expect(pnl < 0n).toBe(true);
  });

  it("computes collateral usd", () => {
    const usd = computeCollateralUsd30(10n * 10n ** 6n, 1_000000000000000000000000n);
    expect(usd).toBe(10n * 10n ** 30n);
  });

  it("computes liquidation price for short", () => {
    const entry = 2000n * 10n ** 12n;
    const liq = computeLiquidationPrice12(
      entry,
      1000n * 10n ** 30n,
      900n * 10n ** 30n,
      1n * 10n ** 18n,
      18,
      false
    );
    expect(liq && liq > entry).toBe(true);
  });
});
