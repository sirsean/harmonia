import * as strategyConfigModule from "../config/strategy";
import { StrategyConfig } from "../config/strategy";
import { MonitoringDatabase, RuntimeParamRecord, RuntimeParamSource } from "../utils/database";

export const RUNTIME_STRATEGY_PARAM_KEYS = [
  "defaultRangeWidth",
  "rangeAdjustmentThreshold",
  "rangeCenterDriftThreshold",
  "hedgeDeltaThreshold",
  "optimizationDeltaThreshold",
  "emergencyDeltaThreshold",
  "minRangeWidth",
  "maxRangeWidth",
] as const;

export type RuntimeStrategyParamKey = (typeof RUNTIME_STRATEGY_PARAM_KEYS)[number];

export const RUNTIME_CONTROL_KEYS = ["autoTuningEnabled", "autoTunerState"] as const;
export type RuntimeControlKey = (typeof RUNTIME_CONTROL_KEYS)[number];

const RUNTIME_STRATEGY_PARAM_KEY_SET = new Set<string>(RUNTIME_STRATEGY_PARAM_KEYS);

export interface EffectiveStrategyConfig {
  config: StrategyConfig;
  appliedParams: RuntimeParamRecord[];
  globalParams: RuntimeParamRecord[];
  accountParams: RuntimeParamRecord[];
}

export interface StrategyConfigDiff {
  key: keyof StrategyConfig;
  before: string;
  after: string;
}

function validateEffectiveConfig(config: StrategyConfig): void {
  const validator = strategyConfigModule.validateStrategyConfig as unknown as
    | ((nextConfig: StrategyConfig) => void)
    | undefined;

  if (typeof validator === "function") {
    validator(config);
  }
}

export function isRuntimeStrategyParamKey(key: string): key is RuntimeStrategyParamKey {
  return RUNTIME_STRATEGY_PARAM_KEY_SET.has(key);
}

function applyRuntimeParams(config: StrategyConfig, params: RuntimeParamRecord[]): StrategyConfig {
  const nextConfig = { ...config };

  for (const param of params) {
    if (!isRuntimeStrategyParamKey(param.key)) {
      continue;
    }

    (nextConfig as Record<string, unknown>)[param.key] = param.value;
  }

  return nextConfig;
}

export function loadEffectiveStrategyConfig(
  db: MonitoringDatabase,
  account?: string,
  overrides?: Partial<StrategyConfig>
): EffectiveStrategyConfig {
  const base = strategyConfigModule.loadStrategyConfig();
  const runtimeSnapshotLoader = (
    db as unknown as {
      getRuntimeParamSnapshot?: (scopeAccount?: string) => {
        globalParams: RuntimeParamRecord[];
        accountParams: RuntimeParamRecord[];
      };
    }
  ).getRuntimeParamSnapshot;

  const { globalParams, accountParams } =
    typeof runtimeSnapshotLoader === "function"
      ? runtimeSnapshotLoader.call(db, account)
      : { globalParams: [], accountParams: [] };

  const globalStrategyParams = globalParams.filter((param) => isRuntimeStrategyParamKey(param.key));
  const accountStrategyParams = accountParams.filter((param) =>
    isRuntimeStrategyParamKey(param.key)
  );

  let config = applyRuntimeParams(base, globalStrategyParams);
  config = applyRuntimeParams(config, accountStrategyParams);

  if (overrides) {
    Object.assign(config, overrides);
  }

  validateEffectiveConfig(config);

  return {
    config,
    appliedParams: [...globalStrategyParams, ...accountStrategyParams],
    globalParams,
    accountParams,
  };
}

export function setRuntimeStrategyParam(params: {
  db: MonitoringDatabase;
  account?: string | null;
  key: RuntimeStrategyParamKey;
  value: number;
  source?: RuntimeParamSource;
  expiresAt?: number;
  reason?: string;
  isLocked?: boolean;
}): { applied: boolean; reason?: string; effectiveConfig: StrategyConfig } {
  const { db, account = null, key, value, source, expiresAt, reason, isLocked } = params;

  if (!Number.isFinite(value)) {
    throw new Error(`Invalid value for ${key}: ${value}`);
  }

  const effectiveBefore = loadEffectiveStrategyConfig(db, account ?? undefined).config;
  const candidate = { ...effectiveBefore, [key]: value } as StrategyConfig;
  validateEffectiveConfig(candidate);

  const result = db.setRuntimeParam(account, key, value, {
    source,
    expiresAt,
    reason,
    isLocked,
  });

  const effectiveConfig = loadEffectiveStrategyConfig(db, account ?? undefined).config;
  return { ...result, effectiveConfig };
}

export function clearRuntimeStrategyParam(params: {
  db: MonitoringDatabase;
  account?: string | null;
  key: RuntimeStrategyParamKey;
  source?: RuntimeParamSource;
  reason?: string;
}): { cleared: boolean; effectiveConfig: StrategyConfig } {
  const { db, account = null, key, source, reason } = params;

  const cleared = db.clearRuntimeParam(account, key, {
    source,
    reason,
  });

  const effectiveConfig = loadEffectiveStrategyConfig(db, account ?? undefined).config;
  return { cleared, effectiveConfig };
}

export function getRuntimeControlValue<T>(
  db: MonitoringDatabase,
  key: RuntimeControlKey,
  account?: string
): T | undefined {
  const { globalParams, accountParams } = db.getRuntimeParamSnapshot(account);

  const accountValue = accountParams.find((param) => param.key === key);
  if (accountValue) {
    return accountValue.value as T;
  }

  const globalValue = globalParams.find((param) => param.key === key);
  if (globalValue) {
    return globalValue.value as T;
  }

  return undefined;
}

export function setRuntimeControlValue(params: {
  db: MonitoringDatabase;
  account?: string | null;
  key: RuntimeControlKey;
  value: boolean | Record<string, unknown>;
  source?: RuntimeParamSource;
  expiresAt?: number;
  reason?: string;
  isLocked?: boolean;
}): { applied: boolean; reason?: string } {
  const { db, account = null, key, value, source, expiresAt, reason, isLocked = true } = params;

  return db.setRuntimeParam(account, key, value, {
    source,
    expiresAt,
    reason,
    isLocked,
  });
}

export function diffStrategyConfigs(
  previous: StrategyConfig,
  next: StrategyConfig
): StrategyConfigDiff[] {
  const keys = Object.keys(
    strategyConfigModule.DEFAULT_STRATEGY_CONFIG
  ) as (keyof StrategyConfig)[];
  const changes: StrategyConfigDiff[] = [];

  for (const key of keys) {
    if (previous[key] === next[key]) {
      continue;
    }

    changes.push({
      key,
      before: String(previous[key]),
      after: String(next[key]),
    });
  }

  return changes;
}

export function parseRuntimeStrategyParamValue(key: RuntimeStrategyParamKey, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value for ${key}: ${raw}`);
  }
  return value;
}
