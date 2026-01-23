import { describe, expect, it } from "vitest";
import {
  calculateAPY,
  calculateAPYFromSnapshots,
  calculateAPR,
  SECONDS_PER_YEAR,
} from "../../src/modules/math/yield";

describe("yield math", () => {
  it("calculates APR from simple returns", () => {
    const start = 100n;
    const end = 110n;
    const apr = calculateAPR(start, end, SECONDS_PER_YEAR);
    expect(Number(apr) / 1e18).toBeCloseTo(0.1, 8);
  });

  it("calculates APY from compounding", () => {
    const start = 100n;
    const end = 121n;
    const halfYear = Number(SECONDS_PER_YEAR) / 2;
    const apy = calculateAPY(start, end, halfYear);
    expect(Number(apy) / 1e18).toBeCloseTo(0.4641, 4);
  });

  it("calculates APY from snapshots", () => {
    const apy = calculateAPYFromSnapshots([
      { timestamp: 0, value: 100n },
      { timestamp: Number(SECONDS_PER_YEAR), value: 110n },
    ]);
    expect(Number(apy) / 1e18).toBeCloseTo(0.1, 8);
  });

  it("throws on invalid snapshot input", () => {
    expect(() => calculateAPYFromSnapshots([{ timestamp: 0, value: 100n }])).toThrow();
    expect(() =>
      calculateAPYFromSnapshots([
        { timestamp: 10, value: 100n },
        { timestamp: 10, value: 110n },
      ])
    ).toThrow();
  });
});
