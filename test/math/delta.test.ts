import { describe, expect, it } from "vitest";
import { getSqrtRatioAtTick } from "../../src/modules/math/ticks";
import { calculateDelta, calculateGamma, calculateMaxDelta, PRECISION } from "../../src/modules/math/delta";

describe("delta math", () => {
  it("returns full delta below range", () => {
    const sqrtPa = getSqrtRatioAtTick(-100);
    const sqrtPb = getSqrtRatioAtTick(100);
    const liquidity = 1_000_000n;

    const result = calculateDelta(sqrtPa, sqrtPa, sqrtPb, liquidity);
    const maxDelta = calculateMaxDelta(sqrtPa, sqrtPb, liquidity);

    expect(result.zone).toBe("below");
    expect(result.delta).toBe(maxDelta);
    expect(result.deltaRatio).toBe(PRECISION);
  });

  it("returns zero delta above range", () => {
    const sqrtPa = getSqrtRatioAtTick(-100);
    const sqrtPb = getSqrtRatioAtTick(100);
    const liquidity = 1_000_000n;

    const result = calculateDelta(sqrtPb, sqrtPa, sqrtPb, liquidity);

    expect(result.zone).toBe("above");
    expect(result.delta).toBe(0n);
    expect(result.deltaRatio).toBe(0n);
  });

  it("returns partial delta in range", () => {
    const sqrtPa = getSqrtRatioAtTick(-100);
    const sqrtPb = getSqrtRatioAtTick(100);
    const sqrtPrice = getSqrtRatioAtTick(0);
    const liquidity = 1_000_000n;

    const result = calculateDelta(sqrtPrice, sqrtPa, sqrtPb, liquidity);
    const maxDelta = calculateMaxDelta(sqrtPa, sqrtPb, liquidity);

    expect(result.zone).toBe("in");
    expect(result.delta).toBeGreaterThan(0n);
    expect(result.delta).toBeLessThan(maxDelta);
    expect(result.deltaRatio).toBeGreaterThan(0n);
    expect(result.deltaRatio).toBeLessThan(PRECISION);
  });

  it("computes gamma only inside range", () => {
    const sqrtPa = getSqrtRatioAtTick(-100);
    const sqrtPb = getSqrtRatioAtTick(100);
    const sqrtPrice = getSqrtRatioAtTick(0);
    const liquidity = 1_000_000n;

    const gammaIn = calculateGamma(sqrtPrice, sqrtPa, sqrtPb, liquidity);
    const gammaAbove = calculateGamma(sqrtPb, sqrtPa, sqrtPb, liquidity);

    expect(gammaIn).toBeLessThan(0n);
    expect(gammaAbove).toBe(0n);
  });
});
