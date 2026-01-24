import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";
import { DeltaNeutralMonitor } from "../src/strategy/monitor";
import { StrategyAction } from "../src/strategy/types";
import { loadStrategyConfig } from "../src/config/strategy";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Monitoring account:", signer.address);

  // Configuration from environment or defaults
  const tokenIdEnv = process.env.UNISWAP_TOKEN_ID;
  const tokenIds = tokenIdEnv ? [BigInt(tokenIdEnv)] : undefined;

  const config = loadStrategyConfig({
    minFeeThresholdUsd: ethers.parseUnits("10", 30), // $10 worth of fees (USD 30 decimals)
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
      account: signer.address,
      market: ARBITRUM_MAINNET.gmxEthUsdMarket,
      collateralToken: ARBITRUM_MAINNET.usdc,
    },
  };

  const monitor = new DeltaNeutralMonitor(ethers.provider, config, context);

  console.log("--- Strategy Check ---");
  try {
    const { status, recommendation } = await monitor.check();

    console.log(`\n[Uniswap Positions] (${status.uniswap.length} active)`);
    let totalFees0 = 0n;
    let totalFees1 = 0n;

    for (const pos of status.uniswap) {
      console.log(`  > Token ID: ${pos.tokenId}`);
      console.log(
        `    Price Range: [${pos.priceLower.toFixed(6)}, ${pos.priceUpper.toFixed(6)}] ${pos.priceLabel} (Current: ${pos.currentPrice.toFixed(6)})`
      );
      console.log(`    Zone: ${pos.delta.zone}`);
      console.log(`    Delta: ${ethers.formatEther(pos.delta.delta)} ETH`);
      console.log(
        `    Fees: ${ethers.formatEther(pos.unclaimedFees.amount0)} ETH, ${ethers.formatUnits(pos.unclaimedFees.amount1, 6)} USDC`
      );
      totalFees0 += pos.unclaimedFees.amount0;
      totalFees1 += pos.unclaimedFees.amount1;
    }

    console.log("\n[Uniswap Aggregated]");
    console.log(`  Total LP Delta: ${ethers.formatEther(status.totalLpDelta)} ETH`);
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
    console.log(`  Delta Drift: ${(status.deltaDrift * 100).toFixed(2)}%`);

    console.log("\n[Recommendation]");
    const color = recommendation.action === StrategyAction.NONE ? "\x1b[32m" : "\x1b[33m"; // Green for NONE, Yellow for others
    console.log(`  Action: ${color}${recommendation.action}\x1b[0m`);
    console.log(`  Reason: ${recommendation.reason}`);

    if (recommendation.data) {
      if (recommendation.action === StrategyAction.REBALANCE) {
        console.log(`  Data:`);
        console.log(`    Target Delta: ${ethers.formatEther(recommendation.data.targetDelta)} ETH`);
        console.log(
          `    Current Hedge: ${ethers.formatEther(recommendation.data.currentHedge)} ETH`
        );
        console.log(
          `    Adjustment Needed: ${ethers.formatEther(recommendation.data.adjustmentNeeded)} ETH`
        );
        if (recommendation.data.targetSizeUsd !== undefined) {
          console.log(
            `    Target Size USD: $${ethers.formatUnits(recommendation.data.targetSizeUsd, 30)}`
          );
          console.log(
            `    Adjustment Needed USD: $${ethers.formatUnits(recommendation.data.adjustmentNeededUsd, 30)}`
          );
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
