const PRECISION = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;

export interface YieldSnapshot {
  timestamp: number;
  value: bigint;
}

function toSeconds(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

export function calculateAPR(
  startValue: bigint,
  endValue: bigint,
  elapsedSeconds: number | bigint
): bigint {
  if (startValue <= 0n) {
    throw new Error("startValue must be positive");
  }
  const elapsed = toSeconds(elapsedSeconds);
  if (elapsed <= 0n) {
    throw new Error("elapsedSeconds must be positive");
  }

  const profit = endValue - startValue;
  const ratio = (profit * PRECISION) / startValue;
  return (ratio * SECONDS_PER_YEAR) / elapsed;
}

export function calculateAPY(
  startValue: bigint,
  endValue: bigint,
  elapsedSeconds: number | bigint
): bigint {
  if (startValue <= 0n) {
    throw new Error("startValue must be positive");
  }
  const elapsed = Number(toSeconds(elapsedSeconds));
  if (!Number.isFinite(elapsed) || elapsed <= 0) {
    throw new Error("elapsedSeconds must be positive");
  }

  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) {
    throw new Error("values must be finite and positive");
  }

  const years = elapsed / Number(SECONDS_PER_YEAR);
  const ratio = end / start;
  const apy = Math.pow(ratio, 1 / years) - 1;
  return BigInt(Math.round(apy * Number(PRECISION)));
}

export function calculateAPYFromSnapshots(snapshots: YieldSnapshot[]): bigint {
  if (snapshots.length < 2) {
    throw new Error("at least two snapshots required");
  }

  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  if (last.timestamp <= first.timestamp) {
    throw new Error("snapshots must have increasing timestamps");
  }

  return calculateAPY(first.value, last.value, last.timestamp - first.timestamp);
}

/**
 * Calculate APR from net yield, position size, and time period
 * APR = (Net Yield / Position Size) × (365 days / Time Period in days)
 *
 * @param netYieldUsd Net yield in USD (fees - costs), with 30 decimals
 * @param averageNavUsd Average NAV (position size) in USD, with 30 decimals
 * @param elapsedDays Number of days in the period
 * @returns APR in basis points (1e18 precision)
 */
export function calculateAPRFromYield(
  netYieldUsd: bigint,
  averageNavUsd: bigint,
  elapsedDays: number
): bigint {
  if (averageNavUsd <= 0n) {
    throw new Error("averageNavUsd must be positive");
  }
  if (elapsedDays <= 0) {
    throw new Error("elapsedDays must be positive");
  }

  // APR = (netYield / averageNav) × (365 / elapsedDays)
  // Using PRECISION (1e18) for percentage representation
  const daysInYear = 365n;
  const elapsedDaysBigInt = BigInt(Math.floor(elapsedDays));

  // Calculate: (netYield * 365 * PRECISION) / (averageNav * elapsedDays)
  const numerator = netYieldUsd * daysInYear * PRECISION;
  const denominator = averageNavUsd * elapsedDaysBigInt;

  return numerator / denominator;
}

/**
 * Calculate APR from net yield and elapsed time in milliseconds
 * @param netYieldUsd Net yield in USD (fees - costs), with 30 decimals
 * @param averageNavUsd Average NAV (position size) in USD, with 30 decimals
 * @param elapsedMs Elapsed time in milliseconds
 * @returns APR in basis points (1e18 precision)
 */
export function calculateAPRFromYieldMs(
  netYieldUsd: bigint,
  averageNavUsd: bigint,
  elapsedMs: number
): bigint {
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  if (elapsedDays <= 0) {
    throw new Error("elapsedMs must represent at least 1 day");
  }
  return calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays);
}

export { PRECISION, SECONDS_PER_YEAR };
