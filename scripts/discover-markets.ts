/**
 * Market Discovery Script
 *
 * Discovers potential markets for delta-neutral vaults by searching for
 * compatible Uniswap pools, GMX markets, and Chainlink feeds.
 *
 * Usage:
 *   npx hardhat run scripts/discover-markets.ts              # Scan all tokens
 *   TOKEN=LINK npx hardhat run scripts/discover-markets.ts   # Discover for specific token
 */

import { ethers } from "hardhat";
import { MarketDiscovery, printDiscoveryResult } from "../src/markets/discovery";
import { ARBITRUM_TOKENS } from "../src/markets/registry";
import { TokenConfig } from "../src/markets/types";

async function main() {
  const tokenSymbol = process.env.TOKEN;

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║           HARMONIA MARKET DISCOVERY TOOL                   ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  const provider = ethers.provider;
  const discovery = new MarketDiscovery(provider);

  if (tokenSymbol) {
    // Discover specific token
    await discoverSingleToken(discovery, tokenSymbol);
  } else {
    // Scan all tokens
    await discovery.scanAllMarkets();
  }
}

async function discoverSingleToken(
  discovery: MarketDiscovery,
  tokenSymbol: string
) {
  // Check if token is in our registry
  let token: TokenConfig | undefined =
    ARBITRUM_TOKENS[tokenSymbol.toUpperCase()];

  if (!token) {
    // Allow custom token address
    if (tokenSymbol.startsWith("0x")) {
      console.log(`\nUsing custom token address: ${tokenSymbol}`);
      // Try to get token info
      const tokenContract = new ethers.Contract(
        tokenSymbol,
        ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
        ethers.provider
      );

      try {
        const [symbol, decimals] = await Promise.all([
          tokenContract.symbol(),
          tokenContract.decimals(),
        ]);

        token = {
          symbol,
          address: tokenSymbol,
          decimals: Number(decimals),
        };

        console.log(`Token: ${symbol} (${decimals} decimals)`);
      } catch (error) {
        console.error(`Failed to get token info: ${(error as Error).message}`);
        process.exit(1);
      }
    } else {
      console.error(`\nError: Unknown token "${tokenSymbol}"`);
      console.log(`\nKnown tokens: ${Object.keys(ARBITRUM_TOKENS).join(", ")}`);
      console.log(`\nOr provide a token address starting with 0x`);
      process.exit(1);
    }
  }

  console.log(`\nDiscovering market components for ${token.symbol}...`);

  const result = await discovery.discoverMarket(token);
  printDiscoveryResult(result);

  // If viable, print the recommended config
  if (result.recommendedConfig) {
    console.log("\n" + "═".repeat(60));
    console.log("RECOMMENDED CONFIGURATION");
    console.log("═".repeat(60));
    console.log("\nAdd this to your registry.ts:\n");
    console.log(generateConfigCode(result.recommendedConfig));
  }
}

function generateConfigCode(config: any): string {
  return `export const ${config.id}_MARKET: MarketConfig = {
  id: "${config.id}",
  name: "${config.name}",
  description: "${config.description}",
  chainId: ${config.chainId},

  baseToken: ARBITRUM_TOKENS.${config.baseToken.symbol},
  quoteToken: ARBITRUM_TOKENS.${config.quoteToken.symbol},

  uniswapPool: {
    address: "${config.uniswapPool.address}",
    feeTier: ${config.uniswapPool.feeTier},
    tickSpacing: ${config.uniswapPool.tickSpacing},
    token0: ARBITRUM_TOKENS.${config.uniswapPool.token0.symbol},
    token1: ARBITRUM_TOKENS.${config.uniswapPool.token1.symbol},
  },

  gmxMarket: {
    marketAddress: "${config.gmxMarket.marketAddress}",
    indexToken: "${config.gmxMarket.indexToken}",
    longToken: "${config.gmxMarket.longToken}",
    shortToken: "${config.gmxMarket.shortToken}",
    name: "${config.gmxMarket.name}",
  },

  chainlinkFeed: {
    address: "${config.chainlinkFeed.address}",
    description: "${config.chainlinkFeed.description}",
    decimals: ${config.chainlinkFeed.decimals},
    heartbeat: ${config.chainlinkFeed.heartbeat},
  },

  baseTokenIsToken0: ${config.baseTokenIsToken0},

  decimalAdjustment: calculateDecimalAdjustment(
    ARBITRUM_TOKENS.${config.baseToken.symbol}.decimals,
    ARBITRUM_TOKENS.${config.quoteToken.symbol}.decimals
  ),

  strategyParams: {
    defaultRangeWidth: 0.15,    // Adjust based on volatility
    rebalanceThreshold: 0.05,
    minLpRatio: 0.8,
    maxHedgeLeverage: 3,
  },

  characteristics: {
    expectedFeeApy: [5, 25],    // Adjust based on historical data
    volatilityLevel: "medium",  // Analyze historical volatility
    liquidityRating: "medium",  // Based on pool liquidity
    riskLevel: "moderate",
  },
};`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
