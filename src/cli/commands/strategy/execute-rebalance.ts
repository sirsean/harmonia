import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { DeltaNeutralMonitor } from "../../../strategy/monitor";
import { RebalanceManager } from "../../../strategy/rebalance";
import { StrategyAction } from "../../../strategy/types";
import { loadStrategyConfig } from "../../../config/strategy";
import { createRouter } from "../../../modules/gmx/orders";
import {
  fetchTokenPrices,
  findTokenPrice,
  averagePrice,
  scalePriceTo30,
} from "../../../modules/gmx/prices";
import { getSignerAndAccount } from "../base";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

export interface ExecuteRebalanceOptions {
  account?: string;
  tokenId?: string;
  dryRun?: boolean;
}

export async function executeRebalance(options: ExecuteRebalanceOptions = {}): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);
  console.log("Executing account:", account);

  // 1. Check Strategy Status
  const tokenIds = options.tokenId ? [BigInt(options.tokenId)] : undefined;

  const monitorConfig = loadStrategyConfig({
    minFeeThresholdUsd: ethers.parseUnits("10", 30),
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

  if (recommendation.action !== StrategyAction.REBALANCE) {
    console.log(`No rebalance needed. Status: ${recommendation.action}`);
    return;
  }

  console.log("REBALANCE RECOMMENDED");
  console.log(`Reason: ${recommendation.reason}`);

  if (!recommendation.data) {
    console.error("No rebalance data available.");
    return;
  }

  const { adjustmentNeededUsd } = recommendation.data;
  console.log(`Adjustment Needed USD: $${ethers.formatUnits(adjustmentNeededUsd, 30)}`);

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
  const executeFlag = !options.dryRun;

  if (!executeFlag) {
    console.log("\n[Dry Run] Rebalance would be executed with:");

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

    console.log("\nTo execute, run without --dry-run flag");

    return;
  }

  console.log("\nExecuting rebalance...");
  try {
    const txHash = await manager.executeRebalance(
      recommendation.data,
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
