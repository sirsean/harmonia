import { describe, expect, it } from "vitest";
import { resolveOptimizationRangeWidth } from "../../../../src/strategy/optimize-defaults";
import { DEFAULT_STRATEGY_CONFIG } from "../../../../src/config/strategy";

describe("executeOptimize runtime defaults", () => {
  it("uses effective runtime config range width when override is omitted", () => {
    const runtimeConfig = {
      ...DEFAULT_STRATEGY_CONFIG,
      defaultRangeWidth: 0.11,
    };

    const rangeWidth = resolveOptimizationRangeWidth(undefined, runtimeConfig);
    expect(rangeWidth).toBe(0.11);
  });

  it("prioritizes explicit --range-width over runtime config", () => {
    const runtimeConfig = {
      ...DEFAULT_STRATEGY_CONFIG,
      defaultRangeWidth: 0.11,
    };

    const rangeWidth = resolveOptimizationRangeWidth(0.2, runtimeConfig);
    expect(rangeWidth).toBe(0.2);
  });
});
