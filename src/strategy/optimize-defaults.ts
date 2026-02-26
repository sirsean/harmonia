import { StrategyConfig } from "../config/strategy";

export function resolveOptimizationRangeWidth(
  rangeWidthOverride: number | undefined,
  config: StrategyConfig
): number {
  return rangeWidthOverride ?? Number(config.defaultRangeWidth);
}
