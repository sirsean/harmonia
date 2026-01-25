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

export interface DaemonOptions {
  account?: string;
  interval?: number; // Monitoring interval in seconds
  dbPath?: string; // Optional custom database path
}

/**
 * Main daemon function that runs continuous monitoring
 */
export async function daemon(options: DaemonOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  const logger = getLogger();
  const interval = options.interval || 60; // Default 60 seconds
  const dbPath = options.dbPath;

  logger.info("Starting monitoring daemon", {
    account,
    interval,
    dbPath: dbPath || "default",
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

  let isRunning = true;
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5;

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

        // Store snapshot in database
        const snapshotId = db.storeSnapshot(
          account,
          status,
          recommendation,
          totalLpValueUsd,
          totalFeesUsd
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

        if (consecutiveErrors >= maxConsecutiveErrors) {
          logger.error("Too many consecutive errors, shutting down daemon", {
            consecutiveErrors,
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

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info("Received shutdown signal", { signal });
    isRunning = false;
    db.close();
    logger.close();
    // Don't call process.exit in tests - let the promise resolve naturally
    if (process.env.NODE_ENV !== "test") {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Start monitoring loop
  logger.info("Daemon started, monitoring will begin shortly", { account, interval });
  await monitoringLoop();
}
