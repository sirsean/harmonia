import { ethers } from "hardhat";
import { ARBITRUM_MAINNET, STRATEGY_PARAMS } from "./config/addresses";
import { DeltaNeutralMonitor } from "../src/strategy/monitor";
import { RebalanceManager, RebalanceConfig } from "../src/strategy/rebalance";
import { StrategyAction } from "../src/strategy/types";
import { createRouter } from "../src/modules/gmx/orders";
import {
  fetchTokenPrices,
  findTokenPrice,
  averagePrice,
  scalePriceTo30,
} from "../src/modules/gmx/prices";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Executing account:", signer.address);

  // 1. Check Strategy Status
  const tokenIdEnv = process.env.UNISWAP_TOKEN_ID;
  const tokenIds = tokenIdEnv ? [BigInt(tokenIdEnv)] : undefined;

  const monitorConfig = {
    deltaThreshold: 0.05,
    minFeeThresholdUsd: ethers.parseUnits("10", 30),
    minRebalanceInterval: 3600,
  };

  const monitorContext = {
    uniswap: {
      positionManager: ARBITRUM_MAINNET.uniswapV3PositionManager,
      pool: ARBITRUM_MAINNET.uniswapV3EthUsdcPool,
      tokenIds: tokenIds,
    },
    gmx: {
      reader: ARBITRUM_MAINNET.gmxReader,
      dataStore: ARBITRUM_MAINNET.gmxDataStore,
      account: signer.address,
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

  const rebalanceConfig: RebalanceConfig = {
    targetLeverage: 3.0, // Configurable?
    slippageBuffer: 0.005, // 0.5%
    executionFee: STRATEGY_PARAMS.MAX_SLIPPAGE, // reusing value or defining new one?
    // executionFee: ethers.parseEther("0.0001")?
    // GMX execution fee is dynamic but usually around 0.0002-0.001 ETH.
    // Let's use a safe default or fetch it.
  };

  // Hardcode execution fee for now or use a safe buffer
  rebalanceConfig.executionFee = ethers.parseEther("0.001");

  const rebalanceContext = {
    account: signer.address,
    market: ARBITRUM_MAINNET.gmxEthUsdMarket,
    collateralTokenAddress: ARBITRUM_MAINNET.usdc,
    orderVault: ARBITRUM_MAINNET.gmxOrderVault,
  };

  const manager = new RebalanceManager(router, collateralToken, rebalanceConfig, rebalanceContext);

  // 3. Fetch Prices
  console.log("Fetching GMX prices...");
  const prices = await fetchTokenPrices(ARBITRUM_MAINNET.gmxPriceApi);

  // We need Collateral Price (USDC) and Index Token Price (WETH)
  // GMX V2 Market: ETH-USD [WETH, USDC] (Long, Short/Collateral)
  // Our collateral is USDC.
  const usdcPriceData = findTokenPrice(prices, ARBITRUM_MAINNET.usdc);
  const wethPriceData = findTokenPrice(prices, ARBITRUM_MAINNET.weth);

  const usdcPrice = Number(averagePrice(usdcPriceData)) / 1e12; // API usually 12-30 decimals?
  // Checking prices.ts: normalizeTokenPrice parses minPrice/maxPrice as BigInt.
  // GMX tickers API returns prices with 30 decimals usually.
  // Wait, price30ToPrice12 exists.
  // Let's verify API return format. Standard GMX v2 API returns 30 decimals.
  // So averagePrice returns 30 decimals BigInt.
  // manager.executeRebalance expects collateralPrice as NUMBER (approx USD per token).
  // If USDC price is 1e30, that's $1.

  // RebalanceManager.executeRebalance(data, collateralPrice: number, collateralDecimals: number, indexTokenPrice: bigint)
  // collateralPrice is used for:
  // const priceScaled = BigInt(Math.floor(collateralPrice * 1e8));
  // It expects a number like 1.0 or 0.999.
  // So we need to convert the BigInt price (30 decimals) to a number.

  const usdcPriceRaw = averagePrice(usdcPriceData);
  const usdcPrice30 = scalePriceTo30(usdcPriceRaw, 6); // USDC decimals
  const usdcPriceNum = parseFloat(ethers.formatUnits(usdcPrice30, 30));

  const wethPriceRaw = averagePrice(wethPriceData);
  const wethPrice30 = scalePriceTo30(wethPriceRaw, 18); // WETH decimals

  console.log(`Prices: USDC=$${usdcPriceNum}, ETH=$${ethers.formatUnits(wethPrice30, 30)}`);

  // 4. Execute

  // Check for EXECUTE env var

  const executeFlag = process.env.EXECUTE === "true";

  if (!executeFlag) {
    console.log("\n[Dry Run] Rebalance would be executed with:");

    console.log(`  Adjustment: ${ethers.formatUnits(adjustmentNeededUsd, 30)} USD`);

    console.log(`  Collateral Price: ${usdcPriceNum}`);

    console.log(`  Index Price: ${ethers.formatUnits(wethPrice30, 30)} USD`);

    console.log(`  Target Leverage: ${rebalanceConfig.targetLeverage}`);

    if (adjustmentNeededUsd > 0n) {
      // Calculate estimated collateral for Increase Short

      const { amount: collateralTokens, usd: collateralUsd } = manager.calculateRequiredCollateral(
        adjustmentNeededUsd,

        usdcPriceNum,

        6 // USDC decimals
      );

      console.log(
        `  Estimated Required Collateral: ${ethers.formatUnits(collateralTokens, 6)} USDC (${ethers.formatUnits(collateralUsd, 30)})`
      );
    }

    console.log("\nTo execute, run with EXECUTE=true");

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
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
