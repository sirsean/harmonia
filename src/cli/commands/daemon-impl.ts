import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../config/addresses";
import { DeltaNeutralMonitor } from "../../strategy/monitor";
import { loadStrategyConfig } from "../../config/strategy";
import { getAmountsForLiquidity, getSqrtRatioAtTick } from "../../modules/math/ticks";
import * as uniswapReader from "../../modules/uniswap/reader";
import { getSignerAndAccount } from "./base";
import { ERC20_ABI } from "../../utils/abis";
import { MonitoringDatabase } from "../../utils/database";
import { getLogger } from "../../utils/logger";
import { getAPRMetrics, calculateAPRForPeriod } from "../../utils/apr";
import { executeOptimize } from "./strategy/execute-optimize";
import { executeHedgeAdjust } from "./strategy/execute-hedge-adjust";
import { StrategyAction } from "../../strategy/types";
import {
  sendErrorAlert,
  sendWarningAlert,
  sendSuccessAlert,
  sendInfoAlert,
  sendDiscordAlert,
} from "../../utils/alerts";
import { generateDailyReport, saveDailyReport } from "../../utils/reports";
import { generateDiscordSummary } from "./report-impl";
import { StrategyStatus, Recommendation } from "../../strategy/types";

export interface DaemonOptions {
  account?: string;
  interval?: number; // Monitoring interval in seconds
  dbPath?: string; // Optional custom database path
  autoOptimize?: boolean; // Automatically execute optimization when recommended
}

/**
 * Main daemon function that runs continuous monitoring
 */
export async function daemon(options: DaemonOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  const logger = getLogger();
  const interval = options.interval || 60; // Default 60 seconds
  const dbPath = options.dbPath;

  const autoOptimize = options.autoOptimize ?? false;

  logger.info("Starting monitoring daemon", {
    account,
    interval,
    dbPath: dbPath || "default",
    autoOptimize,
  });

  // Initialize database
  const db = new MonitoringDatabase(dbPath);

  // Initialize monitor
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

  const monitorInstance = new DeltaNeutralMonitor(ethers.provider, config, context, db);

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

  // Track last report date to avoid generating multiple reports per day
  let lastReportDate: string | null = null; // Track last report date (YYYY-MM-DD)

  /**
   * Check if it's time to generate a daily report (5am CT)
   * Returns true if it's past 5am CT today and we haven't generated a report yet
   */
  const shouldGenerateReport = (): boolean => {
    const now = new Date();

    // Get today's date in YYYY-MM-DD format
    const today = now.toISOString().split("T")[0];

    // If we already generated a report today, don't generate another one
    if (lastReportDate === today) {
      return false;
    }

    // Convert to Central Time (CT)
    // CT is UTC-6 (CST) or UTC-5 (CDT) depending on DST
    // 5am CT = 11am UTC (CST) or 10am UTC (CDT)
    // To handle both cases safely, we check if UTC hour >= 11
    // This ensures we're definitely past 5am CT in both time zones
    // For CDT (UTC-5): 5am CT = 10am UTC, so >= 11am UTC is safe
    // For CST (UTC-6): 5am CT = 11am UTC, so >= 11am UTC is correct
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();

    // Check if it's past 5am CT
    // We use >= 11:00 UTC to ensure we're past 5am CT in both CST and CDT
    const isPast5amCT = utcHour > 11 || (utcHour === 11 && utcMinute >= 0);

    // Generate report if it's past 5am CT and we haven't generated one today
    return isPast5amCT;
  };

  /**
   * Generate daily report and send Discord summary
   */
  const generateDailyReportAndNotify = async (
    status: StrategyStatus,
    recommendation: Recommendation,
    totalLpValueUsd: bigint,
    totalFeesUsd: bigint
  ): Promise<void> => {
    try {
      logger.info("Generating daily report", { account });

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

      const riskTokenPrice = status.uniswap.length > 0 ? status.uniswap[0].currentPrice : 0;
      const walletUsdcAmount = isToken0Usdc ? balance0 : isToken1Usdc ? balance1 : 0n;
      const walletWethAmount = isToken0Weth ? balance0 : isToken1Weth ? balance1 : 0n;

      const walletUsd = {
        usdcUsd: calculateUsdValue(walletUsdcAmount, Number(stableDecimals), 1.0),
        wethUsd: calculateUsdValue(walletWethAmount, Number(riskTokenDecimals), riskTokenPrice),
        ethUsd: calculateUsdValue(nativeEthBalance, 18, riskTokenPrice),
      };

      // Get APR metrics
      let aprMetricsData: { apr1d?: number; apr7d?: number; apr30d?: number } = {};
      try {
        const metrics = await getAPRMetrics(db, account);
        aprMetricsData = {
          apr1d: metrics.rolling1d?.aprPercent,
          apr7d: metrics.rolling7d?.aprPercent,
          apr30d: metrics.rolling30d?.aprPercent,
        };
      } catch (error) {
        logger.warn("Failed to fetch APR metrics for report", { error });
      }

      // Get collected fees for last 24h
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const aprResult24h = await calculateAPRForPeriod(db, account, oneDayAgo, now);
      const collectedFees24h = db.getFeesCollected(account, oneDayAgo, now);

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
        aprResult24h?.netYield ?? collectedFees24h
      );

      // Save report to file
      const filepath = saveDailyReport(report);
      logger.info("Daily report saved", { filepath, date: report.date });

      // Update last report date
      lastReportDate = report.date;

      // Generate and send Discord summary
      const summary = generateDiscordSummary(report);
      await sendDiscordAlert({
        title: summary.title,
        message: summary.message,
        fields: summary.fields,
        severity: "info",
      }).catch((alertError) => {
        logger.warn("Failed to send Discord report summary", { error: alertError.message });
      });

      logger.info("Daily report generated and Discord summary sent", { date: report.date });
    } catch (reportError: any) {
      logger.error("Failed to generate daily report", {
        error: reportError.message,
        stack: reportError.stack,
      });
      // Don't throw - we don't want report generation failures to stop the daemon
    }
  };

  let isRunning = true;
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5;
  let consecutiveOptimizationFailures = 0;
  const maxConsecutiveOptimizationFailures = 3; // Stop auto-optimization after 3 failures
  let isOptimizationInProgress = false; // Prevent concurrent optimizations
  let isHedgeInProgress = false; // Prevent concurrent hedge adjustments
  let consecutiveHedgeFailures = 0;
  const maxConsecutiveHedgeFailures = 3;

  // Monitoring loop
  const monitoringLoop = async (): Promise<void> => {
    while (isRunning) {
      try {
        // Check if we should stop before starting a new check
        if (!isRunning) break;

        logger.debug("Running monitoring check", { account, timestamp: Date.now() });

        // Perform monitoring check
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

        // Get wallet balances (token0/token1 + native ETH)
        const [balance0, balance1, nativeEthBalance] = await Promise.all([
          token0Contract.balanceOf(account),
          token1Contract.balanceOf(account),
          ethers.provider.getBalance(account),
        ]);

        const walletUsdcAmount = isToken0Usdc ? balance0 : isToken1Usdc ? balance1 : 0n;
        const walletWethAmount = isToken0Weth ? balance0 : isToken1Weth ? balance1 : 0n;

        const walletUsdcUsd = calculateUsdValue(walletUsdcAmount, Number(stableDecimals), 1.0);
        const walletWethUsd = calculateUsdValue(
          walletWethAmount,
          Number(riskTokenDecimals),
          riskTokenPrice
        );
        const walletEthUsd = calculateUsdValue(nativeEthBalance, 18, riskTokenPrice);

        // Store snapshot in database
        const snapshotId = db.storeSnapshot(
          account,
          status,
          recommendation,
          totalLpValueUsd,
          totalFeesUsd,
          walletEthUsd,
          walletWethUsd,
          walletUsdcUsd
        );

        const totalNavUsd = totalLpValueUsd + status.gmx.netValueUsd;

        logger.info("Monitoring snapshot stored", {
          snapshotId,
          account,
          timestamp: status.timestamp,
          totalNavUsd: totalNavUsd.toString(),
          totalLpValueUsd: totalLpValueUsd.toString(),
          gmxNetValueUsd: status.gmx.netValueUsd.toString(),
          netDelta: status.netDelta.toString(),
          deltaDrift: status.deltaDrift,
          recommendation: recommendation.action,
        });

        consecutiveErrors = 0; // Reset error counter on success

        // Check if it's time to generate daily report (5am CT)
        if (shouldGenerateReport()) {
          await generateDailyReportAndNotify(status, recommendation, totalLpValueUsd, totalFeesUsd);
        }

        // Auto-optimization logic
        if (
          autoOptimize &&
          recommendation.action === StrategyAction.OPTIMIZE &&
          !isOptimizationInProgress &&
          consecutiveOptimizationFailures < maxConsecutiveOptimizationFailures
        ) {
          isOptimizationInProgress = true;
          logger.info("Auto-optimization triggered", {
            reason: recommendation.reason,
            deltaDrift: status.deltaDrift,
            totalFeesUsd: totalFeesUsd.toString(),
          });

          try {
            // Execute optimization
            const optimizeResult = await executeOptimize({
              account,
              execute: true,
              suppressAlert: true,
            });

            // Optimization succeeded - reset failure counter
            consecutiveOptimizationFailures = 0;
            logger.info("Auto-optimization completed successfully", {
              feesCollectedUsd: optimizeResult.feesCollectedUsd.toString(),
            });

            // Fetch APR metrics for the report
            let apr1d: number | undefined;
            let apr7d: number | undefined;
            try {
              const metrics = await getAPRMetrics(db, account);
              apr1d = metrics.rolling1d?.aprPercent;
              apr7d = metrics.rolling7d?.aprPercent;
            } catch (error) {
              logger.warn("Failed to fetch APR metrics for optimization alert", { error });
            }

            // Send success alert for auto-optimization
            // Use actual fees collected from optimization, not unclaimed fees from before
            const fields = [
              {
                name: "Total NAV",
                value: `$${parseFloat(ethers.formatUnits(totalNavUsd, 30)).toFixed(4)}`,
                inline: true,
              },
              {
                name: "Delta Drift Before",
                value: `${(status.deltaDrift * 100).toFixed(2)}% (${status.netDelta > 0n ? "under" : "over"}-hedged)`,
                inline: true,
              },
              {
                name: "Fees Collected",
                value: `$${parseFloat(ethers.formatUnits(optimizeResult.feesCollectedUsd, 30)).toFixed(4)}`,
                inline: true,
              },
            ];

            if (apr1d !== undefined) {
              fields.push({ name: "1d APR", value: `${apr1d.toFixed(2)}%`, inline: true });
            }
            if (apr7d !== undefined) {
              fields.push({ name: "7d APR", value: `${apr7d.toFixed(2)}%`, inline: true });
            }

            try {
              const [balance0, balance1, nativeEthBalance] = await Promise.all([
                token0Contract.balanceOf(account),
                token1Contract.balanceOf(account),
                ethers.provider.getBalance(account),
              ]);
              const balance0Str = `${ethers.formatUnits(balance0, decimals0)} ${symbol0}`;
              const balance1Str = `${ethers.formatUnits(balance1, decimals1)} ${symbol1}`;
              const balanceEthStr = `${ethers.formatEther(nativeEthBalance)} ETH`;
              fields.push({
                name: "Wallet Balances",
                value: `${balance0Str}\n${balance1Str}\n${balanceEthStr}`,
                inline: false,
              });
            } catch (error: any) {
              logger.warn("Failed to fetch wallet balances for optimization alert", {
                error: error.message,
              });
            }

            await sendSuccessAlert("✅ Harmonia : Optimized", "", fields).catch((alertError) => {
              logger.warn("Failed to send Discord alert", { error: alertError.message });
            });

            // Record successful optimization in database
            try {
              const gasCostUsd = config.estimatedOptimizationGasCostUsd;
              const benefitUsd = recommendation.data?.estimatedBenefitUsd || totalFeesUsd;
              db.recordOptimization(
                account,
                status.deltaDrift,
                totalFeesUsd,
                gasCostUsd,
                benefitUsd
              );
            } catch (dbError: any) {
              logger.warn("Failed to record optimization in database", {
                error: dbError.message,
              });
              // Don't fail the optimization if DB recording fails
            }
          } catch (optimizationError: any) {
            consecutiveOptimizationFailures++;
            logger.error("Auto-optimization failed", {
              error: optimizationError.message,
              stack: optimizationError.stack,
              consecutiveOptimizationFailures,
              maxFailures: maxConsecutiveOptimizationFailures,
            });

            // Send error alert for optimization failure
            await sendErrorAlert(
              "❌ Auto-Optimization Failed",
              `Daemon failed to automatically optimize the strategy position.`,
              optimizationError
            ).catch((alertError) => {
              logger.warn("Failed to send Discord alert", { error: alertError.message });
            });

            // Record failure in database for recovery and analysis
            try {
              db.recordOptimizationFailure(
                account,
                optimizationError.message,
                optimizationError.stack,
                status.deltaDrift,
                totalFeesUsd,
                recommendation.reason
              );
            } catch (dbError: any) {
              logger.warn("Failed to record optimization failure in database", {
                error: dbError.message,
              });
              // Continue even if DB recording fails
            }

            // If we've hit max failures, disable auto-optimization
            if (consecutiveOptimizationFailures >= maxConsecutiveOptimizationFailures) {
              logger.error(
                "Auto-optimization disabled due to consecutive failures. Manual intervention required.",
                {
                  consecutiveOptimizationFailures,
                  lastError: optimizationError.message,
                }
              );

              // Send critical alert when auto-optimization is disabled
              await sendErrorAlert(
                "🚨 Auto-Optimization Disabled",
                `Auto-optimization has been disabled due to ${consecutiveOptimizationFailures} consecutive failures. Manual intervention required.`,
                [
                  { name: "Account", value: account, inline: false },
                  {
                    name: "Consecutive Failures",
                    value: `${consecutiveOptimizationFailures}/${maxConsecutiveOptimizationFailures}`,
                    inline: true,
                  },
                  {
                    name: "Last Error",
                    value: optimizationError.message,
                    inline: false,
                  },
                ]
              ).catch((alertError) => {
                logger.warn("Failed to send Discord alert", { error: alertError.message });
              });

              // Log recent failures for debugging
              try {
                const recentFailures = db.getRecentOptimizationFailures(account, 5);
                logger.error("Recent optimization failures", {
                  count: recentFailures.length,
                  failures: recentFailures.map((f) => ({
                    timestamp: new Date(f.timestamp).toISOString(),
                    error: f.errorMessage,
                    deltaDrift: f.deltaDrift,
                  })),
                });
              } catch (dbError: any) {
                logger.warn("Failed to retrieve recent failures", {
                  error: dbError.message,
                });
              }
            }
          } finally {
            isOptimizationInProgress = false;
          }
        } else if (autoOptimize && recommendation.action === StrategyAction.OPTIMIZE) {
          if (isOptimizationInProgress) {
            logger.debug("Skipping optimization - already in progress");
          } else if (consecutiveOptimizationFailures >= maxConsecutiveOptimizationFailures) {
            logger.warn("Skipping optimization - too many consecutive failures", {
              consecutiveOptimizationFailures,
            });
          }
        }

        // Hedge adjustment logic
        if (
          autoOptimize &&
          recommendation.action === StrategyAction.HEDGE_ADJUST &&
          recommendation.hedgeData &&
          !isHedgeInProgress &&
          !isOptimizationInProgress &&
          consecutiveHedgeFailures < maxConsecutiveHedgeFailures
        ) {
          isHedgeInProgress = true;
          logger.info("Hedge adjustment triggered", {
            reason: recommendation.reason,
            deltaDrift: status.deltaDrift,
            direction: recommendation.hedgeData.adjustmentSizeUsd > 0n ? "increase" : "decrease",
            adjustmentUsd: recommendation.hedgeData.adjustmentSizeUsd.toString(),
          });

          try {
            const hedgeResult = await executeHedgeAdjust({
              account,
              hedgeData: recommendation.hedgeData,
              deltaDriftBefore: status.deltaDrift,
              execute: true,
              suppressAlert: true,
              dbPath,
            });

            consecutiveHedgeFailures = 0;
            logger.info("Hedge adjustment completed successfully", {
              direction: hedgeResult.direction,
              adjustmentSizeUsd: hedgeResult.adjustmentSizeUsd.toString(),
              txHash: hedgeResult.txHash,
            });

            // Send alert
            const hedgeFields = [
              {
                name: "Direction",
                value: hedgeResult.direction === "increase" ? "Increase Short" : "Decrease Short",
                inline: true,
              },
              {
                name: "Adjustment",
                value: `$${parseFloat(ethers.formatUnits(hedgeResult.adjustmentSizeUsd, 30)).toFixed(4)}`,
                inline: true,
              },
              {
                name: "Delta Drift Before",
                value: `${(status.deltaDrift * 100).toFixed(2)}% (${status.netDelta > 0n ? "under" : "over"}-hedged)`,
                inline: true,
              },
            ];

            if (recommendation.hedgeData) {
              hedgeFields.push({
                name: "Leverage",
                value: `${recommendation.hedgeData.currentLeverage.toFixed(2)}x → ${recommendation.hedgeData.estimatedLeverageAfter.toFixed(2)}x`,
                inline: true,
              });
            }

            await sendSuccessAlert(
              `🔧 Harmonia : Hedge ${hedgeResult.direction === "increase" ? "Increased" : "Decreased"}`,
              "",
              hedgeFields
            ).catch((alertError) => {
              logger.warn("Failed to send hedge adjustment alert", { error: alertError.message });
            });
          } catch (hedgeError: any) {
            consecutiveHedgeFailures++;
            logger.error("Hedge adjustment failed", {
              error: hedgeError.message,
              stack: hedgeError.stack,
              consecutiveHedgeFailures,
              maxFailures: maxConsecutiveHedgeFailures,
            });

            await sendErrorAlert(
              "❌ Hedge Adjustment Failed",
              `Daemon failed to execute hedge adjustment.`,
              hedgeError
            ).catch((alertError) => {
              logger.warn("Failed to send Discord alert", { error: alertError.message });
            });

            if (consecutiveHedgeFailures >= maxConsecutiveHedgeFailures) {
              logger.error(
                "Hedge adjustments disabled due to consecutive failures. Will rely on full optimizations.",
                { consecutiveHedgeFailures }
              );
            }
          } finally {
            isHedgeInProgress = false;
          }
        } else if (autoOptimize && recommendation.action === StrategyAction.HEDGE_ADJUST) {
          if (isHedgeInProgress) {
            logger.debug("Skipping hedge adjustment - already in progress");
          } else if (isOptimizationInProgress) {
            logger.debug("Skipping hedge adjustment - optimization in progress");
          } else if (consecutiveHedgeFailures >= maxConsecutiveHedgeFailures) {
            logger.warn("Skipping hedge adjustment - too many consecutive failures", {
              consecutiveHedgeFailures,
            });
          }
        }

        // Wait for next interval (check isRunning periodically)
        if (isRunning) {
          await new Promise((resolve) => {
            const timeoutId = setTimeout(resolve, interval * 1000);
            // Check if we should stop early
            const checkInterval = setInterval(() => {
              if (!isRunning) {
                clearInterval(checkInterval);
                clearTimeout(timeoutId);
                resolve(undefined);
              }
            }, 100);
          });
        }
      } catch (error: any) {
        consecutiveErrors++;
        logger.error("Error during monitoring check", {
          error: error.message,
          stack: error.stack,
          consecutiveErrors,
        });

        // Send warning alert for monitoring errors
        if (consecutiveErrors === 1) {
          // Only send alert on first error to avoid spam
          await sendWarningAlert(
            "⚠️ Monitoring Check Failed",
            `An error occurred during monitoring check. Daemon will retry.`,
            [
              { name: "Account", value: account, inline: false },
              { name: "Error", value: error.message, inline: false },
              {
                name: "Consecutive Errors",
                value: `${consecutiveErrors}/${maxConsecutiveErrors}`,
                inline: true,
              },
            ]
          ).catch((alertError) => {
            logger.warn("Failed to send Discord alert", { error: alertError.message });
          });
        }

        if (consecutiveErrors >= maxConsecutiveErrors) {
          logger.error("Too many consecutive errors, shutting down daemon", {
            consecutiveErrors,
          });

          // Send critical alert when daemon shuts down due to errors
          await sendErrorAlert(
            "🚨 Daemon Shutting Down",
            `Daemon is shutting down due to ${consecutiveErrors} consecutive errors.`,
            [
              { name: "Account", value: account, inline: false },
              {
                name: "Consecutive Errors",
                value: `${consecutiveErrors}/${maxConsecutiveErrors}`,
                inline: true,
              },
              { name: "Last Error", value: error.message, inline: false },
            ]
          ).catch((alertError) => {
            logger.warn("Failed to send Discord alert", { error: alertError.message });
          });

          isRunning = false;
          break;
        }

        // Wait before retrying (exponential backoff)
        const backoffDelay = Math.min(interval * 1000 * Math.pow(2, consecutiveErrors - 1), 300000); // Max 5 minutes
        logger.warn("Retrying after backoff", { backoffDelay: backoffDelay / 1000 });
        if (isRunning) {
          await new Promise((resolve) => {
            const timeoutId = setTimeout(resolve, backoffDelay);
            // Check if we should stop early
            const checkInterval = setInterval(() => {
              if (!isRunning) {
                clearInterval(checkInterval);
                clearTimeout(timeoutId);
                resolve(undefined);
              }
            }, 100);
          });
        }
      }
    }
  };

  const handleSigint = () => shutdown("SIGINT");
  const handleSigterm = () => shutdown("SIGTERM");

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info("Received shutdown signal", { signal });
    isRunning = false;
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    db.close();
    logger.close();
    // Don't call process.exit in tests - let the promise resolve naturally
    if (process.env.NODE_ENV !== "test") {
      process.exit(0);
    }
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  // Start monitoring loop
  logger.info("Daemon started, monitoring will begin shortly", { account, interval });
  await monitoringLoop();
}
