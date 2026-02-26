import { StrategyConfig } from "../config/strategy";
import { MonitoringDatabase } from "../utils/database";
import {
  RuntimeStrategyParamKey,
  getRuntimeControlValue,
  setRuntimeControlValue,
} from "./runtime-config";

export type MarketRegime = "calm" | "normal" | "volatile" | "extreme";

export interface AutoTunerMetrics {
  volatility1h: number;
  volatility24h: number;
  outOfRangeFrequency24h: number;
  hedgeAdjustmentsPerHour: number;
  optimizationsPerHour: number;
  feeToCostRatio24h: number;
}

export interface AutoTunerState {
  activeRegime: MarketRegime;
  pendingRegime: MarketRegime | null;
  pendingCount: number;
  updatedAt: number;
}

export interface AutoTuneChange {
  key: RuntimeStrategyParamKey;
  previous: number;
  next: number;
  skipped: boolean;
  reason?: string;
}

export interface AutoTuneResult {
  enabled: boolean;
  applied: boolean;
  regime: MarketRegime;
  candidateRegime: MarketRegime;
  metrics: AutoTunerMetrics;
  changes: AutoTuneChange[];
}

const HYSTERESIS_CYCLES = 2;

const REGIME_TARGETS: Record<
  MarketRegime,
  Pick<
    StrategyConfig,
    | "defaultRangeWidth"
    | "rangeAdjustmentThreshold"
    | "rangeCenterDriftThreshold"
    | "hedgeDeltaThreshold"
    | "optimizationDeltaThreshold"
    | "emergencyDeltaThreshold"
  >
> = {
  calm: {
    defaultRangeWidth: 0.05,
    rangeAdjustmentThreshold: 0.12,
    rangeCenterDriftThreshold: 0.015,
    hedgeDeltaThreshold: 0.06,
    optimizationDeltaThreshold: 0.12,
    emergencyDeltaThreshold: 0.22,
  },
  normal: {
    defaultRangeWidth: 0.06,
    rangeAdjustmentThreshold: 0.15,
    rangeCenterDriftThreshold: 0.02,
    hedgeDeltaThreshold: 0.05,
    optimizationDeltaThreshold: 0.1,
    emergencyDeltaThreshold: 0.2,
  },
  volatile: {
    defaultRangeWidth: 0.1,
    rangeAdjustmentThreshold: 0.2,
    rangeCenterDriftThreshold: 0.03,
    hedgeDeltaThreshold: 0.04,
    optimizationDeltaThreshold: 0.08,
    emergencyDeltaThreshold: 0.15,
  },
  extreme: {
    defaultRangeWidth: 0.14,
    rangeAdjustmentThreshold: 0.25,
    rangeCenterDriftThreshold: 0.04,
    hedgeDeltaThreshold: 0.03,
    optimizationDeltaThreshold: 0.06,
    emergencyDeltaThreshold: 0.12,
  },
};

const STEP_CAPS: Record<RuntimeStrategyParamKey, number> = {
  defaultRangeWidth: 0.02,
  rangeAdjustmentThreshold: 0.05,
  rangeCenterDriftThreshold: 0.01,
  hedgeDeltaThreshold: 0.02,
  optimizationDeltaThreshold: 0.02,
  emergencyDeltaThreshold: 0.03,
  minRangeWidth: 0.02,
  maxRangeWidth: 0.05,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeRealizedVolatility(prices: number[]): number {
  if (prices.length < 2) {
    return 0;
  }

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const next = prices[i];
    if (prev <= 0 || next <= 0) {
      continue;
    }
    returns.push(Math.log(next / prev));
  }

  return standardDeviation(returns);
}

function getPriceSeries(db: MonitoringDatabase, account: string, sinceMs: number): number[] {
  const rows = db
    .getDb()
    .prepare(
      `
      SELECT ms.timestamp, AVG(ps.current_price) AS current_price
      FROM monitoring_snapshots ms
      JOIN position_snapshots ps ON ps.snapshot_id = ms.id
      WHERE ms.account = ?
        AND ms.timestamp >= ?
        AND ps.position_type = 'uniswap'
      GROUP BY ms.id
      ORDER BY ms.timestamp ASC
    `
    )
    .all(account, sinceMs) as Array<{ timestamp: number; current_price: number }>;

  return rows
    .map((row) => row.current_price)
    .filter((price) => Number.isFinite(price) && price > 0);
}

function countOptimizations(db: MonitoringDatabase, account: string, sinceMs: number): number {
  const row = db
    .getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM optimization_history
      WHERE account = ? AND timestamp >= ?
    `
    )
    .get(account, sinceMs) as { count: number };

  return row.count;
}

function determineRegime(metrics: AutoTunerMetrics): MarketRegime {
  if (
    metrics.volatility1h >= 0.08 ||
    metrics.volatility24h >= 0.09 ||
    metrics.outOfRangeFrequency24h >= 0.2 ||
    metrics.optimizationsPerHour >= 2.0
  ) {
    return "extreme";
  }

  if (
    metrics.volatility1h >= 0.04 ||
    metrics.volatility24h >= 0.05 ||
    metrics.outOfRangeFrequency24h >= 0.1 ||
    metrics.hedgeAdjustmentsPerHour >= 2.5
  ) {
    return "volatile";
  }

  if (
    metrics.volatility1h <= 0.012 &&
    metrics.volatility24h <= 0.015 &&
    metrics.outOfRangeFrequency24h <= 0.03 &&
    metrics.hedgeAdjustmentsPerHour <= 0.5 &&
    metrics.feeToCostRatio24h >= 1.5
  ) {
    return "calm";
  }

  return "normal";
}

function loadAutoTunerState(db: MonitoringDatabase, account: string): AutoTunerState {
  const saved = getRuntimeControlValue<AutoTunerState>(db, "autoTunerState", account);

  if (!saved) {
    return {
      activeRegime: "normal",
      pendingRegime: null,
      pendingCount: 0,
      updatedAt: Date.now(),
    };
  }

  return {
    activeRegime: saved.activeRegime,
    pendingRegime: saved.pendingRegime,
    pendingCount: saved.pendingCount,
    updatedAt: saved.updatedAt,
  };
}

function persistAutoTunerState(
  db: MonitoringDatabase,
  account: string,
  state: AutoTunerState
): void {
  setRuntimeControlValue({
    db,
    account,
    key: "autoTunerState",
    value: state as unknown as Record<string, unknown>,
    source: "auto",
    reason: `Auto-tuner state update (${state.activeRegime})`,
    isLocked: false,
  });
}

function calculateTargetValue(
  key: RuntimeStrategyParamKey,
  config: StrategyConfig,
  regime: MarketRegime
): number {
  switch (key) {
    case "defaultRangeWidth":
      return clamp(
        REGIME_TARGETS[regime].defaultRangeWidth,
        config.minRangeWidth + 1e-6,
        config.maxRangeWidth - 1e-6
      );
    case "rangeAdjustmentThreshold":
      return REGIME_TARGETS[regime].rangeAdjustmentThreshold;
    case "rangeCenterDriftThreshold": {
      const target = REGIME_TARGETS[regime].rangeCenterDriftThreshold;
      return Math.min(target, config.defaultRangeWidth / 2 - 1e-6);
    }
    case "hedgeDeltaThreshold":
      return REGIME_TARGETS[regime].hedgeDeltaThreshold;
    case "optimizationDeltaThreshold":
      return REGIME_TARGETS[regime].optimizationDeltaThreshold;
    case "emergencyDeltaThreshold":
      return REGIME_TARGETS[regime].emergencyDeltaThreshold;
    case "minRangeWidth":
      return config.minRangeWidth;
    case "maxRangeWidth":
      return config.maxRangeWidth;
  }
}

function applyStepCap(current: number, target: number, cap: number): number {
  if (Math.abs(target - current) <= cap) {
    return target;
  }

  return target > current ? current + cap : current - cap;
}

export function calculateAutoTunerMetrics(
  db: MonitoringDatabase,
  account: string,
  now: number = Date.now()
): AutoTunerMetrics {
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const prices1h = getPriceSeries(db, account, oneHourAgo);
  const prices24h = getPriceSeries(db, account, oneDayAgo);
  const snapshots24h = db.getSnapshots(account, oneDayAgo, now);

  const outOfRangeCount = snapshots24h.filter((snapshot) =>
    snapshot.recommendationReason.toLowerCase().includes("out of range")
  ).length;

  const hedgeAdjustments1h = db
    .getRecentHedgeAdjustments(account, 200)
    .filter((entry) => entry.timestamp >= oneHourAgo).length;

  const optimizations1h = countOptimizations(db, account, oneHourAgo);

  const fees24h = db.getFeesCollected(account, oneDayAgo, now);
  const costs24h = db.getTotalCosts(account, oneDayAgo, now);

  let feeToCostRatio24h = 0;
  if (costs24h > 0n) {
    feeToCostRatio24h = Number(fees24h) / Number(costs24h);
  } else if (fees24h > 0n) {
    feeToCostRatio24h = Number.POSITIVE_INFINITY;
  }

  return {
    volatility1h: computeRealizedVolatility(prices1h),
    volatility24h: computeRealizedVolatility(prices24h),
    outOfRangeFrequency24h: snapshots24h.length > 0 ? outOfRangeCount / snapshots24h.length : 0,
    hedgeAdjustmentsPerHour: hedgeAdjustments1h,
    optimizationsPerHour: optimizations1h,
    feeToCostRatio24h,
  };
}

export function runAutoTuner(params: {
  db: MonitoringDatabase;
  account: string;
  effectiveConfig: StrategyConfig;
  now?: number;
}): AutoTuneResult {
  const { db, account, effectiveConfig } = params;
  const now = params.now ?? Date.now();
  const enabled = getRuntimeControlValue<boolean>(db, "autoTuningEnabled", account) ?? false;
  const metrics = calculateAutoTunerMetrics(db, account, now);
  const candidateRegime = determineRegime(metrics);

  if (!enabled) {
    return {
      enabled: false,
      applied: false,
      regime: "normal",
      candidateRegime,
      metrics,
      changes: [],
    };
  }

  const state = loadAutoTunerState(db, account);

  if (candidateRegime === state.activeRegime) {
    state.pendingRegime = null;
    state.pendingCount = 0;
    state.updatedAt = now;
    persistAutoTunerState(db, account, state);

    return {
      enabled: true,
      applied: false,
      regime: state.activeRegime,
      candidateRegime,
      metrics,
      changes: [],
    };
  }

  if (state.pendingRegime === candidateRegime) {
    state.pendingCount += 1;
  } else {
    state.pendingRegime = candidateRegime;
    state.pendingCount = 1;
  }

  if (state.pendingCount < HYSTERESIS_CYCLES) {
    state.updatedAt = now;
    persistAutoTunerState(db, account, state);

    return {
      enabled: true,
      applied: false,
      regime: state.activeRegime,
      candidateRegime,
      metrics,
      changes: [],
    };
  }

  const keysToTune: RuntimeStrategyParamKey[] = [
    "defaultRangeWidth",
    "rangeAdjustmentThreshold",
    "rangeCenterDriftThreshold",
    "hedgeDeltaThreshold",
    "optimizationDeltaThreshold",
    "emergencyDeltaThreshold",
  ];

  const changes: AutoTuneChange[] = [];
  for (const key of keysToTune) {
    const target = calculateTargetValue(key, effectiveConfig, candidateRegime);
    const current = effectiveConfig[key] as number;
    const stepped = applyStepCap(current, target, STEP_CAPS[key]);

    const globalParam = db.getRuntimeParam(null, key);
    const accountParam = db.getRuntimeParam(account, key);
    const hasManualLock =
      (globalParam?.source === "manual" && globalParam.isLocked) ||
      (accountParam?.source === "manual" && accountParam.isLocked);

    if (hasManualLock) {
      changes.push({
        key,
        previous: current,
        next: current,
        skipped: true,
        reason: "manual-lock",
      });
      continue;
    }

    const update = db.setRuntimeParam(account, key, stepped, {
      source: "auto",
      reason: `Auto-tuner ${state.activeRegime} -> ${candidateRegime}`,
      isLocked: false,
    });

    if (!update.applied) {
      changes.push({
        key,
        previous: current,
        next: current,
        skipped: true,
        reason: update.reason,
      });
      continue;
    }

    changes.push({
      key,
      previous: current,
      next: stepped,
      skipped: false,
    });
  }

  state.activeRegime = candidateRegime;
  state.pendingRegime = null;
  state.pendingCount = 0;
  state.updatedAt = now;
  persistAutoTunerState(db, account, state);

  return {
    enabled: true,
    applied: changes.some((change) => !change.skipped),
    regime: state.activeRegime,
    candidateRegime,
    metrics,
    changes,
  };
}
