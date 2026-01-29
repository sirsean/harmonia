/**
 * APR calculation utilities for Harmonia
 *
 * Calculates APR based on fees collected, costs incurred, and position size over time.
 */

import { MonitoringDatabase } from "./database";
import { calculateAPRFromYieldMs, PRECISION } from "../modules/math/yield";
import { ethers } from "ethers";

export interface APRResult {
  periodStart: number;
  periodEnd: number;
  feesCollected: bigint;
  costsIncurred: bigint;
  netYield: bigint;
  averageNav: bigint;
  aprBps: bigint; // APR in basis points (1e18 precision)
  aprPercent: number; // APR as a percentage (e.g., 15.89)
}

/**
 * Calculate APR for a specific time period
 */
export async function calculateAPRForPeriod(
  db: MonitoringDatabase,
  account: string,
  startTime: number,
  endTime: number
): Promise<APRResult | null> {
  const feesCollected = db.getFeesCollected(account, startTime, endTime);
  const costsIncurred = db.getTotalCosts(account, startTime, endTime);
  const averageNav = db.getAverageNav(account, startTime, endTime);

  if (averageNav === 0n) {
    return null; // No position data available
  }

  const netYield = feesCollected - costsIncurred;
  const elapsedMs = endTime - startTime;

  if (elapsedMs <= 0) {
    return null; // Invalid time period
  }

  const aprBps = calculateAPRFromYieldMs(netYield, averageNav, elapsedMs);
  const aprPercent = Number(aprBps) / Number(PRECISION) * 100;

  return {
    periodStart: startTime,
    periodEnd: endTime,
    feesCollected,
    costsIncurred,
    netYield,
    averageNav,
    aprBps,
    aprPercent,
  };
}

/**
 * Calculate rolling APR for a specific window (e.g., last 7 days)
 */
export async function calculateRollingAPR(
  db: MonitoringDatabase,
  account: string,
  windowDays: number
): Promise<APRResult | null> {
  const endTime = Date.now();
  const startTime = endTime - windowDays * 24 * 60 * 60 * 1000;

  return calculateAPRForPeriod(db, account, startTime, endTime);
}

/**
 * Calculate lifetime APR (from first snapshot to now)
 */
export async function calculateLifetimeAPR(
  db: MonitoringDatabase,
  account: string
): Promise<APRResult | null> {
  // Get first snapshot timestamp
  const snapshots = db.getSnapshots(account, undefined, undefined, 1);
  if (snapshots.length === 0) {
    return null; // No data available
  }

  // Get snapshots in reverse order (oldest first)
  const allSnapshots = db.getSnapshots(account);
  if (allSnapshots.length === 0) {
    return null;
  }

  const firstSnapshot = allSnapshots[allSnapshots.length - 1]; // Oldest
  const startTime = firstSnapshot.timestamp;
  const endTime = Date.now();

  return calculateAPRForPeriod(db, account, startTime, endTime);
}

/**
 * Format APR result for display
 */
export function formatAPRResult(result: APRResult): string {
  const lines: string[] = [];

  const startDate = new Date(result.periodStart).toISOString().split("T")[0];
  const endDate = new Date(result.periodEnd).toISOString().split("T")[0];
  const days = (result.periodEnd - result.periodStart) / (1000 * 60 * 60 * 24);

  lines.push(`Period: ${startDate} to ${endDate} (${days.toFixed(1)} days)`);
  lines.push("");
  lines.push(`Fees Collected:     $${ethers.formatUnits(result.feesCollected, 30)}`);
  lines.push(`Costs Incurred:    $${ethers.formatUnits(result.costsIncurred, 30)}`);
  lines.push(`Net Yield:         $${ethers.formatUnits(result.netYield, 30)}`);
  lines.push(`Average NAV:       $${ethers.formatUnits(result.averageNav, 30)}`);
  lines.push("");
  lines.push(`Period APR:        ${result.aprPercent.toFixed(2)}%`);
  lines.push(`Annualized APR:    ${result.aprPercent.toFixed(2)}%`);

  return lines.join("\n");
}

/**
 * Get comprehensive APR metrics for an account
 */
export async function getAPRMetrics(
  db: MonitoringDatabase,
  account: string
): Promise<{
  rolling7d: APRResult | null;
  rolling30d: APRResult | null;
  rolling90d: APRResult | null;
  lifetime: APRResult | null;
}> {
  const [rolling7d, rolling30d, rolling90d, lifetime] = await Promise.all([
    calculateRollingAPR(db, account, 7),
    calculateRollingAPR(db, account, 30),
    calculateRollingAPR(db, account, 90),
    calculateLifetimeAPR(db, account),
  ]);

  return {
    rolling7d,
    rolling30d,
    rolling90d,
    lifetime,
  };
}

/**
 * Format comprehensive APR metrics for display
 */
export function formatAPRMetrics(metrics: {
  rolling7d: APRResult | null;
  rolling30d: APRResult | null;
  rolling90d: APRResult | null;
  lifetime: APRResult | null;
}): string {
  const lines: string[] = [];

  lines.push("APR Metrics");
  lines.push("=".repeat(80));
  lines.push("");

  if (metrics.rolling7d) {
    lines.push(`Last 7 days:       ${metrics.rolling7d.aprPercent.toFixed(2)}%`);
  } else {
    lines.push(`Last 7 days:       N/A (insufficient data)`);
  }

  if (metrics.rolling30d) {
    lines.push(`Last 30 days:      ${metrics.rolling30d.aprPercent.toFixed(2)}%`);
  } else {
    lines.push(`Last 30 days:      N/A (insufficient data)`);
  }

  if (metrics.rolling90d) {
    lines.push(`Last 90 days:      ${metrics.rolling90d.aprPercent.toFixed(2)}%`);
  } else {
    lines.push(`Last 90 days:      N/A (insufficient data)`);
  }

  if (metrics.lifetime) {
    lines.push(`Lifetime:          ${metrics.lifetime.aprPercent.toFixed(2)}%`);
  } else {
    lines.push(`Lifetime:          N/A (insufficient data)`);
  }

  return lines.join("\n");
}
