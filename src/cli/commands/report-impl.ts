import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../config/addresses";
import { DeltaNeutralMonitor } from "../../strategy/monitor";
import { loadStrategyConfig } from "../../config/strategy";
import { getAmountsForLiquidity, getSqrtRatioAtTick } from "../../modules/math/ticks";
import * as uniswapReader from "../../modules/uniswap/reader";
import { getSignerAndAccount } from "./base";
import { ERC20_ABI } from "../../utils/abis";
import {
  generateDailyReport,
  saveDailyReport,
  formatReportSummary,
  DailyReport,
} from "../../utils/reports";
import { getLogger } from "../../utils/logger";
import { MonitoringDatabase } from "../../utils/database";
import {
  getAPRMetrics,
  formatAPRMetrics,
  formatAPRResult,
  calculateAPRForPeriod,
} from "../../utils/apr";
import {
  calculateCapitalBandsReport,
  formatUsd30,
  projectCapitalBands,
} from "../../utils/capital-bands";

export interface ReportOptions {
  account?: string;
  date?: string; // YYYY-MM-DD format, defaults to today
  reportsDir?: string;
}

/**
 * Generate a daily report for the strategy
 */
export async function generateReport(options: ReportOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  const logger = getLogger();

  logger.info("Generating daily report", { account, date: options.date });

  // Configuration
  const config = loadStrategyConfig();
  const context = {
    uniswap: {
      positionManager: ARBITRUM_MAINNET.uniswapV3PositionManager,
      pool: ARBITRUM_MAINNET.uniswapV3EthUsdcPool,
      tokenIds: undefined,
    },
    gmx: {
      reader: ARBITRUM_MAINNET.gmxReader,
      dataStore: ARBITRUM_MAINNET.gmxDataStore,
      account: account,
      market: ARBITRUM_MAINNET.gmxEthUsdMarket,
      collateralToken: ARBITRUM_MAINNET.usdc,
    },
    multicall3: ARBITRUM_MAINNET.multicall3,
  };

  const monitorInstance = new DeltaNeutralMonitor(ethers.provider, config, context);

  // Get pool contract to determine token order and decimals
  const poolContract = uniswapReader.createPool(context.uniswap.pool, ethers.provider);
  const poolToken0 = await poolContract.token0();
  const poolToken1 = await poolContract.token1();

  const token0Contract = new ethers.Contract(poolToken0, ERC20_ABI, ethers.provider);
  const token1Contract = new ethers.Contract(poolToken1, ERC20_ABI, ethers.provider);
  const [decimals0, decimals1, symbol0, symbol1] = await Promise.all([
    token0Contract.decimals(),
    token1Contract.decimals(),
    token0Contract.symbol(),
    token1Contract.symbol(),
  ]);

  // Determine which token is collateral (stable) vs risk
  const isToken0Collateral = poolToken0.toLowerCase() === context.gmx.collateralToken.toLowerCase();
  const riskTokenDecimals = isToken0Collateral ? decimals1 : decimals0;
  const stableDecimals = isToken0Collateral ? decimals0 : decimals1;
  const riskSymbol = isToken0Collateral ? symbol1 : symbol0;
  const stableSymbol = isToken0Collateral ? symbol0 : symbol1;
  const usdcAddress = ARBITRUM_MAINNET.usdc.toLowerCase();
  const wethAddress = ARBITRUM_MAINNET.weth.toLowerCase();
  const isToken0Usdc = poolToken0.toLowerCase() === usdcAddress;
  const isToken1Usdc = poolToken1.toLowerCase() === usdcAddress;
  const isToken0Weth = poolToken0.toLowerCase() === wethAddress;
  const isToken1Weth = poolToken1.toLowerCase() === wethAddress;

  // Helper function to convert token amount to USD (30 decimals)
  const calculateUsdValue = (amount: bigint, decimals: number, price: number): bigint => {
    if (amount === 0n) return 0n;
    const sign = amount < 0n ? -1n : 1n;
    const absAmount = amount < 0n ? -amount : amount;
    const amountStr = ethers.formatUnits(absAmount, decimals);
    const amountFloat = parseFloat(amountStr);
    const usdFloat = amountFloat * price;
    try {
      return sign * ethers.parseUnits(usdFloat.toFixed(18), 30);
    } catch (e) {
      return sign * BigInt(Math.floor(usdFloat * 1e30));
    }
  };

  // Perform monitoring check to get current status
  const { status, recommendation } = await monitorInstance.check();

  // Get current risk token price
  const riskTokenPrice = status.uniswap.length > 0 ? status.uniswap[0].currentPrice : 0;

  // Calculate total LP value and fees
  let totalLpValueUsd = 0n;
  let totalFees0 = 0n;
  let totalFees1 = 0n;

  for (const pos of status.uniswap) {
    const sqrtPriceAX96 = getSqrtRatioAtTick(pos.tickLower);
    const sqrtPriceBX96 = getSqrtRatioAtTick(pos.tickUpper);
    const { amount0, amount1 } = getAmountsForLiquidity(
      pos.sqrtPriceX96,
      sqrtPriceAX96,
      sqrtPriceBX96,
      pos.liquidity
    );

    let positionValueUsd = 0n;
    if (isToken0Collateral) {
      const stableValue = calculateUsdValue(amount0, Number(decimals0), 1.0);
      const riskValue = calculateUsdValue(amount1, Number(decimals1), riskTokenPrice);
      positionValueUsd = stableValue + riskValue;
    } else {
      const riskValue = calculateUsdValue(amount0, Number(decimals0), riskTokenPrice);
      const stableValue = calculateUsdValue(amount1, Number(decimals1), 1.0);
      positionValueUsd = riskValue + stableValue;
    }
    totalLpValueUsd += positionValueUsd;
    totalFees0 += pos.unclaimedFees.amount0;
    totalFees1 += pos.unclaimedFees.amount1;
  }

  // Calculate total fees in USD
  let totalFeesUsd = 0n;
  if (isToken0Collateral) {
    totalFeesUsd += calculateUsdValue(totalFees0, Number(decimals0), 1.0);
    totalFeesUsd += calculateUsdValue(totalFees1, Number(decimals1), riskTokenPrice);
  } else {
    totalFeesUsd += calculateUsdValue(totalFees0, Number(decimals0), riskTokenPrice);
    totalFeesUsd += calculateUsdValue(totalFees1, Number(decimals1), 1.0);
  }

  // Get wallet balances
  const [balance0, balance1, nativeEthBalance] = await Promise.all([
    token0Contract.balanceOf(account),
    token1Contract.balanceOf(account),
    ethers.provider.getBalance(account),
  ]);

  const walletBalances = {
    balance0: `${ethers.formatUnits(balance0, decimals0)} ${symbol0}`,
    balance1: `${ethers.formatUnits(balance1, decimals1)} ${symbol1}`,
    balanceEth: `${ethers.formatEther(nativeEthBalance)} ETH`,
  };

  const walletUsdcAmount = isToken0Usdc ? balance0 : isToken1Usdc ? balance1 : 0n;
  const walletWethAmount = isToken0Weth ? balance0 : isToken1Weth ? balance1 : 0n;

  const walletUsd = {
    usdcUsd: calculateUsdValue(walletUsdcAmount, Number(stableDecimals), 1.0),
    wethUsd: calculateUsdValue(walletWethAmount, Number(riskTokenDecimals), riskTokenPrice),
    ethUsd: calculateUsdValue(nativeEthBalance, 18, riskTokenPrice),
  };

  // Get APR metrics
  const db = new MonitoringDatabase();
  let aprMetricsData: { apr1d?: number; apr7d?: number; apr30d?: number } = {};
  let netYield24h: bigint | undefined;

  try {
    const metrics = await getAPRMetrics(db, account);
    aprMetricsData = {
      apr1d: metrics.rolling1d?.aprPercent,
      apr7d: metrics.rolling7d?.aprPercent,
      apr30d: metrics.rolling30d?.aprPercent,
    };

    // Get net yield for last 24h based on portfolio value delta
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const aprResult24h = await calculateAPRForPeriod(db, account, oneDayAgo, now);
    netYield24h = aprResult24h?.netYield;
  } catch (error) {
    logger.warn("Failed to fetch APR metrics or net yield for report", { error });
  } finally {
    db.close();
  }

  // Generate report
  const report = generateDailyReport(
    account,
    status,
    recommendation,
    totalLpValueUsd,
    totalFeesUsd,
    aprMetricsData,
    walletBalances,
    walletUsd,
    netYield24h
  );

  // Override date if specified
  if (options.date) {
    report.date = options.date;
    report.timestamp = new Date(`${options.date}T00:00:00Z`).getTime();
  }

  // Save report to file
  const filepath = saveDailyReport(report, options.reportsDir);

  // Print report summary
  console.log(formatReportSummary(report));
  console.log(`\nReport saved to: ${filepath}`);

  logger.info("Daily report generated successfully", {
    account,
    date: report.date,
    filepath,
    totalNetValueUsd: report.summary.totalNetValueUsd,
    deltaDrift: report.summary.deltaDrift,
  });
}

/**
 * Generate a brief Discord summary for a report
 */
export function generateDiscordSummary(report: DailyReport): {
  title: string;
  message: string;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
} {
  const totalNetValue = parseFloat(
    report.summary.totalPortfolioValueUsd ?? report.summary.totalNetValueUsd
  );
  const deltaDriftPercent = report.summary.deltaDrift * 100;
  const feesUsd = parseFloat(report.metrics.totalFeesUsd);
  const netYield24hUsd = report.metrics.netYield24h ? parseFloat(report.metrics.netYield24h) : 0;

  // Determine status emoji based on health
  let statusEmoji = "✅";
  if (deltaDriftPercent > 20) {
    statusEmoji = "🚨";
  } else if (deltaDriftPercent > 5) {
    statusEmoji = "⚠️";
  }

  const title = `📊 Harmonia : ${report.date}`;
  const message = ""; // Empty message as requested

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    {
      name: "Total Portfolio Value",
      value: `$${totalNetValue.toFixed(4)}`,
      inline: true,
    },
    {
      name: "Delta Drift",
      value: `${deltaDriftPercent.toFixed(2)}% (${parseFloat(report.summary.netDelta) > 0 ? "under" : "over"}-hedged)`,
      inline: true,
    },
    {
      name: "Unclaimed Fees",
      value: `$${feesUsd.toFixed(4)}`,
      inline: true,
    },
  ];

  if (Math.abs(netYield24hUsd) > 0) {
    fields.push({
      name: "Net Yield (24h)",
      value: `$${netYield24hUsd.toFixed(4)}`,
      inline: true,
    });
  }

  if (
    report.metrics.apr1d !== undefined ||
    report.metrics.apr7d !== undefined ||
    report.metrics.apr30d !== undefined
  ) {
    const aprParts = [];
    if (report.metrics.apr1d !== undefined)
      aprParts.push(`1d: ${report.metrics.apr1d.toFixed(2)}%`);
    if (report.metrics.apr7d !== undefined)
      aprParts.push(`7d: ${report.metrics.apr7d.toFixed(2)}%`);
    if (report.metrics.apr30d !== undefined)
      aprParts.push(`30d: ${report.metrics.apr30d.toFixed(2)}%`);

    fields.push({
      name: "APR",
      value: aprParts.join(" | "),
      inline: true,
    });
  }

  if (
    report.summary.walletBalance0 ||
    report.summary.walletBalance1 ||
    report.summary.walletBalanceEth
  ) {
    const walletLines = [];
    if (report.summary.walletBalance0) walletLines.push(report.summary.walletBalance0);
    if (report.summary.walletBalance1) walletLines.push(report.summary.walletBalance1);
    if (report.summary.walletBalanceEth) {
      let ethLine = report.summary.walletBalanceEth;
      if (report.summary.walletEthUsd) {
        ethLine += ` ($${parseFloat(report.summary.walletEthUsd).toFixed(2)})`;
      }
      walletLines.push(ethLine);
    }
    fields.push({
      name: "Wallet Balances",
      value: walletLines.join("\n"),
      inline: false,
    });
  }

  return { title, message, fields };
}

export interface APRReportOptions {
  account?: string;
  period?: string; // "1d", "7d", "30d", "90d", or "lifetime"
}

export interface CapitalBandsReportOptions {
  account?: string;
  windowHours?: number;
  dbPath?: string;
  includeEth?: boolean;
  allocations?: string;
  hedgeGasUsd?: string;
  hedgeExecFeeUsd?: string;
}

/**
 * Generate an APR report for the strategy
 */
export async function generateAPRReport(options: APRReportOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  const logger = getLogger();

  logger.info("Generating APR report", { account, period: options.period });

  const db = new MonitoringDatabase();

  try {
    // Get comprehensive APR metrics
    const metrics = await getAPRMetrics(db, account);

    console.log("\n" + formatAPRMetrics(metrics));
    console.log("");

    // Show detailed breakdown for the requested period
    const period = options.period || "30d";
    let detailedResult;

    if (period === "1d") {
      detailedResult = metrics.rolling1d;
    } else if (period === "7d") {
      detailedResult = metrics.rolling7d;
    } else if (period === "30d") {
      detailedResult = metrics.rolling30d;
    } else if (period === "90d") {
      detailedResult = metrics.rolling90d;
    } else if (period === "lifetime") {
      detailedResult = metrics.lifetime;
    } else {
      console.error(`Invalid period: ${period}. Use 1d, 7d, 30d, 90d, or lifetime`);
      return;
    }

    if (detailedResult) {
      console.log("Detailed Breakdown:");
      console.log("-".repeat(80));
      console.log(formatAPRResult(detailedResult));
    } else {
      console.log(`No data available for period: ${period}`);
    }

    logger.info("APR report generated successfully", {
      account,
      period,
      rolling1d: metrics.rolling1d?.aprPercent,
      rolling7d: metrics.rolling7d?.aprPercent,
      rolling30d: metrics.rolling30d?.aprPercent,
      rolling90d: metrics.rolling90d?.aprPercent,
      lifetime: metrics.lifetime?.aprPercent,
    });
  } catch (error: any) {
    logger.error("Failed to generate APR report", { account, error: error.message });
    console.error("\nError generating APR report:");
    console.error(error);
    throw error;
  } finally {
    db.close();
  }
}

/**
 * Generate capital bands and break-even projections from recent realized data.
 */
export async function generateCapitalBandsReport(
  options: CapitalBandsReportOptions = {}
): Promise<void> {
  const account = options.account || (await getSignerAndAccount()).account;
  const logger = getLogger();

  const windowHours = options.windowHours ?? 24;
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error(`Invalid --window-hours value: ${options.windowHours}`);
  }
  const endTime = Date.now();
  const startTime = endTime - windowHours * 60 * 60 * 1000;
  const db = new MonitoringDatabase(options.dbPath);

  logger.info("Generating capital bands report", {
    account,
    windowHours,
    includeEth: options.includeEth ?? false,
  });

  try {
    const hedgeGasAssumption = options.hedgeGasUsd
      ? ethers.parseUnits(String(options.hedgeGasUsd), 30)
      : undefined;
    const hedgeExecAssumption = options.hedgeExecFeeUsd
      ? ethers.parseUnits(String(options.hedgeExecFeeUsd), 30)
      : undefined;

    const report = calculateCapitalBandsReport(db, account, {
      startTime,
      endTime,
      includeEthWallet: options.includeEth ?? false,
      hedgeGasCostAssumptionUsd30: hedgeGasAssumption,
      hedgeExecutionFeeAssumptionUsd30: hedgeExecAssumption,
    });

    const parsedAllocations = (options.allocations || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => ethers.parseUnits(value, 30));

    const defaultMultiples = [1, 2, 3, 5, 10].map(
      (m) => (report.averageCapitalUsd30 * BigInt(m)) / 1n
    );
    const allocationSet = new Set<string>([
      report.averageCapitalUsd30.toString(),
      ...defaultMultiples.map((v) => v.toString()),
      ...parsedAllocations.map((v) => v.toString()),
    ]);
    const allocationsUsd30 = Array.from(allocationSet)
      .map((value) => BigInt(value))
      .sort((a, b) => (a < b ? -1 : 1));

    const projections = projectCapitalBands(report, allocationsUsd30);

    console.log("\nCapital Bands Report");
    console.log("=".repeat(80));
    console.log(`Account: ${account}`);
    console.log(
      `Window: ${new Date(report.periodStart).toISOString()} -> ${new Date(report.periodEnd).toISOString()}`
    );
    console.log(`Days: ${report.periodDays.toFixed(4)}`);
    console.log("");
    console.log(`Average Capital:         $${formatUsd30(report.averageCapitalUsd30)}`);
    console.log(`Start Capital:           $${formatUsd30(report.startCapitalUsd30)}`);
    console.log(`End Capital:             $${formatUsd30(report.endCapitalUsd30)}`);
    console.log(`Portfolio Change:        $${formatUsd30(report.portfolioChangeUsd30)}`);
    console.log("");
    console.log(`Fees Collected:          $${formatUsd30(report.feesCollectedUsd30)}`);
    console.log(`Recorded Op Costs:       $${formatUsd30(report.recordedOperationCostsUsd30)}`);
    console.log(`Recorded Hedge Costs:    $${formatUsd30(report.recordedHedgeCostsUsd30)}`);
    console.log(`Estimated Missing Hedge: $${formatUsd30(report.estimatedMissingHedgeCostsUsd30)}`);
    console.log(`Total Estimated Costs:   $${formatUsd30(report.totalEstimatedCostsUsd30)}`);
    console.log(`Unexplained PnL:         $${formatUsd30(report.unexplainedPnlUsd30)}`);
    console.log("");
    console.log(`Optimizations:           ${report.optimizationCount}`);
    console.log(`Hedge Adjustments:       ${report.hedgeAdjustmentCount}`);
    console.log(`Avg Hedge Adjustment:    $${formatUsd30(report.averageHedgeNotionalUsd30)}`);
    console.log(
      `Assumed Hedge Gas:       $${formatUsd30(report.hedgeGasCostAssumptionUsd30, 6)} / tx`
    );
    console.log(
      `Assumed Hedge Exec Fee:  $${formatUsd30(report.hedgeExecutionFeeAssumptionUsd30, 6)} / tx`
    );
    console.log("");
    console.log("Break-even Capital (Window Model):");
    console.log(
      "- optimistic (residual drag fixed): " +
        (projections[0].scenarios[0].breakEvenCapitalUsd30
          ? `$${formatUsd30(projections[0].scenarios[0].breakEvenCapitalUsd30!)}`
          : "not reachable")
    );
    console.log(
      "- base (50% residual scales): " +
        (projections[0].scenarios[1].breakEvenCapitalUsd30
          ? `$${formatUsd30(projections[0].scenarios[1].breakEvenCapitalUsd30!)}`
          : "not reachable")
    );
    console.log(
      "- conservative (100% residual scales): " +
        (projections[0].scenarios[2].breakEvenCapitalUsd30
          ? `$${formatUsd30(projections[0].scenarios[2].breakEvenCapitalUsd30!)}`
          : "not reachable")
    );

    console.log("\nProjected Net PnL Per Day by Allocation:");
    console.log("allocation_usd | optimistic | base | conservative");
    console.log("-".repeat(80));
    for (const projection of projections) {
      const optimisticDaily =
        Number(ethers.formatUnits(projection.scenarios[0].projectedWindowPnlUsd30, 30)) /
        report.periodDays;
      const baseDaily =
        Number(ethers.formatUnits(projection.scenarios[1].projectedWindowPnlUsd30, 30)) /
        report.periodDays;
      const conservativeDaily =
        Number(ethers.formatUnits(projection.scenarios[2].projectedWindowPnlUsd30, 30)) /
        report.periodDays;

      console.log(
        `${formatUsd30(projection.allocationUsd30, 2).padStart(13)} | ${optimisticDaily.toFixed(2).padStart(10)} | ${baseDaily.toFixed(2).padStart(6)} | ${conservativeDaily.toFixed(2).padStart(12)}`
      );
    }
  } catch (error: any) {
    logger.error("Failed to generate capital bands report", { account, error: error.message });
    console.error("\nError generating capital bands report:");
    console.error(error);
    throw error;
  } finally {
    db.close();
  }
}
