import { MonitoringDatabase, RuntimeParamRecord } from "../../../utils/database";
import {
  RUNTIME_STRATEGY_PARAM_KEYS,
  RuntimeStrategyParamKey,
  clearRuntimeStrategyParam,
  getRuntimeControlValue,
  isRuntimeStrategyParamKey,
  loadEffectiveStrategyConfig,
  parseRuntimeStrategyParamValue,
  setRuntimeControlValue,
  setRuntimeStrategyParam,
} from "../../../strategy/runtime-config";
import { getSignerAndAccount } from "../base";

export interface StrategyParamsShowOptions {
  account?: string;
  global?: boolean;
  dbPath?: string;
}

export interface StrategyParamsSetOptions {
  account?: string;
  key: string;
  value: string;
  ttl?: number;
  reason?: string;
  dbPath?: string;
  global?: boolean;
}

export interface StrategyParamsClearOptions {
  account?: string;
  key: string;
  reason?: string;
  dbPath?: string;
  global?: boolean;
}

export interface StrategyParamsHistoryOptions {
  account?: string;
  key?: string;
  limit?: number;
  dbPath?: string;
  global?: boolean;
}

export interface StrategyParamsAutoOptions {
  account?: string;
  enable?: boolean;
  disable?: boolean;
  reason?: string;
  dbPath?: string;
  global?: boolean;
}

function formatScope(account: string | null): string {
  return account === null ? "global" : `account:${account}`;
}

function formatParamRecord(record: RuntimeParamRecord): string {
  const expires = record.expiresAt ? new Date(record.expiresAt).toISOString() : "none";
  const lock = record.isLocked ? "locked" : "unlocked";
  return `${record.key}=${record.value} (scope=${formatScope(record.account)}, source=${record.source}, ${lock}, expires=${expires}${record.reason ? `, reason=${record.reason}` : ""})`;
}

async function resolveScopeAccount(options: {
  account?: string;
  global?: boolean;
}): Promise<string | null> {
  if (options.global) {
    return null;
  }

  const { account } = await getSignerAndAccount(options.account);
  return account;
}

function assertRuntimeStrategyKey(key: string): RuntimeStrategyParamKey {
  if (!isRuntimeStrategyParamKey(key)) {
    throw new Error(
      `Invalid runtime strategy key: ${key}. Allowed keys: ${RUNTIME_STRATEGY_PARAM_KEYS.join(", ")}`
    );
  }

  return key;
}

function printEffectiveConfig(db: MonitoringDatabase, account: string | null): void {
  const effective = loadEffectiveStrategyConfig(db, account ?? undefined).config;

  console.log("Effective strategy config:");
  for (const key of RUNTIME_STRATEGY_PARAM_KEYS) {
    console.log(`  ${key}: ${effective[key]}`);
  }
}

export async function showStrategyParams(options: StrategyParamsShowOptions): Promise<void> {
  const scopeAccount = await resolveScopeAccount(options);
  const db = new MonitoringDatabase(options.dbPath);

  try {
    const effective = loadEffectiveStrategyConfig(db, scopeAccount ?? undefined);
    const activeParams = scopeAccount
      ? db.listRuntimeParams({ account: scopeAccount, includeGlobal: true })
      : db.listRuntimeParams({ account: null });

    console.log(`Scope: ${formatScope(scopeAccount)}`);
    console.log(`Applied runtime params: ${effective.appliedParams.length}`);

    printEffectiveConfig(db, scopeAccount);

    console.log("Active runtime parameters:");
    if (activeParams.length === 0) {
      console.log("  (none)");
      return;
    }

    for (const param of activeParams) {
      console.log(`  ${formatParamRecord(param)}`);
    }
  } finally {
    db.close();
  }
}

export async function setStrategyParam(options: StrategyParamsSetOptions): Promise<void> {
  const scopeAccount = await resolveScopeAccount(options);
  const key = assertRuntimeStrategyKey(options.key);
  const value = parseRuntimeStrategyParamValue(key, options.value);

  let expiresAt: number | undefined;
  if (options.ttl !== undefined) {
    if (!Number.isFinite(options.ttl) || options.ttl <= 0) {
      throw new Error(`TTL must be a positive number of seconds, got ${options.ttl}`);
    }
    expiresAt = Date.now() + Math.floor(options.ttl * 1000);
  }

  const db = new MonitoringDatabase(options.dbPath);

  try {
    const result = setRuntimeStrategyParam({
      db,
      account: scopeAccount,
      key,
      value,
      source: "manual",
      expiresAt,
      reason: options.reason,
      isLocked: true,
    });

    if (!result.applied) {
      throw new Error(`Failed to set ${key}: ${result.reason ?? "unknown"}`);
    }

    console.log(
      `Set ${key}=${value} for ${formatScope(scopeAccount)}${expiresAt ? ` (expires ${new Date(expiresAt).toISOString()})` : ""}`
    );
    printEffectiveConfig(db, scopeAccount);
  } finally {
    db.close();
  }
}

export async function clearStrategyParam(options: StrategyParamsClearOptions): Promise<void> {
  const scopeAccount = await resolveScopeAccount(options);
  const key = assertRuntimeStrategyKey(options.key);

  const db = new MonitoringDatabase(options.dbPath);
  try {
    const result = clearRuntimeStrategyParam({
      db,
      account: scopeAccount,
      key,
      source: "manual",
      reason: options.reason,
    });

    if (!result.cleared) {
      console.log(`No runtime param found for ${key} on ${formatScope(scopeAccount)}.`);
    } else {
      console.log(`Cleared ${key} on ${formatScope(scopeAccount)}.`);
    }

    printEffectiveConfig(db, scopeAccount);
  } finally {
    db.close();
  }
}

export async function showStrategyParamHistory(
  options: StrategyParamsHistoryOptions
): Promise<void> {
  const scopeAccount = await resolveScopeAccount(options);
  const db = new MonitoringDatabase(options.dbPath);

  try {
    const key = options.key ? assertRuntimeStrategyKey(options.key) : undefined;
    const history = db.listRuntimeParamHistory({
      account: scopeAccount,
      key,
      limit: options.limit,
    });

    console.log(`History scope: ${formatScope(scopeAccount)}`);
    if (history.length === 0) {
      console.log("No history entries.");
      return;
    }

    for (const entry of history) {
      const timestamp = new Date(entry.timestamp).toISOString();
      console.log(
        `${timestamp} ${entry.action.toUpperCase()} ${entry.key} scope=${formatScope(entry.account)} source=${entry.source} old=${entry.oldValue ?? "null"} new=${entry.newValue ?? "null"}${entry.reason ? ` reason=${entry.reason}` : ""}`
      );
    }
  } finally {
    db.close();
  }
}

export async function setAutoTuning(options: StrategyParamsAutoOptions): Promise<void> {
  if ((options.enable && options.disable) || (!options.enable && !options.disable)) {
    throw new Error("Provide exactly one of --enable or --disable");
  }

  const enabled = Boolean(options.enable);
  const scopeAccount = await resolveScopeAccount(options);
  const db = new MonitoringDatabase(options.dbPath);

  try {
    const result = setRuntimeControlValue({
      db,
      account: scopeAccount,
      key: "autoTuningEnabled",
      value: enabled,
      source: "manual",
      reason: options.reason ?? (enabled ? "auto-tuner enabled" : "auto-tuner disabled"),
      isLocked: true,
    });

    if (!result.applied) {
      throw new Error(`Failed to update auto-tuner state: ${result.reason ?? "unknown"}`);
    }

    const effectiveValue = getRuntimeControlValue<boolean>(
      db,
      "autoTuningEnabled",
      scopeAccount ?? undefined
    );

    console.log(
      `Auto-tuner ${enabled ? "enabled" : "disabled"} for ${formatScope(scopeAccount)}. Effective value: ${effectiveValue}`
    );
  } finally {
    db.close();
  }
}
