import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../config/addresses";
import { DeltaNeutralMonitor } from "../../strategy/monitor";
import { StrategyAction } from "../../strategy/types";
import { loadStrategyConfig } from "../../config/strategy";
import { getAmountsForLiquidity, getSqrtRatioAtTick } from "../../modules/math/ticks";
import * as uniswapReader from "../../modules/uniswap/reader";
import { getSignerAndAccount } from "./base";
import { ERC20_ABI } from "../../utils/abis";
import { getLogger } from "../../utils/logger";
import { generateDailyReport, saveDailyReport, formatReportSummary } from "../../utils/reports";

export interface DashboardOptions {
  account?: string;
  refreshInterval?: number;
  autoRefresh?: boolean;
}

/**
 * Clear the terminal screen
 */
function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

/**
 * Format a number with color based on value
 */
function formatValue(
  value: number,
  decimals: number = 2,
  color?: "green" | "yellow" | "red"
): string {
  const reset = "\x1b[0m";
  let colorCode = "";
  if (color === "green") colorCode = "\x1b[32m";
  else if (color === "yellow") colorCode = "\x1b[33m";
  else if (color === "red") colorCode = "\x1b[31m";

  const formatted = value.toFixed(decimals);
  return colorCode ? `${colorCode}${formatted}${reset}` : formatted;
}

/**
 * Format bigint value with color
 */
function formatBigInt(
  value: bigint,
  decimals: number,
  displayDecimals: number = 2,
  color?: "green" | "yellow" | "red"
): string {
  const num = parseFloat(ethers.formatUnits(value, decimals));
  return formatValue(num, displayDecimals, color);
}

/**
 * Get color for delta drift
 */
function getDeltaDriftColor(drift: number): "green" | "yellow" | "red" {
  if (drift < 0.05) return "green";
  if (drift < 0.2) return "yellow";
  return "red";
}

/**
 * Get color for recommendation action
 */
function getActionColor(action: StrategyAction): "green" | "yellow" | "red" {
  switch (action) {
    case StrategyAction.NONE:
      return "green";
    case StrategyAction.COMPOUND:
      return "yellow";
    case StrategyAction.REBALANCE:
    case StrategyAction.ADJUST_RANGE:
      return "yellow";
    default:
      return "yellow";
  }
}

/**
 * Render the dashboard
 */
function renderDashboard(
  account: string,
  status: any,
  recommendation: any,
  totalLpValueUsd: bigint,
  totalFeesUsd: bigint,
  riskTokenPrice: number,
  riskSymbol: string,
  stableSymbol: string,
  refreshTime: Date
): void {
  clearScreen();

  const totalNetValueUsd = totalLpValueUsd + status.gmx.netValueUsd;
  const deltaDriftColor = getDeltaDriftColor(status.deltaDrift);
  const actionColor = getActionColor(recommendation.action);

  const WIDTH = 78;
  const headerText = "HARMONIA STRATEGY DASHBOARD";
  const headerPadding = Math.floor((WIDTH - headerText.length) / 2);
  const headerPaddingRight = WIDTH - headerText.length - headerPadding;

  console.log("╔" + "═".repeat(WIDTH) + "╗");
  console.log("║" + " ".repeat(headerPadding) + headerText + " ".repeat(headerPaddingRight) + "║");
  console.log("╠" + "═".repeat(WIDTH) + "╣");
  console.log(`║ Account: ${account.padEnd(WIDTH - 10)} ║`);
  console.log(`║ Last Update: ${refreshTime.toLocaleTimeString().padEnd(WIDTH - 13)} ║`);
  console.log("╚" + "═".repeat(WIDTH) + "╝");
  console.log("");

  // Summary Section
  console.log("┌─ SUMMARY ─" + "─".repeat(WIDTH - 12) + "┐");
  const totalValueStr = `$${formatBigInt(totalNetValueUsd, 30, 2, "green")}`;
  console.log(`│ Total Portfolio Value: ${totalValueStr.padEnd(WIDTH - 24)} │`);
  const lpValueStr = `$${formatBigInt(totalLpValueUsd, 30, 2)}`;
  console.log(`│   ├─ LP Positions:     ${lpValueStr.padEnd(WIDTH - 24)} │`);
  const gmxValueStr = `$${formatBigInt(status.gmx.netValueUsd, 30, 2)}`;
  console.log(`│   └─ GMX Position:     ${gmxValueStr.padEnd(WIDTH - 24)} │`);
  console.log("│" + " ".repeat(WIDTH) + "│");
  const netDeltaStr = `${formatBigInt(status.netDelta, 18, 4)} ETH`;
  console.log(`│ Net Delta:            ${netDeltaStr.padEnd(WIDTH - 24)} │`);
  const deltaDriftStr = `${formatValue(status.deltaDrift * 100, 2, deltaDriftColor)}%`;
  console.log(`│ Delta Drift:          ${deltaDriftStr.padEnd(WIDTH - 24)} │`);
  console.log("│" + " ".repeat(WIDTH) + "│");
  const recommendationStr = recommendation.action;
  console.log(`│ Recommendation:       ${recommendationStr.padEnd(WIDTH - 24)} │`);
  const reasonLines = recommendation.reason.match(/.{1,73}/g) || [recommendation.reason];
  reasonLines.forEach((line: string, idx: number) => {
    const prefix = idx === 0 ? "│   " : "│   ";
    console.log(`${prefix}${line.padEnd(WIDTH - 4)} │`);
  });
  console.log("└" + "─".repeat(WIDTH) + "┘");
  console.log("");

  // Uniswap Positions
  console.log("┌─ UNISWAP POSITIONS ─" + "─".repeat(WIDTH - 22) + "┐");
  if (status.uniswap.length === 0) {
    console.log(`│ No active positions${" ".repeat(WIDTH - 21)} │`);
  } else {
    status.uniswap.forEach((pos: any, idx: number) => {
      const isLast = idx === status.uniswap.length - 1;
      const prefix = isLast ? "└" : "├";
      const positionHeader = `Position ${idx + 1} (Token ID: ${pos.tokenId})`;
      console.log(`${prefix}─ ${positionHeader.padEnd(WIDTH - 3)} │`);
      const priceRange = `[${pos.priceLower.toFixed(6)}, ${pos.priceUpper.toFixed(6)}] ${pos.priceLabel}`;
      console.log(`│   Price Range: ${priceRange.padEnd(WIDTH - 18)} │`);
      const currentPrice = `${pos.currentPrice.toFixed(6)} ${pos.priceLabel}`;
      console.log(`│   Current Price: ${currentPrice.padEnd(WIDTH - 19)} │`);
      const zoneDelta = `${pos.delta.zone.padEnd(10)} Delta: ${ethers.formatEther(pos.delta.delta)} ETH`;
      console.log(`│   Zone: ${zoneDelta.padEnd(WIDTH - 11)} │`);
      const fees = `${ethers.formatEther(pos.unclaimedFees.amount0)} ${riskSymbol}, ${ethers.formatUnits(pos.unclaimedFees.amount1, 6)} ${stableSymbol}`;
      console.log(`│   Unclaimed Fees: ${fees.padEnd(WIDTH - 19)} │`);
      if (!isLast) console.log("│" + " ".repeat(WIDTH) + "│");
    });
  }
  console.log("└" + "─".repeat(WIDTH) + "┘");
  console.log("");

  // GMX Position
  console.log("┌─ GMX HEDGE POSITION ─" + "─".repeat(WIDTH - 23) + "┐");
  const positionSize = `${ethers.formatEther(status.gmx.positionSizeTokens)} ETH (Short)`;
  console.log(`│ Position Size:      ${positionSize.padEnd(WIDTH - 24)} │`);
  const collateral = `${ethers.formatUnits(status.gmx.collateralAmount, 6)} USDC`;
  console.log(`│ Collateral:          ${collateral.padEnd(WIDTH - 24)} │`);
  const gmxNetValue = `$${formatBigInt(status.gmx.netValueUsd, 30, 2)}`;
  console.log(`│ Net Value:          ${gmxNetValue.padEnd(WIDTH - 24)} │`);
  const gmxDelta = `${ethers.formatEther(status.gmx.delta)} ETH`;
  console.log(`│ Delta:              ${gmxDelta.padEnd(WIDTH - 24)} │`);
  console.log("└" + "─".repeat(WIDTH) + "┘");
  console.log("");

  // Metrics
  console.log("┌─ METRICS ─" + "─".repeat(WIDTH - 12) + "┐");
  const totalLpDelta = `${ethers.formatEther(status.totalLpDelta)} ETH`;
  console.log(`│ Total LP Delta:     ${totalLpDelta.padEnd(WIDTH - 24)} │`);
  const totalFees = `$${formatBigInt(totalFeesUsd, 30, 2)}`;
  console.log(`│ Total Fees USD:     ${totalFees.padEnd(WIDTH - 24)} │`);
  const currentPrice = `$${formatValue(riskTokenPrice, 2)}`;
  const priceLabel = `Current ${riskSymbol} Price: `;
  const priceLabelLength = priceLabel.length;
  console.log(`│ ${priceLabel}${currentPrice.padEnd(WIDTH - priceLabelLength - 3)} │`);
  console.log("└" + "─".repeat(WIDTH) + "┘");
  console.log("");

  if (recommendation.data && recommendation.action === StrategyAction.REBALANCE) {
    console.log("┌─ REBALANCE DETAILS ─" + "─".repeat(WIDTH - 22) + "┐");
    const targetDelta = `${ethers.formatEther(recommendation.data.targetDelta)} ETH`;
    console.log(`│ Target Delta:        ${targetDelta.padEnd(WIDTH - 24)} │`);
    const currentHedge = `${ethers.formatEther(recommendation.data.currentHedge)} ETH`;
    console.log(`│ Current Hedge:       ${currentHedge.padEnd(WIDTH - 24)} │`);
    const adjustmentNeeded = `${ethers.formatEther(recommendation.data.adjustmentNeeded)} ETH`;
    console.log(`│ Adjustment Needed:   ${adjustmentNeeded.padEnd(WIDTH - 24)} │`);
    if (recommendation.data.adjustmentNeededUsd) {
      const adjustmentUsd = `$${formatBigInt(recommendation.data.adjustmentNeededUsd, 30, 2)}`;
      console.log(`│ Adjustment USD:      ${adjustmentUsd.padEnd(WIDTH - 24)} │`);
    }
    console.log("└" + "─".repeat(WIDTH) + "┘");
    console.log("");
  }

  console.log("Press Ctrl+C to exit");
}

/**
 * Main dashboard function
 */
export async function dashboard(options: DashboardOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  const logger = getLogger();
  const refreshInterval = options.refreshInterval || 30;
  const autoRefresh = options.autoRefresh !== false;

  logger.info("Starting dashboard", { account, refreshInterval, autoRefresh });

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

  let lastReportDate: string | null = null;

  const updateDashboard = async () => {
    try {
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

      // Render dashboard
      renderDashboard(
        account,
        status,
        recommendation,
        totalLpValueUsd,
        totalFeesUsd,
        riskTokenPrice,
        riskSymbol,
        stableSymbol,
        new Date()
      );

      // Generate and save daily report (once per day)
      const today = new Date().toISOString().split("T")[0];
      if (lastReportDate !== today) {
        const report = generateDailyReport(
          account,
          status,
          recommendation,
          totalLpValueUsd,
          totalFeesUsd
        );
        const reportPath = saveDailyReport(report);
        logger.info("Daily report saved", { reportPath, date: today });
        lastReportDate = today;
      }

      logger.debug("Dashboard updated", {
        totalLpValueUsd: totalLpValueUsd.toString(),
        totalFeesUsd: totalFeesUsd.toString(),
        deltaDrift: status.deltaDrift,
        recommendation: recommendation.action,
      });
    } catch (error: any) {
      logger.error("Error updating dashboard", { error: error.message });
      console.error("\nError updating dashboard:", error.message);
    }
  };

  // Initial update
  await updateDashboard();

  // Auto-refresh if enabled
  if (autoRefresh) {
    const intervalId = setInterval(async () => {
      await updateDashboard();
    }, refreshInterval * 1000);

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      clearInterval(intervalId);
      logger.info("Dashboard stopped");
      logger.close();
      clearScreen();
      console.log("\nDashboard stopped. Goodbye!");
      process.exit(0);
    });
  } else {
    logger.close();
  }
}
