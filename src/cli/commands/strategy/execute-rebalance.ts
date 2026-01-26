import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { DeltaNeutralMonitor } from "../../../strategy/monitor";
import { RebalanceManager } from "../../../strategy/rebalance";
import { StrategyAction, RebalanceData } from "../../../strategy/types";
import { loadStrategyConfig } from "../../../config/strategy";
import { createRouter } from "../../../modules/gmx/orders";
import {
  fetchTokenPrices,
  findTokenPrice,
  averagePrice,
  scalePriceTo30,
} from "../../../modules/gmx/prices";
import { getSignerAndAccount } from "../base";
import { ERC20_ABI } from "../../../utils/abis";

export interface ExecuteRebalanceOptions {
  account?: string;
  tokenId?: string;
  execute?: boolean;
}

export async function executeRebalance(options: ExecuteRebalanceOptions = {}): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);
  console.log("Executing account:", account);

  // 1. Check Strategy Status
  const tokenIds = options.tokenId ? [BigInt(options.tokenId)] : undefined;

  const monitorConfig = loadStrategyConfig({
    minOptimizationFeeThresholdUsd: ethers.parseUnits("10", 30),
  });

  const monitorContext = {
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
  };

  const monitor = new DeltaNeutralMonitor(ethers.provider, monitorConfig, monitorContext);

  console.log("Checking position status...");
  const { status, recommendation } = await monitor.check();

  // Note: execute-rebalance is deprecated in favor of execute-optimize
  // This command now checks for OPTIMIZE recommendation and calculates rebalance data from status
  if (recommendation.action !== StrategyAction.OPTIMIZE) {
    console.log(`No optimization needed. Status: ${recommendation.action}`);
    console.log(`Reason: ${recommendation.reason}`);
    return;
  }

  console.log("OPTIMIZATION RECOMMENDED (rebalancing hedge)");
  console.log(`Reason: ${recommendation.reason}`);

  // Calculate adjustment needed from status
  const targetDelta = status.totalLpDelta;
  const currentHedge = -status.gmx.delta;
  const adjustmentNeeded = status.netDelta;

  // Calculate USD values (simplified - would need price for accurate calculation)
  // For now, use a placeholder or calculate from status
  const adjustmentNeededUsd = 0n; // Would need to calculate properly with price
  console.log(`Net Delta: ${ethers.formatEther(adjustmentNeeded)} ETH`);
  console.log(`Target Delta: ${ethers.formatEther(targetDelta)} ETH`);
  console.log(`Current Hedge: ${ethers.formatEther(currentHedge)} ETH`);

  if (adjustmentNeeded === 0n) {
    console.log("No adjustment needed - delta is neutral");
    return;
  }

  // 2. Prepare for Execution
  const router = createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer);
  const collateralToken = new ethers.Contract(ARBITRUM_MAINNET.usdc, ERC20_ABI, signer) as any;

  const rebalanceConfig = loadStrategyConfig({
    defaultExecutionFee: ethers.parseEther("0.001"),
  });

  const rebalanceContext = {
    account: account,
    market: ARBITRUM_MAINNET.gmxEthUsdMarket,
    collateralTokenAddress: ARBITRUM_MAINNET.usdc,
    orderVault: ARBITRUM_MAINNET.gmxOrderVault,
  };

  const manager = new RebalanceManager(router, collateralToken, rebalanceConfig, rebalanceContext);

  // 3. Fetch Prices
  console.log("Fetching GMX prices...");
  const prices = await fetchTokenPrices(ARBITRUM_MAINNET.gmxPriceApi);

  const usdcPriceData = findTokenPrice(prices, ARBITRUM_MAINNET.usdc);
  const wethPriceData = findTokenPrice(prices, ARBITRUM_MAINNET.weth);

  const usdcPriceRaw = averagePrice(usdcPriceData);
  const usdcPrice30 = scalePriceTo30(usdcPriceRaw, 6);
  const usdcPriceNum = parseFloat(ethers.formatUnits(usdcPrice30, 30));

  const wethPriceRaw = averagePrice(wethPriceData);
  const wethPrice30 = scalePriceTo30(wethPriceRaw, 18);

  console.log(`Prices: USDC=$${usdcPriceNum}, ETH=$${ethers.formatUnits(wethPrice30, 30)}`);

  // 4. Execute
  const executeFlag = options.execute ?? false;

  if (!executeFlag) {
    console.log("\n[DRY RUN] Rebalance would be executed with:");

    console.log(`  Adjustment: ${ethers.formatUnits(adjustmentNeededUsd, 30)} USD`);

    console.log(`  Collateral Price: ${usdcPriceNum}`);

    console.log(`  Index Price: ${ethers.formatUnits(wethPrice30, 30)} USD`);

    console.log(`  Target Leverage: ${rebalanceConfig.targetLeverage}`);
    console.log(`  Execution Fee: ${ethers.formatEther(rebalanceConfig.defaultExecutionFee)} ETH`);

    if (adjustmentNeededUsd > 0n) {
      const { amount: collateralTokens, usd: collateralUsd } = manager.calculateRequiredCollateral(
        adjustmentNeededUsd,
        usdcPriceNum,
        6 // USDC decimals
      );

      console.log(
        `  Estimated Required Collateral: ${ethers.formatUnits(collateralTokens, 6)} USDC (${ethers.formatUnits(collateralUsd, 30)})`
      );
    }

    console.log("\nTo execute, run with --execute flag");

    return;
  }

  // Create RebalanceData from status
  const rebalanceData = {
    targetDelta,
    currentHedge,
    adjustmentNeeded,
    targetSizeUsd: 0n, // Would need price to calculate
    adjustmentNeededUsd: 0n, // Would need price to calculate
  };

  console.log("\nExecuting rebalance...");
  try {
    const txHash = await manager.executeRebalance(
      rebalanceData,
      usdcPriceNum,
      6, // USDC decimals
      wethPrice30
    );

    if (txHash) {
      console.log(`Rebalance order submitted! Tx: ${txHash}`);
    } else {
      console.log("Rebalance executed (no tx needed or handled differently).");
    }
  } catch (error) {
    console.error("Rebalance failed:", error);
    throw error;
  }
}
