import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";
import { DeltaNeutralMonitor } from "../src/strategy/monitor";
import { MonitorConfig, StrategyAction } from "../src/strategy/types";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Monitoring account:", signer.address);

  // Configuration from environment or defaults
  const tokenId = process.env.UNISWAP_TOKEN_ID;
  if (!tokenId) {
    console.warn("WARNING: UNISWAP_TOKEN_ID not set in environment. This script will likely fail unless you provide a valid NFT ID.");
    // We could either exit or use a placeholder for demonstration
    // return;
  }

  const config: MonitorConfig = {
    deltaThreshold: 0.05, // 5% drift allowed
    minFeeThreshold: ethers.parseUnits("10", 6), // $10 worth of USDC (simplified)
    minRebalanceInterval: 3600,
  };

  const context = {
    uniswap: {
      positionManager: ARBITRUM_MAINNET.uniswapV3PositionManager,
      pool: ARBITRUM_MAINNET.uniswapV3EthUsdcPool,
      tokenId: BigInt(tokenId || "0"),
    },
    gmx: {
      reader: ARBITRUM_MAINNET.gmxReader,
      dataStore: ARBITRUM_MAINNET.gmxDataStore,
      account: signer.address,
      market: ARBITRUM_MAINNET.gmxEthUsdMarket,
      collateralToken: ARBITRUM_MAINNET.usdc,
    },
  };

  const monitor = new DeltaNeutralMonitor(ethers.provider, config, context);

  console.log("--- Strategy Check ---");
  try {
    const { status, recommendation } = await monitor.check();

    console.log("\n[Uniswap Position]");
    console.log(`  Token ID: ${status.uniswap.tokenId}`);
    console.log(`  Tick Range: [${status.uniswap.tickLower}, ${status.uniswap.tickUpper}]`);
    console.log(`  Current Tick: ${status.uniswap.currentTick}`);
    console.log(`  Zone: ${status.uniswap.delta.zone}`);
    console.log(`  LP Delta: ${ethers.formatEther(status.uniswap.delta.delta)} ETH`);
    console.log(`  Unclaimed Fees: ${ethers.formatUnits(status.uniswap.unclaimedFees.amount0, 6)} USDC, ${ethers.formatEther(status.uniswap.unclaimedFees.amount1)} ETH`);

    console.log("\n[GMX Position]");
    console.log(`  Hedge Size: ${ethers.formatEther(status.gmx.positionSizeTokens)} ETH (Short)`);
    console.log(`  Hedge Delta: ${ethers.formatEther(status.gmx.delta)} ETH`);
    
    console.log("\n[Net Strategy]");
    console.log(`  Net Delta: ${ethers.formatEther(status.netDelta)} ETH`);
    console.log(`  Delta Drift: ${(status.deltaDrift * 100).toFixed(2)}%`);

    console.log("\n[Recommendation]");
    const color = recommendation.action === StrategyAction.NONE ? "\x1b[32m" : "\x1b[33m"; // Green for NONE, Yellow for others
    console.log(`  Action: ${color}${recommendation.action}\x1b[0m`);
    console.log(`  Reason: ${recommendation.reason}`);
    if (recommendation.data) {
      console.log(`  Data:`, JSON.stringify(recommendation.data, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    }

  } catch (error: any) {
    console.error("\nError during monitor check:");
    if (error.message.includes("NONEXISTENT_TOKEN")) {
      console.error(`  Uniswap Token ID ${tokenId} does not exist. Please check your UNISWAP_TOKEN_ID.`);
    } else {
      console.error(error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
