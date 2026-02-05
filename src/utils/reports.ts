/**
 * Report generation utilities for Harmonia
 *
 * Generates daily summary reports stored in a configurable reports directory.
 */

import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { StrategyStatus, Recommendation } from "../strategy/types";

export interface DailyReport {
  date: string;
  timestamp: number;
  account: string;
  summary: {
    totalLpValueUsd: string;
    totalGmxValueUsd: string;
    totalNetValueUsd: string;
    totalPortfolioValueUsd: string;
    netDelta: string;
    deltaDrift: number;
    recommendation: string;
    walletBalance0?: string; // e.g. "1.23 WETH"
    walletBalance1?: string; // e.g. "1000.00 USDC"
    walletBalanceEth?: string; // e.g. "0.05 ETH"
    walletEthUsd?: string;
  };
  positions: {
    uniswap: Array<{
      tokenId: string;
      priceRange: string;
      currentPrice: number;
      zone: string;
      delta: string;
      valueUsd: string;
      unclaimedFees: {
        amount0: string;
        amount1: string;
      };
    }>;
    gmx: {
      positionSizeTokens: string;
      collateralAmount: string;
      netValueUsd: string;
      delta: string;
    };
  };
  metrics: {
    totalLpDelta: string;
    totalFeesUsd: string; // Unclaimed fees
    netYield24h?: string; // Net yield in last 24h
    deltaDriftPercent: number;
    apr1d?: number;
    apr7d?: number;
    apr30d?: number;
  };
}

/**
 * Generate daily summary report from strategy status
 */
export function generateDailyReport(
  account: string,
  status: StrategyStatus,
  recommendation: Recommendation,
  totalLpValueUsd: bigint,
  totalFeesUsd: bigint,
  aprMetrics?: {
    apr1d?: number;
    apr7d?: number;
    apr30d?: number;
  },
  walletBalances?: {
    balance0: string;
    balance1: string;
    balanceEth?: string;
  },
  walletUsd?: {
    ethUsd: bigint;
    wethUsd: bigint;
    usdcUsd: bigint;
  },
  netYield24h?: bigint
): DailyReport {
  const totalNetValueUsd = totalLpValueUsd + status.gmx.netValueUsd;
  const totalPortfolioValueUsd =
    totalNetValueUsd + totalFeesUsd + (walletUsd?.wethUsd ?? 0n) + (walletUsd?.usdcUsd ?? 0n);

  const report: DailyReport = {
    date: new Date().toISOString().split("T")[0],
    timestamp: Date.now(),
    account,
    summary: {
      totalLpValueUsd: ethers.formatUnits(totalLpValueUsd, 30),
      totalGmxValueUsd: ethers.formatUnits(status.gmx.netValueUsd, 30),
      totalNetValueUsd: ethers.formatUnits(totalNetValueUsd, 30),
      totalPortfolioValueUsd: ethers.formatUnits(totalPortfolioValueUsd, 30),
      netDelta: ethers.formatEther(status.netDelta),
      deltaDrift: status.deltaDrift,
      recommendation: recommendation.action,
      walletBalance0: walletBalances?.balance0,
      walletBalance1: walletBalances?.balance1,
      walletBalanceEth: walletBalances?.balanceEth,
      walletEthUsd: walletUsd?.ethUsd ? ethers.formatUnits(walletUsd.ethUsd, 30) : undefined,
    },
    positions: {
      uniswap: status.uniswap.map((pos) => ({
        tokenId: pos.tokenId,
        priceRange: `[${pos.priceLower.toFixed(6)}, ${pos.priceUpper.toFixed(6)}]`,
        currentPrice: pos.currentPrice,
        zone: pos.delta.zone,
        delta: ethers.formatEther(pos.delta.delta),
        valueUsd: "0", // Will be calculated separately if needed
        unclaimedFees: {
          amount0: ethers.formatEther(pos.unclaimedFees.amount0),
          amount1: ethers.formatUnits(pos.unclaimedFees.amount1, 6),
        },
      })),
      gmx: {
        positionSizeTokens: ethers.formatEther(status.gmx.positionSizeTokens),
        collateralAmount: ethers.formatUnits(status.gmx.collateralAmount, 6),
        netValueUsd: ethers.formatUnits(status.gmx.netValueUsd, 30),
        delta: ethers.formatEther(status.gmx.delta),
      },
    },
    metrics: {
      totalLpDelta: ethers.formatEther(status.totalLpDelta),
      totalFeesUsd: ethers.formatUnits(totalFeesUsd, 30),
      netYield24h: netYield24h ? ethers.formatUnits(netYield24h, 30) : undefined,
      deltaDriftPercent: status.deltaDrift * 100,
      apr1d: aprMetrics?.apr1d,
      apr7d: aprMetrics?.apr7d,
      apr30d: aprMetrics?.apr30d,
    },
  };

  return report;
}

/**
 * Save daily report to file
 */
export function saveDailyReport(report: DailyReport, reportsDir?: string): string {
  const reportsDirectory = reportsDir || process.env.REPORTS_DIR || "reports";

  try {
    // Ensure reports directory exists
    if (!fs.existsSync(reportsDirectory)) {
      fs.mkdirSync(reportsDirectory, { recursive: true });
    }

    // Generate filename: YYYY-MM-DD.json
    const filename = `${report.date}.json`;
    const filepath = path.join(reportsDirectory, filename);

    // Write report as JSON
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), "utf-8");

    return filepath;
  } catch (error) {
    throw new Error(`Failed to save daily report: ${error}`);
  }
}

/**
 * Load daily report from file
 */
export function loadDailyReport(date: string, reportsDir?: string): DailyReport | null {
  const reportsDirectory = reportsDir || process.env.REPORTS_DIR || "reports";
  const filename = `${date}.json`;
  const filepath = path.join(reportsDirectory, filename);

  if (!fs.existsSync(filepath)) {
    return null;
  }

  const content = fs.readFileSync(filepath, "utf-8");
  return JSON.parse(content) as DailyReport;
}

/**
 * Get all available report dates
 */
export function getAvailableReports(reportsDir?: string): string[] {
  const reportsDirectory = reportsDir || process.env.REPORTS_DIR || "reports";

  if (!fs.existsSync(reportsDirectory)) {
    return [];
  }

  const files = fs.readdirSync(reportsDirectory);
  return files
    .filter((file) => file.endsWith(".json") && /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .map((file) => file.replace(".json", ""))
    .sort()
    .reverse(); // Most recent first
}

/**
 * Generate human-readable report summary text
 */
export function formatReportSummary(report: DailyReport): string {
  const lines: string[] = [];

  lines.push("=".repeat(80));
  lines.push(`Daily Summary Report - ${report.date}`);
  lines.push("=".repeat(80));
  lines.push("");

  lines.push("SUMMARY");
  lines.push("-".repeat(80));
  lines.push(`Account: ${report.account}`);
  lines.push(`Total LP Value: $${report.summary.totalLpValueUsd}`);
  lines.push(`Total GMX Value: $${report.summary.totalGmxValueUsd}`);
  const totalPortfolioValue =
    report.summary.totalPortfolioValueUsd ?? report.summary.totalNetValueUsd;
  lines.push(`Total Portfolio Value: $${totalPortfolioValue}`);
  lines.push(`Total Net Value (Positions): $${report.summary.totalNetValueUsd}`);
  lines.push(`Net Delta: ${report.summary.netDelta} ETH`);
  const summaryDriftDir = parseFloat(report.summary.netDelta) > 0 ? "under" : "over";
  lines.push(
    `Delta Drift: ${(report.summary.deltaDrift * 100).toFixed(2)}% (${summaryDriftDir}-hedged)`
  );
  lines.push(`Recommendation: ${report.summary.recommendation}`);

  if (report.summary.walletBalance0 || report.summary.walletBalance1) {
    lines.push("");
    lines.push(`Wallet Balances:`);
    if (report.summary.walletBalance0) lines.push(`  ${report.summary.walletBalance0}`);
    if (report.summary.walletBalance1) lines.push(`  ${report.summary.walletBalance1}`);
    if (report.summary.walletBalanceEth) {
      let ethLine = `  ${report.summary.walletBalanceEth}`;
      if (report.summary.walletEthUsd) {
        ethLine += ` ($${parseFloat(report.summary.walletEthUsd).toFixed(2)})`;
      }
      lines.push(ethLine);
    }
  }
  lines.push("");

  lines.push("UNISWAP POSITIONS");
  lines.push("-".repeat(80));
  if (report.positions.uniswap.length === 0) {
    lines.push("No active positions");
  } else {
    report.positions.uniswap.forEach((pos, idx) => {
      lines.push(`Position ${idx + 1}:`);
      lines.push(`  Token ID: ${pos.tokenId}`);
      lines.push(`  Price Range: ${pos.priceRange}`);
      lines.push(`  Current Price: ${pos.currentPrice.toFixed(6)}`);
      lines.push(`  Zone: ${pos.zone}`);
      lines.push(`  Delta: ${pos.delta} ETH`);
      lines.push(
        `  Unclaimed Fees: ${pos.unclaimedFees.amount0} ETH, ${pos.unclaimedFees.amount1} USDC`
      );
      lines.push("");
    });
  }

  lines.push("GMX POSITION");
  lines.push("-".repeat(80));
  lines.push(`Position Size: ${report.positions.gmx.positionSizeTokens} ETH (Short)`);
  lines.push(`Collateral: ${report.positions.gmx.collateralAmount} USDC`);
  lines.push(`Net Value: $${report.positions.gmx.netValueUsd}`);
  lines.push(`Delta: ${report.positions.gmx.delta} ETH`);
  lines.push("");

  lines.push("METRICS");
  lines.push("-".repeat(80));
  lines.push(`Total LP Delta: ${report.metrics.totalLpDelta} ETH`);
  lines.push(`Total Fees USD: $${report.metrics.totalFeesUsd} (Unclaimed)`);
  if (report.metrics.netYield24h) {
    lines.push(`Net Yield (24h): $${report.metrics.netYield24h}`);
  }
  const metricsDriftDir = parseFloat(report.summary.netDelta) > 0 ? "under" : "over";
  lines.push(
    `Delta Drift: ${report.metrics.deltaDriftPercent.toFixed(2)}% (${metricsDriftDir}-hedged)`
  );

  if (
    report.metrics.apr1d !== undefined ||
    report.metrics.apr7d !== undefined ||
    report.metrics.apr30d !== undefined
  ) {
    lines.push("");
    lines.push("APR:");
    if (report.metrics.apr1d !== undefined)
      lines.push(`  1d:  ${report.metrics.apr1d.toFixed(2)}%`);
    if (report.metrics.apr7d !== undefined)
      lines.push(`  7d:  ${report.metrics.apr7d.toFixed(2)}%`);
    if (report.metrics.apr30d !== undefined)
      lines.push(`  30d: ${report.metrics.apr30d.toFixed(2)}%`);
  }
  lines.push("");

  lines.push("=".repeat(80));

  return lines.join("\n");
}
