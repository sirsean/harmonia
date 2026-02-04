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
    case StrategyAction.OPTIMIZE:
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
  walletEthUsd: bigint,
  walletWethUsd: bigint,
  walletUsdcUsd: bigint,
  walletBalances: { balance0: string; balance1: string; balanceEth: string },
  riskTokenPrice: number,
  riskSymbol: string,
  stableSymbol: string,
  refreshTime: Date
): void {
  clearScreen();

  const totalNetValueUsd = totalLpValueUsd + status.gmx.netValueUsd;
  const totalPortfolioValueUsd =
    totalNetValueUsd + totalFeesUsd + walletEthUsd + walletWethUsd + walletUsdcUsd;
  const deltaDriftColor = getDeltaDriftColor(status.deltaDrift);
  const actionColor = getActionColor(recommendation.action);

  const headerText = "HARMONIA STRATEGY DASHBOARD";
  const LINE_LENGTH = 50;

  console.log("╔" + "═".repeat(LINE_LENGTH) + "╗");
  console.log(
    "║" +
      " ".repeat(Math.floor((LINE_LENGTH - headerText.length) / 2)) +
      headerText +
      " ".repeat(Math.ceil((LINE_LENGTH - headerText.length) / 2)) +
      "║"
  );
  console.log("╠" + "═".repeat(LINE_LENGTH) + "╣");
  console.log(`║ Account: ${account}`);
  console.log(`║ Last Update: ${refreshTime.toLocaleTimeString()}`);
  console.log("╚" + "═".repeat(LINE_LENGTH) + "╝");
  console.log("");

  // Summary Section
  console.log("┌─ SUMMARY ─" + "-".repeat(5));
  const totalValueStr = `$${formatBigInt(totalPortfolioValueUsd, 30, 2, "green")}`;
  console.log(`│ Total Portfolio Value: ${totalValueStr}`);
  const lpValueStr = `$${formatBigInt(totalLpValueUsd, 30, 2)}`;
  console.log(`│   ├─ LP Positions:     ${lpValueStr}`);
  const gmxValueStr = `$${formatBigInt(status.gmx.netValueUsd, 30, 2)}`;
  console.log(`│   ├─ GMX Position:     ${gmxValueStr}`);
  const feesValueStr = `$${formatBigInt(totalFeesUsd, 30, 2)}`;
  console.log(`│   ├─ Unclaimed Fees:   ${feesValueStr}`);
  const walletValueStr = `$${formatBigInt(walletEthUsd + walletWethUsd + walletUsdcUsd, 30, 2)}`;
  console.log(`│   └─ Wallet Value:     ${walletValueStr}`);
  console.log("│");
  const netDeltaStr = `${formatBigInt(status.netDelta, 18, 4)} ETH`;
  console.log(`│ Net Delta:            ${netDeltaStr}`);
  const driftDirection = status.netDelta > 0n ? "under" : "over";
  const deltaDriftStr = `${formatValue(status.deltaDrift * 100, 2, deltaDriftColor)}% (${driftDirection}-hedged)`;
  console.log(`│ Delta Drift:          ${deltaDriftStr}`);
  console.log("│");
  const recommendationStr = recommendation.action;
  console.log(`│ Recommendation:       ${recommendationStr}`);
  const reasonLines = recommendation.reason.match(/.{1,73}/g) || [recommendation.reason];
  reasonLines.forEach((line: string) => {
    console.log(`│   ${line}`);
  });
  console.log("│");
  console.log(`│ Wallet Balances:`);
  console.log(`│   ${walletBalances.balance0}`);
  console.log(`│   ${walletBalances.balance1}`);
  console.log(`│   ${walletBalances.balanceEth}`);
  console.log("");

  // Uniswap Positions
  console.log("┌─ UNISWAP POSITIONS ─" + "-".repeat(5));
  if (status.uniswap.length === 0) {
    console.log("│ No active positions");
  } else {
    status.uniswap.forEach((pos: any, idx: number) => {
      const isLast = idx === status.uniswap.length - 1;
      const prefix = isLast ? "└" : "├";
      const positionHeader = `Position ${idx + 1} (Token ID: ${pos.tokenId})`;
      console.log(`${prefix}─ ${positionHeader}`);
      const priceRange = `[${pos.priceLower.toFixed(6)}, ${pos.priceUpper.toFixed(6)}] ${pos.priceLabel}`;
      console.log(`│   Price Range: ${priceRange}`);
      const currentPrice = `${pos.currentPrice.toFixed(6)} ${pos.priceLabel}`;
      console.log(`│   Current Price: ${currentPrice}`);
      const zoneDelta = `${pos.delta.zone.padEnd(10)} Delta: ${ethers.formatEther(pos.delta.delta)} ETH`;
      console.log(`│   Zone: ${zoneDelta}`);
      const fees = `${ethers.formatEther(pos.unclaimedFees.amount0)} ${riskSymbol}, ${ethers.formatUnits(pos.unclaimedFees.amount1, 6)} ${stableSymbol}`;
      console.log(`│   Unclaimed Fees: ${fees}`);
      if (!isLast) console.log("│");
    });
  }
  console.log("");

  // GMX Position
  console.log("┌─ GMX HEDGE POSITION ─" + "-".repeat(5));
  const positionSize = `${ethers.formatEther(status.gmx.positionSizeTokens)} ETH (Short)`;
  console.log(`│ Position Size:      ${positionSize}`);
  const collateral = `${ethers.formatUnits(status.gmx.collateralAmount, 6)} USDC`;
  console.log(`│ Collateral:          ${collateral}`);
  const gmxNetValue = `$${formatBigInt(status.gmx.netValueUsd, 30, 2)}`;
  console.log(`│ Net Value:          ${gmxNetValue}`);
  const gmxDelta = `${ethers.formatEther(status.gmx.delta)} ETH`;
  console.log(`│ Delta:              ${gmxDelta}`);
  console.log("");

  // Metrics
  console.log("┌─ METRICS ─" + "-".repeat(5));
  const totalLpDelta = `${ethers.formatEther(status.totalLpDelta)} ETH`;
  console.log(`│ Total LP Delta:     ${totalLpDelta}`);
  const totalFees = `$${formatBigInt(totalFeesUsd, 30, 2)}`;
  console.log(`│ Total Fees USD:     ${totalFees}`);
  const currentPrice = `$${formatValue(riskTokenPrice, 2)}`;
  console.log(`│ Current ${riskSymbol} Price: ${currentPrice}`);
  console.log("");

  if (recommendation.data && recommendation.action === StrategyAction.OPTIMIZE) {
    console.log("┌─ OPTIMIZATION DETAILS ─" + "-".repeat(5));
    const deltaDrift = `${formatValue(recommendation.data.deltaDrift * 100, 2)}% (${status.netDelta > 0n ? "under" : "over"}-hedged)`;
    console.log(`│ Delta Drift:          ${deltaDrift}`);
    const outOfRange = recommendation.data.anyOutOfRange ? "Yes" : "No";
    console.log(`│ Out of Range:         ${outOfRange}`);
    if (recommendation.data.totalFeesUsd) {
      const fees = `$${formatBigInt(recommendation.data.totalFeesUsd, 30, 2)}`;
      console.log(`│ Unclaimed Fees:        ${fees}`);
    }
    if (recommendation.data.timeSinceLastOptimization !== undefined) {
      const hoursSince = (recommendation.data.timeSinceLastOptimization / 3600).toFixed(1);
      console.log(`│ Time Since Last:      ${hoursSince}h`);
    }
    if (recommendation.data.estimatedGasCostUsd) {
      const gasCost = `$${formatBigInt(recommendation.data.estimatedGasCostUsd, 30, 2)}`;
      console.log(`│ Est. Gas Cost:         ${gasCost}`);
    }
    if (recommendation.data.estimatedBenefitUsd) {
      const benefit = `$${formatBigInt(recommendation.data.estimatedBenefitUsd, 30, 2)}`;
      console.log(`│ Est. Benefit:          ${benefit}`);
      if (recommendation.data.estimatedGasCostUsd && recommendation.data.estimatedGasCostUsd > 0n) {
        const ratio =
          Number(recommendation.data.estimatedBenefitUsd) /
          Number(recommendation.data.estimatedGasCostUsd);
        console.log(`│ Benefit/Cost Ratio:    ${ratio.toFixed(2)}x`);
      }
    }
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

      // Wallet balances (token0/token1 + native ETH)
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

      const walletUsdcUsd = calculateUsdValue(walletUsdcAmount, Number(stableDecimals), 1.0);
      const walletWethUsd = calculateUsdValue(
        walletWethAmount,
        Number(riskTokenDecimals),
        riskTokenPrice
      );
      const walletEthUsd = calculateUsdValue(nativeEthBalance, 18, riskTokenPrice);

      // Render dashboard
      renderDashboard(
        account,
        status,
        recommendation,
        totalLpValueUsd,
        totalFeesUsd,
        walletEthUsd,
        walletWethUsd,
        walletUsdcUsd,
        walletBalances,
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
          totalFeesUsd,
          undefined,
          walletBalances,
          {
            ethUsd: walletEthUsd,
            wethUsd: walletWethUsd,
            usdcUsd: walletUsdcUsd,
          }
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
