/**
 * Custom Market Evaluation Script
 *
 * Evaluates a market configuration using custom contract addresses.
 * Use this to verify that a set of addresses would work for a vault deployment.
 *
 * Usage:
 *   npx hardhat run scripts/evaluate-custom-market.ts
 *
 * Environment variables:
 *   BASE_TOKEN     - Base token address (e.g., WETH)
 *   QUOTE_TOKEN    - Quote token address (e.g., USDC)
 *   UNISWAP_POOL   - Uniswap V3 pool address
 *   GMX_MARKET     - GMX V2 market address
 *   CHAINLINK_FEED - Chainlink price feed address
 */

import { ethers } from "hardhat";
import { MarketConfig, TokenConfig, isBaseTokenToken0, calculateDecimalAdjustment } from "../src/markets/types";
import { MarketValidator, printValidationSummary } from "../src/markets/validator";
import { ARBITRUM_TOKENS, TICK_SPACING } from "../src/markets/registry";

// ABI fragments for reading token/pool info
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const UNISWAP_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

const CHAINLINK_ABI = [
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
];

const GMX_READER_ABI = [
  "function getMarket(address dataStore, address market) view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken))",
];

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║        HARMONIA CUSTOM MARKET EVALUATION TOOL              ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  // Get addresses from environment or use defaults
  const baseTokenAddr = process.env.BASE_TOKEN || ARBITRUM_TOKENS.WETH.address;
  const quoteTokenAddr = process.env.QUOTE_TOKEN || ARBITRUM_TOKENS.USDC.address;
  const uniswapPoolAddr = process.env.UNISWAP_POOL;
  const gmxMarketAddr = process.env.GMX_MARKET;
  const chainlinkFeedAddr = process.env.CHAINLINK_FEED;

  // Check required addresses
  if (!uniswapPoolAddr || !gmxMarketAddr || !chainlinkFeedAddr) {
    console.log("\nUsage: Provide addresses via environment variables\n");
    console.log("Required:");
    console.log("  UNISWAP_POOL   - Uniswap V3 pool address");
    console.log("  GMX_MARKET     - GMX V2 market address");
    console.log("  CHAINLINK_FEED - Chainlink price feed address");
    console.log("\nOptional:");
    console.log("  BASE_TOKEN     - Base token address (default: WETH)");
    console.log("  QUOTE_TOKEN    - Quote token address (default: USDC)");
    console.log("\nExample:");
    console.log("  UNISWAP_POOL=0x... GMX_MARKET=0x... CHAINLINK_FEED=0x... npx hardhat run scripts/evaluate-custom-market.ts");
    process.exit(1);
  }

  console.log("\nInput Addresses:");
  console.log(`  Base Token:     ${baseTokenAddr}`);
  console.log(`  Quote Token:    ${quoteTokenAddr}`);
  console.log(`  Uniswap Pool:   ${uniswapPoolAddr}`);
  console.log(`  GMX Market:     ${gmxMarketAddr}`);
  console.log(`  Chainlink Feed: ${chainlinkFeedAddr}`);

  // Build configuration from provided addresses
  const config = await buildConfigFromAddresses(
    baseTokenAddr,
    quoteTokenAddr,
    uniswapPoolAddr,
    gmxMarketAddr,
    chainlinkFeedAddr
  );

  if (!config) {
    console.error("\nFailed to build configuration from addresses");
    process.exit(1);
  }

  console.log(`\nBuilt configuration for: ${config.name}`);

  // Validate
  const provider = ethers.provider;
  const validator = new MarketValidator(provider);
  const result = await validator.validateMarket(config);

  // Print result
  printValidationSummary(result);

  // If valid, print constructor args
  if (result.isValid) {
    console.log("\n" + "═".repeat(60));
    console.log("CONSTRUCTOR ARGUMENTS FOR VAULT DEPLOYMENT");
    console.log("═".repeat(60));
    printConstructorArgs(config);
  }

  process.exit(result.isValid ? 0 : 1);
}

async function buildConfigFromAddresses(
  baseTokenAddr: string,
  quoteTokenAddr: string,
  uniswapPoolAddr: string,
  gmxMarketAddr: string,
  chainlinkFeedAddr: string
): Promise<MarketConfig | null> {
  const provider = ethers.provider;

  try {
    // Get token info
    const baseTokenContract = new ethers.Contract(baseTokenAddr, ERC20_ABI, provider);
    const quoteTokenContract = new ethers.Contract(quoteTokenAddr, ERC20_ABI, provider);

    const [baseSymbol, baseDecimals, quoteSymbol, quoteDecimals] = await Promise.all([
      baseTokenContract.symbol(),
      baseTokenContract.decimals(),
      quoteTokenContract.symbol(),
      quoteTokenContract.decimals(),
    ]);

    const baseToken: TokenConfig = {
      symbol: baseSymbol,
      address: baseTokenAddr,
      decimals: Number(baseDecimals),
    };

    const quoteToken: TokenConfig = {
      symbol: quoteSymbol,
      address: quoteTokenAddr,
      decimals: Number(quoteDecimals),
    };

    console.log(`\nDetected tokens:`);
    console.log(`  Base: ${baseSymbol} (${baseDecimals} decimals)`);
    console.log(`  Quote: ${quoteSymbol} (${quoteDecimals} decimals)`);

    // Get pool info
    const poolContract = new ethers.Contract(uniswapPoolAddr, UNISWAP_POOL_ABI, provider);
    const [token0, token1, fee] = await Promise.all([
      poolContract.token0(),
      poolContract.token1(),
      poolContract.fee(),
    ]);

    console.log(`\nPool info:`);
    console.log(`  Token0: ${token0}`);
    console.log(`  Token1: ${token1}`);
    console.log(`  Fee: ${Number(fee) / 10000}%`);

    // Get Chainlink info
    const feedContract = new ethers.Contract(chainlinkFeedAddr, CHAINLINK_ABI, provider);
    const [feedDescription, feedDecimals] = await Promise.all([
      feedContract.description(),
      feedContract.decimals(),
    ]);

    console.log(`\nChainlink feed: ${feedDescription}`);

    // Get GMX market info
    const gmxReader = new ethers.Contract(
      "0xf60becbba223EEA9495Da3f606753867eC10d139",
      GMX_READER_ABI,
      provider
    );
    const gmxMarket = await gmxReader.getMarket(
      "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
      gmxMarketAddr
    );

    console.log(`\nGMX market:`);
    console.log(`  Index: ${gmxMarket.indexToken}`);
    console.log(`  Long: ${gmxMarket.longToken}`);
    console.log(`  Short: ${gmxMarket.shortToken}`);

    // Determine token order
    const baseIsToken0 = isBaseTokenToken0(baseTokenAddr, quoteTokenAddr);

    // Build config
    const config: MarketConfig = {
      id: baseSymbol,
      name: `Custom ${baseSymbol}/${quoteSymbol}`,
      description: `Custom market configuration for ${baseSymbol}/${quoteSymbol}`,
      chainId: 42161,

      baseToken,
      quoteToken,

      uniswapPool: {
        address: uniswapPoolAddr,
        feeTier: Number(fee),
        tickSpacing: TICK_SPACING[Number(fee)] || 60,
        token0: baseIsToken0 ? baseToken : quoteToken,
        token1: baseIsToken0 ? quoteToken : baseToken,
      },

      gmxMarket: {
        marketAddress: gmxMarketAddr,
        indexToken: gmxMarket.indexToken,
        longToken: gmxMarket.longToken,
        shortToken: gmxMarket.shortToken,
        name: `${baseSymbol}/USD`,
      },

      chainlinkFeed: {
        address: chainlinkFeedAddr,
        description: feedDescription,
        decimals: Number(feedDecimals),
        heartbeat: 3600,
      },

      baseTokenIsToken0: baseIsToken0,
      decimalAdjustment: calculateDecimalAdjustment(
        baseIsToken0 ? Number(baseDecimals) : Number(quoteDecimals),
        baseIsToken0 ? Number(quoteDecimals) : Number(baseDecimals)
      ),

      strategyParams: {
        defaultRangeWidth: 0.1,
        rebalanceThreshold: 0.05,
        minLpRatio: 0.8,
        maxHedgeLeverage: 3,
      },

      characteristics: {
        expectedFeeApy: [5, 20],
        volatilityLevel: "medium",
        liquidityRating: "medium",
        riskLevel: "moderate",
      },
    };

    return config;
  } catch (error) {
    console.error(`Error building config: ${(error as Error).message}`);
    return null;
  }
}

function printConstructorArgs(config: MarketConfig): void {
  console.log(`
Solidity constructor arguments for DeltaNeutralVault:

  // Tokens
  address quoteToken = ${config.quoteToken.address};  // ${config.quoteToken.symbol}
  address baseToken = ${config.baseToken.address};   // ${config.baseToken.symbol}

  // Uniswap V3
  address uniswapPool = ${config.uniswapPool.address};
  address positionManager = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
  address swapRouter = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
  uint24 feeTier = ${config.uniswapPool.feeTier};
  int24 tickSpacing = ${config.uniswapPool.tickSpacing};

  // GMX V2
  address gmxMarket = ${config.gmxMarket.marketAddress};
  address gmxExchangeRouter = 0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8;
  address gmxOrderVault = 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5;
  address gmxDataStore = 0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8;

  // Chainlink
  address priceFeed = ${config.chainlinkFeed.address};
  uint8 feedDecimals = ${config.chainlinkFeed.decimals};

  // Configuration
  bool baseTokenIsToken0 = ${config.baseTokenIsToken0};
  uint8 baseTokenDecimals = ${config.baseToken.decimals};
  uint8 quoteTokenDecimals = ${config.quoteToken.decimals};
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
