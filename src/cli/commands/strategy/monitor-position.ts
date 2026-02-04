import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { DeltaNeutralMonitor } from "../../../strategy/monitor";
import { loadStrategyConfig } from "../../../config/strategy";
import { getSignerAndAccount } from "../base";

export interface MonitorPositionOptions {
  account?: string;
  tokenId?: string;
}

export async function monitorPosition(options: MonitorPositionOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);

  const tokenIds = options.tokenId ? [BigInt(options.tokenId)] : undefined;

  const config = loadStrategyConfig({
    minOptimizationFeeThresholdUsd: ethers.parseUnits("10", 30),
  });

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

  const monitor = new DeltaNeutralMonitor(ethers.provider, config, context);

  console.log("--- Strategy Check ---");
  const { status, recommendation } = await monitor.check();

  console.log("Status:", status);
  console.log("Recommendation:", recommendation.action);
  if (recommendation.reason) {
    console.log("Reason:", recommendation.reason);
  }
}
