import { describe, expect, it } from "vitest";
import {
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  priceToSqrtPriceX96,
  priceToTickWithDecimals,
  roundTickDown,
  roundTickUp,
  sqrtPriceX96ToPrice,
  tickToPriceWithDecimals,
} from "../../src/modules/math/ticks";

describe("tick math", () => {
  it("converts price to tick and back with decimals", () => {
    const price = 2000;
    const tick = priceToTickWithDecimals(price, 18, 6);
    const roundTrip = tickToPriceWithDecimals(tick, 18, 6);
    expect(roundTrip).toBeCloseTo(price, 6);
  });

  it("returns negative ticks for large-decimal pairs", () => {
    const price = 3000;
    const tick = priceToTickWithDecimals(price, 18, 6);
    expect(tick).toBeLessThan(0);
  });

  it("rounds ticks to spacing", () => {
    expect(roundTickDown(123, 10)).toBe(120);
    expect(roundTickUp(123, 10)).toBe(130);
    expect(roundTickDown(-123, 10)).toBe(-130);
    expect(roundTickUp(-123, 10)).toBe(-120);
  });

  it("converts sqrtPriceX96 to price", () => {
    const price = 2000;
    const sqrtPriceX96 = priceToSqrtPriceX96(price, 18, 6);
    const roundTrip = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 6);
    expect(roundTrip).toBeCloseTo(price, 4);
  });

  it("computes liquidity amounts across range", () => {
    const sqrtA = getSqrtRatioAtTick(-600);
    const sqrtB = getSqrtRatioAtTick(600);
    const sqrtP = getSqrtRatioAtTick(0);
    const amounts = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, 1_000_000n);
    expect(amounts.amount0).toBeGreaterThan(0n);
    expect(amounts.amount1).toBeGreaterThan(0n);

    const below = getAmountsForLiquidity(sqrtA, sqrtA, sqrtB, 1_000_000n);
    expect(below.amount1).toBe(0n);

    const above = getAmountsForLiquidity(sqrtB, sqrtA, sqrtB, 1_000_000n);
    expect(above.amount0).toBe(0n);
  });
});
