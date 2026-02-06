import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../config/addresses";
import { DeltaNeutralMonitor } from "../../strategy/monitor";
import { StrategyAction } from "../../strategy/types";
import { getAmountsForLiquidity, getSqrtRatioAtTick } from "../../modules/math/ticks";
import * as uniswapReader from "../../modules/uniswap/reader";
import { getSignerAndAccount } from "./base";
import { ERC20_ABI } from "../../utils/abis";
import { sendErrorAlert, sendWarningAlert } from "../../utils/alerts";
import { MonitoringDatabase } from "../../utils/database";
import { loadEffectiveStrategyConfig } from "../../strategy/runtime-config";

export interface MonitorOptions {
  account?: string;
  tokenId?: string;
  minFeeThreshold?: string;
}

export async function monitor(options: MonitorOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  console.log("Monitoring account:", account);
  const runtimeDb = new MonitoringDatabase();

  // Configuration from environment or defaults
  const tokenIds = options.tokenId ? [BigInt(options.tokenId)] : undefined;

  const minOptimizationFeeThresholdUsd = options.minFeeThreshold
    ? ethers.parseUnits(options.minFeeThreshold, 30)
    : ethers.parseUnits("10", 30); // $10 worth of fees (USD 30 decimals)

  const effectiveConfig = loadEffectiveStrategyConfig(runtimeDb, account).config;
  const config = {
    ...effectiveConfig,
    minOptimizationFeeThresholdUsd,
  };

  const context = {
    uniswap: {
      positionManager: ARBITRUM_MAINNET.uniswapV3PositionManager,
      pool: ARBITRUM_MAINNET.uniswapV3EthUsdcPool,
      tokenIds: tokenIds,
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

  console.log("--- Strategy Check ---");
  try {
    const { status, recommendation } = await monitorInstance.check();

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
    const isToken0Collateral =
      poolToken0.toLowerCase() === context.gmx.collateralToken.toLowerCase();
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

    // Get current risk token price (from first position's currentPrice)
    const riskTokenPrice = status.uniswap.length > 0 ? status.uniswap[0].currentPrice : 0;

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

    console.log(`\n[Uniswap Positions] (${status.uniswap.length} active)`);
    let totalFees0 = 0n;
    let totalFees1 = 0n;
    let totalLpValueUsd = 0n;

    for (const pos of status.uniswap) {
      // Calculate token amounts from liquidity
      const sqrtPriceAX96 = getSqrtRatioAtTick(pos.tickLower);
      const sqrtPriceBX96 = getSqrtRatioAtTick(pos.tickUpper);
      const { amount0, amount1 } = getAmountsForLiquidity(
        pos.sqrtPriceX96,
        sqrtPriceAX96,
        sqrtPriceBX96,
        pos.liquidity
      );

      // Calculate USD value of this position
      let positionValueUsd = 0n;
      if (isToken0Collateral) {
        // Token0 is stable (USDC), Token1 is risk (ETH)
        // Stable token is $1, risk token is at riskTokenPrice
        const stableValue = calculateUsdValue(amount0, Number(decimals0), 1.0);
        const riskValue = calculateUsdValue(amount1, Number(decimals1), riskTokenPrice);
        positionValueUsd = stableValue + riskValue;
      } else {
        // Token0 is risk (ETH), Token1 is stable (USDC)
        // Risk token is at riskTokenPrice, stable token is $1
        const riskValue = calculateUsdValue(amount0, Number(decimals0), riskTokenPrice);
        const stableValue = calculateUsdValue(amount1, Number(decimals1), 1.0);
        positionValueUsd = riskValue + stableValue;
      }
      totalLpValueUsd += positionValueUsd;

      console.log(`  > Token ID: ${pos.tokenId}`);
      console.log(
        `    Price Range: [${pos.priceLower.toFixed(6)}, ${pos.priceUpper.toFixed(6)}] ${pos.priceLabel} (Current: ${pos.currentPrice.toFixed(6)})`
      );
      console.log(`    Zone: ${pos.delta.zone}`);
      console.log(`    Delta: ${ethers.formatEther(pos.delta.delta)} ETH`);
      console.log(
        `    Token Amounts: ${ethers.formatUnits(amount0, Number(decimals0))} ${symbol0}, ${ethers.formatUnits(amount1, Number(decimals1))} ${symbol1}`
      );
      console.log(`    Position Value: $${ethers.formatUnits(positionValueUsd, 30)}`);
      console.log(
        `    Fees: ${ethers.formatEther(pos.unclaimedFees.amount0)} ETH, ${ethers.formatUnits(pos.unclaimedFees.amount1, 6)} USDC`
      );
      totalFees0 += pos.unclaimedFees.amount0;
      totalFees1 += pos.unclaimedFees.amount1;
    }

    console.log("\n[Uniswap Aggregated]");
    console.log(`  Total LP Delta: ${ethers.formatEther(status.totalLpDelta)} ETH`);
    console.log(`  Total LP Value: $${ethers.formatUnits(totalLpValueUsd, 30)}`);
    console.log(
      `  Total Unclaimed Fees: ${ethers.formatEther(totalFees0)} ETH, ${ethers.formatUnits(totalFees1, 6)} USDC`
    );

    console.log("\n[GMX Position]");
    console.log(`  Hedge Size: ${ethers.formatEther(status.gmx.positionSizeTokens)} ETH (Short)`);
    console.log(`  Hedge Delta: ${ethers.formatEther(status.gmx.delta)} ETH`);
    console.log(`  Collateral: ${ethers.formatUnits(status.gmx.collateralAmount, 6)} USDC`);
    console.log(`  Net Value: $${ethers.formatUnits(status.gmx.netValueUsd, 30)}`);

    console.log("\n[Net Strategy]");
    console.log(`  Net Delta: ${ethers.formatEther(status.netDelta)} ETH`);
    console.log(
      `  Delta Drift: ${(status.deltaDrift * 100).toFixed(2)}% (${status.netDelta > 0n ? "under" : "over"}-hedged)`
    );

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

    const totalFees0Usd = isToken0Collateral
      ? calculateUsdValue(totalFees0, Number(decimals0), 1.0)
      : calculateUsdValue(totalFees0, Number(decimals0), riskTokenPrice);
    const totalFees1Usd = isToken0Collateral
      ? calculateUsdValue(totalFees1, Number(decimals1), riskTokenPrice)
      : calculateUsdValue(totalFees1, Number(decimals1), 1.0);

    // Calculate and display total net value
    const totalNetValueUsd = totalLpValueUsd + status.gmx.netValueUsd;
    const totalPortfolioValueUsd =
      totalNetValueUsd + totalFees0Usd + totalFees1Usd + walletWethUsd + walletUsdcUsd;

    console.log(`\n[Total Portfolio Value]`);
    console.log(`  LP Positions:     $${ethers.formatUnits(totalLpValueUsd, 30)}`);
    console.log(`  GMX Position:     $${ethers.formatUnits(status.gmx.netValueUsd, 30)}`);
    console.log(`  Unclaimed Fees:   $${ethers.formatUnits(totalFees0Usd + totalFees1Usd, 30)}`);
    console.log(`  Wallet (Dry):     $${ethers.formatUnits(walletWethUsd + walletUsdcUsd, 30)}`);
    console.log(`  -----------------------------------------`);
    console.log(`  Total Portfolio:  $${ethers.formatUnits(totalPortfolioValueUsd, 30)}`);
    console.log(`\n[Other Balances]`);
    console.log(
      `  Wallet ETH (Gas): $${ethers.formatUnits(walletEthUsd, 30)} (${ethers.formatEther(nativeEthBalance)} ETH)`
    );
    console.log(`  Wallet ${symbol0}: ${ethers.formatUnits(balance0, Number(decimals0))}`);
    console.log(`  Wallet ${symbol1}: ${ethers.formatUnits(balance1, Number(decimals1))}`);

    console.log("\n[Recommendation]");
    const color = recommendation.action === StrategyAction.NONE ? "\x1b[32m" : "\x1b[33m"; // Green for NONE, Yellow for others
    console.log(`  Action: ${color}${recommendation.action}\x1b[0m`);
    console.log(`  Reason: ${recommendation.reason}`);

    // Send alerts for critical conditions
    if (recommendation.action === StrategyAction.OPTIMIZE) {
      const isEmergency = status.deltaDrift >= config.emergencyDeltaThreshold;
      const isOutOfRange = recommendation.data?.anyOutOfRange || false;

      if (isEmergency) {
        // Emergency alert for high delta drift
        await sendErrorAlert(
          "🚨 Emergency: High Delta Drift Detected",
          `Delta drift has exceeded the emergency threshold. Immediate optimization required.`,
          [
            {
              name: "Delta Drift",
              value: `${(status.deltaDrift * 100).toFixed(2)}% (${status.netDelta > 0n ? "under" : "over"}-hedged)`,
              inline: true,
            },
            {
              name: "Emergency Threshold",
              value: `${(config.emergencyDeltaThreshold * 100).toFixed(2)}%`,
              inline: true,
            },
            {
              name: "Net Delta",
              value: `${ethers.formatEther(status.netDelta)} ETH`,
              inline: true,
            },
            {
              name: "Account",
              value: account,
              inline: false,
            },
            {
              name: "Reason",
              value: recommendation.reason,
              inline: false,
            },
          ]
        );
      } else if (isOutOfRange) {
        // Warning alert for positions out of range
        await sendWarningAlert(
          "⚠️ Position Out of Range",
          `One or more LP positions are out of range. Optimization recommended.`,
          [
            {
              name: "Delta Drift",
              value: `${(status.deltaDrift * 100).toFixed(2)}% (${status.netDelta > 0n ? "under" : "over"}-hedged)`,
              inline: true,
            },
            {
              name: "Net Delta",
              value: `${ethers.formatEther(status.netDelta)} ETH`,
              inline: true,
            },
            {
              name: "Account",
              value: account,
              inline: false,
            },
            {
              name: "Reason",
              value: recommendation.reason,
              inline: false,
            },
          ]
        );
      }
    }

    if (recommendation.data) {
      if (recommendation.action === StrategyAction.OPTIMIZE) {
        console.log(`  Data:`);
        console.log(`    Delta Drift: ${(recommendation.data.deltaDrift * 100).toFixed(2)}%`);
        console.log(`    Out of Range: ${recommendation.data.anyOutOfRange ? "Yes" : "No"}`);
        if (recommendation.data.totalFeesUsd !== undefined) {
          console.log(
            `    Unclaimed Fees: $${ethers.formatUnits(recommendation.data.totalFeesUsd, 30)}`
          );
        }
        if (recommendation.data.timeSinceLastOptimization !== undefined) {
          const hoursSince = (recommendation.data.timeSinceLastOptimization / 3600).toFixed(1);
          console.log(`    Time Since Last: ${hoursSince}h`);
        }
        if (recommendation.data.estimatedGasCostUsd !== undefined) {
          console.log(
            `    Est. Gas Cost: $${ethers.formatUnits(recommendation.data.estimatedGasCostUsd, 30)}`
          );
        }
        if (recommendation.data.estimatedBenefitUsd !== undefined) {
          console.log(
            `    Est. Benefit: $${ethers.formatUnits(recommendation.data.estimatedBenefitUsd, 30)}`
          );
          if (
            recommendation.data.estimatedGasCostUsd !== undefined &&
            recommendation.data.estimatedGasCostUsd > 0n
          ) {
            const ratio =
              Number(recommendation.data.estimatedBenefitUsd) /
              Number(recommendation.data.estimatedGasCostUsd);
            console.log(`    Benefit/Cost Ratio: ${ratio.toFixed(2)}x`);
          }
        }
      } else {
        console.log(
          `  Data:`,
          JSON.stringify(
            recommendation.data,
            (key, value) => (typeof value === "bigint" ? value.toString() : value),
            2
          )
        );
      }
    }
  } catch (error: any) {
    console.error("\nError during monitor check:");
    console.error(error);

    // Send error alert to Discord
    await sendErrorAlert(
      "❌ Monitor Check Failed",
      `An error occurred while monitoring the strategy position.`,
      error
    ).catch((alertError) => {
      // Don't fail the monitor command if alert fails
      console.warn("Failed to send Discord alert:", alertError);
    });

    throw error;
  } finally {
    runtimeDb.close();
  }
}
