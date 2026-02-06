import { ethers } from "ethers";
import { MonitoringDatabase, MonitoringSnapshot } from "./database";

const USD_30 = 10n ** 30n;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CapitalBandsOptions {
  startTime: number;
  endTime: number;
  includeEthWallet?: boolean;
  hedgeGasCostAssumptionUsd30?: bigint;
  hedgeExecutionFeeAssumptionUsd30?: bigint;
}

export interface ProjectionScenario {
  name: "optimistic" | "base" | "conservative";
  unexplainedScalingFactor: number;
  componentReturnUsd30: bigint;
  breakEvenCapitalUsd30: bigint | null;
  projectedWindowPnlUsd30: bigint;
}

export interface CapitalProjection {
  allocationUsd30: bigint;
  scenarios: ProjectionScenario[];
}

export interface CapitalBandsReport {
  periodStart: number;
  periodEnd: number;
  periodDays: number;
  averageCapitalUsd30: bigint;
  startCapitalUsd30: bigint;
  endCapitalUsd30: bigint;
  portfolioChangeUsd30: bigint;
  feesCollectedUsd30: bigint;
  recordedOperationCostsUsd30: bigint;
  recordedHedgeCostsUsd30: bigint;
  estimatedMissingHedgeCostsUsd30: bigint;
  totalEstimatedCostsUsd30: bigint;
  unexplainedPnlUsd30: bigint;
  optimizationCount: number;
  hedgeAdjustmentCount: number;
  averageHedgeNotionalUsd30: bigint;
  hedgeGasCostAssumptionUsd30: bigint;
  hedgeExecutionFeeAssumptionUsd30: bigint;
}

function parseUsdTo30(value: string): bigint {
  return ethers.parseUnits(value, 30);
}

function snapshotPortfolioValue(snapshot: MonitoringSnapshot, includeEthWallet: boolean): bigint {
  const base =
    BigInt(snapshot.totalNavUsd) +
    BigInt(snapshot.totalFeesUsd) +
    BigInt(snapshot.walletWethUsd || "0") +
    BigInt(snapshot.walletUsdcUsd || "0");

  if (!includeEthWallet) {
    return base;
  }

  return base + BigInt(snapshot.walletEthUsd || "0");
}

function avgBigInt(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  return values.reduce((acc, v) => acc + v, 0n) / BigInt(values.length);
}

function projectWindowPnl(
  allocationUsd30: bigint,
  averageCapitalUsd30: bigint,
  componentReturnUsd30: bigint,
  totalEstimatedCostsUsd30: bigint
): bigint {
  if (averageCapitalUsd30 <= 0n) return 0n;
  const scaledComponent = (componentReturnUsd30 * allocationUsd30) / averageCapitalUsd30;
  return scaledComponent - totalEstimatedCostsUsd30;
}

function computeBreakEvenCapital(
  averageCapitalUsd30: bigint,
  componentReturnUsd30: bigint,
  totalEstimatedCostsUsd30: bigint
): bigint | null {
  if (averageCapitalUsd30 <= 0n || componentReturnUsd30 <= 0n) return null;
  return (totalEstimatedCostsUsd30 * averageCapitalUsd30) / componentReturnUsd30;
}

export function calculateCapitalBandsReport(
  db: MonitoringDatabase,
  account: string,
  options: CapitalBandsOptions
): CapitalBandsReport {
  const includeEthWallet = options.includeEthWallet ?? false;
  const snapshotsDesc = db.getSnapshots(account, options.startTime, options.endTime);

  if (snapshotsDesc.length < 2) {
    throw new Error("Not enough snapshots in the selected window (need at least 2)");
  }

  const snapshotsAsc = [...snapshotsDesc].sort((a, b) => a.timestamp - b.timestamp);
  const startSnapshot = snapshotsAsc[0];
  const endSnapshot = snapshotsAsc[snapshotsAsc.length - 1];

  const startCapitalUsd30 = snapshotPortfolioValue(startSnapshot, includeEthWallet);
  const endCapitalUsd30 = snapshotPortfolioValue(endSnapshot, includeEthWallet);
  const portfolioChangeUsd30 = endCapitalUsd30 - startCapitalUsd30;

  const averageCapitalUsd30 = avgBigInt(
    snapshotsAsc.map((snapshot) => snapshotPortfolioValue(snapshot, includeEthWallet))
  );

  const feesCollectedUsd30 = db.getFeesCollected(account, options.startTime, options.endTime);

  const rawDb = db.getDb();
  const operationCosts = rawDb
    .prepare(
      `
      SELECT gas_cost_usd, gmx_execution_fee_usd
      FROM operation_history
      WHERE account = ? AND timestamp >= ? AND timestamp <= ?
    `
    )
    .all(account, options.startTime, options.endTime) as Array<{
    gas_cost_usd: string | null;
    gmx_execution_fee_usd: string | null;
  }>;

  let recordedOperationCostsUsd30 = 0n;
  for (const row of operationCosts) {
    if (row.gas_cost_usd) {
      recordedOperationCostsUsd30 += BigInt(row.gas_cost_usd);
    }
    if (row.gmx_execution_fee_usd) {
      recordedOperationCostsUsd30 += db.normalizeUsdValue(row.gmx_execution_fee_usd, true);
    }
  }

  const hedgeTableInfo = rawDb
    .prepare("PRAGMA table_info(hedge_adjustment_history)")
    .all() as Array<{
    name: string;
  }>;
  const hasHedgeGas = hedgeTableInfo.some((col) => col.name === "gas_cost_usd");
  const hasHedgeGmxFee = hedgeTableInfo.some((col) => col.name === "gmx_execution_fee_usd");

  const hedgeRows = rawDb
    .prepare(
      `
      SELECT adjustment_size_usd, gas_cost_usd, gmx_execution_fee_usd
      FROM hedge_adjustment_history
      WHERE account = ? AND timestamp >= ? AND timestamp <= ?
    `
    )
    .all(account, options.startTime, options.endTime) as Array<{
    adjustment_size_usd: string;
    gas_cost_usd?: string | null;
    gmx_execution_fee_usd?: string | null;
  }>;

  const optimizationRows = rawDb
    .prepare(
      `
      SELECT gas_cost_usd, gmx_execution_fee_usd
      FROM operation_history
      WHERE account = ? AND timestamp >= ? AND timestamp <= ?
    `
    )
    .all(account, options.startTime, options.endTime) as Array<{
    gas_cost_usd: string | null;
    gmx_execution_fee_usd: string | null;
  }>;

  const avgOptimizationGasUsd30 = avgBigInt(
    optimizationRows
      .filter((row) => row.gas_cost_usd)
      .map((row) => BigInt(row.gas_cost_usd as string))
  );

  const avgOptimizationGmxFeeUsd30 = avgBigInt(
    optimizationRows
      .filter((row) => row.gmx_execution_fee_usd)
      .map((row) => db.normalizeUsdValue(row.gmx_execution_fee_usd as string, true))
  );

  const hedgeGasCostAssumptionUsd30 =
    options.hedgeGasCostAssumptionUsd30 ?? avgOptimizationGasUsd30;
  const hedgeExecutionFeeAssumptionUsd30 =
    options.hedgeExecutionFeeAssumptionUsd30 ?? avgOptimizationGmxFeeUsd30;

  const averageHedgeNotionalUsd30 = avgBigInt(
    hedgeRows.map((row) => {
      try {
        return BigInt(row.adjustment_size_usd);
      } catch {
        return 0n;
      }
    })
  );

  let recordedHedgeCostsUsd30 = 0n;
  let missingHedgeCostRows = 0;

  for (const row of hedgeRows) {
    const gas = hasHedgeGas && row.gas_cost_usd ? BigInt(row.gas_cost_usd) : 0n;
    const gmx =
      hasHedgeGmxFee && row.gmx_execution_fee_usd
        ? db.normalizeUsdValue(row.gmx_execution_fee_usd, true)
        : 0n;

    recordedHedgeCostsUsd30 += gas + gmx;

    if (gas === 0n && gmx === 0n) {
      missingHedgeCostRows += 1;
    }
  }

  const estimatedMissingHedgeCostsUsd30 =
    BigInt(missingHedgeCostRows) * (hedgeGasCostAssumptionUsd30 + hedgeExecutionFeeAssumptionUsd30);

  const totalEstimatedCostsUsd30 =
    recordedOperationCostsUsd30 + recordedHedgeCostsUsd30 + estimatedMissingHedgeCostsUsd30;

  // Anything not explained by realized fees and estimated tx costs is treated as a scale-sensitive residual.
  const unexplainedPnlUsd30 =
    portfolioChangeUsd30 - (feesCollectedUsd30 - totalEstimatedCostsUsd30);

  const optimizationCount = optimizationRows.length;
  const hedgeAdjustmentCount = hedgeRows.length;

  return {
    periodStart: options.startTime,
    periodEnd: options.endTime,
    periodDays: (options.endTime - options.startTime) / MS_PER_DAY,
    averageCapitalUsd30,
    startCapitalUsd30,
    endCapitalUsd30,
    portfolioChangeUsd30,
    feesCollectedUsd30,
    recordedOperationCostsUsd30,
    recordedHedgeCostsUsd30,
    estimatedMissingHedgeCostsUsd30,
    totalEstimatedCostsUsd30,
    unexplainedPnlUsd30,
    optimizationCount,
    hedgeAdjustmentCount,
    averageHedgeNotionalUsd30,
    hedgeGasCostAssumptionUsd30,
    hedgeExecutionFeeAssumptionUsd30,
  };
}

export function projectCapitalBands(
  report: CapitalBandsReport,
  allocationsUsd30: bigint[]
): CapitalProjection[] {
  const scenarios: Array<{ name: ProjectionScenario["name"]; factor: number }> = [
    { name: "optimistic", factor: 0 },
    { name: "base", factor: 0.5 },
    { name: "conservative", factor: 1 },
  ];

  return allocationsUsd30.map((allocationUsd30) => ({
    allocationUsd30,
    scenarios: scenarios.map(({ name, factor }) => {
      const componentReturnUsd30 =
        report.feesCollectedUsd30 +
        (report.unexplainedPnlUsd30 * parseUsdTo30(factor.toFixed(6))) / USD_30;

      return {
        name,
        unexplainedScalingFactor: factor,
        componentReturnUsd30,
        breakEvenCapitalUsd30: computeBreakEvenCapital(
          report.averageCapitalUsd30,
          componentReturnUsd30,
          report.totalEstimatedCostsUsd30
        ),
        projectedWindowPnlUsd30: projectWindowPnl(
          allocationUsd30,
          report.averageCapitalUsd30,
          componentReturnUsd30,
          report.totalEstimatedCostsUsd30
        ),
      };
    }),
  }));
}

export function formatUsd30(value: bigint, decimals = 4): string {
  const num = Number(ethers.formatUnits(value, 30));
  if (!Number.isFinite(num)) {
    return ethers.formatUnits(value, 30);
  }
  return num.toFixed(decimals);
}
