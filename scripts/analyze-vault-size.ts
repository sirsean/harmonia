import { ethers } from "hardhat";
import { MARKET_REGISTRY, ARBITRUM_PROTOCOLS } from "../src/markets/registry";
import { MarketConfig } from "../src/markets/types";

// =============================================================================
// ABIs
// =============================================================================

const UNISWAP_POOL_ABI = [
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const GMX_DATA_STORE_ABI = ["function getUint(bytes32 key) view returns (uint256)"];

const GMX_READER_ABI = [
  "function getMarket(address dataStore, address market) view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken))",
];

// =============================================================================
// Analysis Logic
// =============================================================================

async function analyzeVaultSize(marketId: string) {
  const config = MARKET_REGISTRY[marketId.toUpperCase()];
  if (!config) {
    console.error(`Market ${marketId} not found in registry.`);
    process.exit(1);
  }

  console.log(`\nAnalyzing Vault Size Limits for ${config.name} (${marketId})...`);
  console.log("=".repeat(60));

  const provider = ethers.provider;

  // 1. Uniswap Liquidity Analysis
  // =========================================================================
  console.log("\n[Uniswap V3 Pool Analysis]");
  const pool = new ethers.Contract(config.uniswapPool.address, UNISWAP_POOL_ABI, provider);
  const liquidity = await pool.liquidity();
  const slot0 = await pool.slot0();
  const sqrtPriceX96 = slot0.sqrtPriceX96;

  // Calculate Pool TVL in USD (approx)
  const baseDecimals = config.baseToken.decimals;
  const quoteDecimals = config.quoteToken.decimals;

  // Calculate price from sqrtPriceX96
  const Q96 = BigInt(2) ** BigInt(96);
  const priceNum = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = priceNum * priceNum;

  let priceBaseToQuote = 0;
  if (config.baseTokenIsToken0) {
    const decimalDiff = baseDecimals - quoteDecimals;
    priceBaseToQuote = rawPrice * (10 ** decimalDiff);
  } else {
    priceBaseToQuote = (1 / rawPrice) * (10 ** (baseDecimals - quoteDecimals));
  }

  console.log(`  Pool Address: ${config.uniswapPool.address}`);
  console.log(`  Current Liquidity (L): ${liquidity}`);
  console.log(`  Approx Price: $${priceBaseToQuote.toFixed(2)}`);

  // Max Dominance (Soft Limit)
  const MAX_DOMINANCE = 0.20; // 20%
  const maxLiquidityVault = BigInt(Math.floor(Number(liquidity) * MAX_DOMINANCE));
  console.log(`  Soft Limit (20% Dominance): L=${maxLiquidityVault}`);

  // 2. GMX Open Interest Analysis
  // =========================================================================
  console.log("\n[GMX V2 Market Analysis]");
  const dataStore = new ethers.Contract(ARBITRUM_PROTOCOLS.GMX_DATA_STORE, GMX_DATA_STORE_ABI, provider);
  const reader = new ethers.Contract(ARBITRUM_PROTOCOLS.GMX_READER, GMX_READER_ABI, provider);
  const marketAddr = config.gmxMarket.marketAddress;

  // Verify market via Reader
  let longToken = "";
  let shortToken = "";
  try {
    const marketInfo = await reader.getMarket(ARBITRUM_PROTOCOLS.GMX_DATA_STORE, marketAddr);
    console.log(`  Market Verified: ${marketInfo.marketToken}`);
    console.log(`  Index Token: ${marketInfo.indexToken}`);
    console.log(`  Long Token:  ${marketInfo.longToken}`);
    console.log(`  Short Token: ${marketInfo.shortToken}`);
    longToken = marketInfo.longToken;
    shortToken = marketInfo.shortToken;
  } catch (e: any) {
    console.log(`  ERROR: Could not verify market with Reader: ${e.message}`);
  }

  // Keys for GMX DataStore
  function getOIKeyWithCollateral(prefix: string, collateral: string, isLong: boolean) {
    const prefixHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string"], [prefix]));
    const key = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "address", "bool"],
        [prefixHash, marketAddr, collateral, isLong]
      )
    );
    return key;
  }

  function getOIKeyOld(prefix: string, isLong: boolean) {
    const prefixHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string"], [prefix]));
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "bool"],
        [prefixHash, marketAddr, isLong]
      )
    );
  }

  // Use Short Token (USDC) for Shorts, Long Token (WETH) for Longs
  let maxShortOI = await dataStore.getUint(getOIKeyWithCollateral("MAX_OPEN_INTEREST", shortToken, false));
  let currentShortOI = await dataStore.getUint(getOIKeyWithCollateral("OPEN_INTEREST", shortToken, false));
  let currentLongOI = await dataStore.getUint(getOIKeyWithCollateral("OPEN_INTEREST", longToken, true));

  // If 0, try old key structure
  if (currentShortOI === 0n && currentLongOI === 0n) {
    console.log("  ... 0 values with Collateral Key, trying simpler key ...");
    currentShortOI = await dataStore.getUint(getOIKeyOld("OPEN_INTEREST", false));
    currentLongOI = await dataStore.getUint(getOIKeyOld("OPEN_INTEREST", true));
    maxShortOI = await dataStore.getUint(getOIKeyOld("MAX_OPEN_INTEREST", false));
  }

  const availableShortOI = maxShortOI > currentShortOI ? maxShortOI - currentShortOI : 0n;
  const formatUSD = (val: bigint) => `$${(Number(val) / 1e30).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  console.log(`  Market: ${config.gmxMarket.name}`);
  if (maxShortOI === 0n) {
    console.log(`  Max Short OI:      UNLIMITED (or 0 returned)`);
  } else {
    console.log(`  Max Short OI:      ${formatUSD(maxShortOI)}`);
  }
  console.log(`  Current Short OI:  ${formatUSD(currentShortOI)}`);
  console.log(`  Available Short OI:${maxShortOI === 0n ? "UNLIMITED" : formatUSD(availableShortOI)}`);
  console.log(`  Current Long OI:   ${formatUSD(currentLongOI)}`);

  // Funding Flip Capacity
  let fundingFlipCapacity = 0n;
  if (currentLongOI > currentShortOI) {
    fundingFlipCapacity = currentLongOI - currentShortOI;
  }
  console.log(`  Funding Flip Cap:  ${formatUSD(fundingFlipCapacity)} (Amount before paying funding)`);

  // 3. Synthesis & Recommendations
  // =========================================================================
  console.log("\n[Vault Size Limits Synthesis]");

  const HEDGE_RATIO = 0.45; // Conservative estimate
  let maxTvLGMX = 0;
  if (maxShortOI === 0n) {
    maxTvLGMX = Infinity;
  } else {
    maxTvLGMX = Number(availableShortOI) / 1e30 / HEDGE_RATIO;
  }

  const maxTvLGMX_Soft = Number(fundingFlipCapacity) / 1e30 / HEDGE_RATIO;

  console.log(`  Theoretical Max TVL (GMX Hard Limit):    ${maxTvLGMX === Infinity ? "Unlimited" : "$" + maxTvLGMX.toLocaleString()}`);
  console.log(`  Economic Max TVL (GMX Funding Flip):     $${maxTvLGMX_Soft.toLocaleString()}`);

  const recommendedLimit = maxTvLGMX_Soft > 0 ? maxTvLGMX_Soft : 0;
  console.log(`\n  >> Recommended Max Vault Size (Economic): $${recommendedLimit.toLocaleString()} (plus Uniswap liquidity constraints)`);
}

// Run
const marketId = process.env.MARKET || "ETH";
analyzeVaultSize(marketId)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });