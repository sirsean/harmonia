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
  
  // Calculate accurate Uniswap TVL Capacity for 20% dominance
  const width = config.strategyParams.defaultRangeWidth || 0.1;
  const sqrtP = Math.sqrt(priceBaseToQuote);
  const sqrtPa = Math.sqrt(priceBaseToQuote * (1 - width));
  const sqrtPb = Math.sqrt(priceBaseToQuote * (1 + width));
  
  // Calculate value of 1 unit of Liquidity (L=1) in USD
  // Note: These formulas assume price is Quote/Base.
  let valPerLiquidity = 0;

  if (config.baseTokenIsToken0) {
      // P = Quote/Base. sqrtP matches sqrtPriceX96 roughly (scaled).
      // Amount0 (Base) needed for L=1
      const amt0 = (sqrtPb - sqrtP) / (sqrtP * sqrtPb);
      // Amount1 (Quote) needed for L=1
      const amt1 = (sqrtP - sqrtPa);
      
      valPerLiquidity = amt0 * priceBaseToQuote + amt1;
  } else {
      // !baseTokenIsToken0: Token0=Quote, Token1=Base.
      const P_t1_t0 = 1 / priceBaseToQuote; // Base per Quote (Token1 per Token0)
      const sqrt_P_t1_t0 = Math.sqrt(P_t1_t0);
      
      const amtBase = 1 * sqrt_P_t1_t0 * (1 - Math.sqrt(1 - width));
      const amtQuote = 1 * (1/sqrt_P_t1_t0) * (1 - 1/Math.sqrt(1 + width));
      
      valPerLiquidity = amtBase * priceBaseToQuote + amtQuote;
  }
  
  // Adjust for decimals in L?
  // No, standard V3 formulas work with "Raw" units if P is "Raw" price (Token1/Token0).
  // Let's redo with Raw units to be safe, then convert to USD.
  
  // sqrtPriceX96 is raw sqrt(T1/T0) * 2^96.
  const sqrtRatioAX96 = BigInt(Math.floor(Number(sqrtPriceX96) * Math.sqrt(1 - width)));
  const sqrtRatioBX96 = BigInt(Math.floor(Number(sqrtPriceX96) * Math.sqrt(1 + width)));
  const sqrtRatioX96 = BigInt(sqrtPriceX96);
  
  // Helper for amounts (Raw Units)
  // We use Number for estimation to avoid BigInt division complexity in script
  const L_num = Number(liquidity);
  const P_num = Number(sqrtRatioX96) / 2**96;
  const Pa_num = Number(sqrtRatioAX96) / 2**96;
  const Pb_num = Number(sqrtRatioBX96) / 2**96;
  
  // Amount0 (Token0)
  const amt0_raw = L_num * (Pb_num - P_num) / (P_num * Pb_num);
  // Amount1 (Token1)
  const amt1_raw = L_num * (P_num - Pa_num);
  
  // Value in USD
  let tvlUSD = 0;
  if (config.baseTokenIsToken0) {
      const val0 = (amt0_raw / 10**baseDecimals) * priceBaseToQuote;
      const val1 = (amt1_raw / 10**quoteDecimals); // USDC = 1
      tvlUSD = val0 + val1;
  } else {
      // Token0 is Quote (USDC), Token1 is Base.
      const val0 = (amt0_raw / 10**quoteDecimals);
      const val1 = (amt1_raw / 10**baseDecimals) * priceBaseToQuote;
      tvlUSD = val0 + val1;
  }
  
  // Scale to Max Dominance
  const MAX_DOMINANCE = 0.20; // 20%
  const maxVaultTVL_Dominance = tvlUSD * MAX_DOMINANCE;

  console.log(`  Pool Address: ${config.uniswapPool.address}`);
  console.log(`  Current Liquidity (L): ${liquidity}`);
  console.log(`  Approx Price: $${priceBaseToQuote.toFixed(2)}`);
  console.log(`  Pool TVL (est): $${tvlUSD.toLocaleString()}`);
  console.log(`  Soft Limit (20% Dominance): $${maxVaultTVL_Dominance.toLocaleString()}`);

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
  console.log(`  Current Long OI:   ${formatUSD(currentLongOI)}`);
  
  // Funding Flip Capacity
  let fundingFlipCapacity = 0n;
  if (currentLongOI > currentShortOI) {
    fundingFlipCapacity = currentLongOI - currentShortOI;
  }
  console.log(`  Funding Flip Cap:  ${formatUSD(fundingFlipCapacity)} (Zero funding cost point)`);

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
  
  // Fee vs Funding Logic
  const expectedFeeApy = (config.characteristics.expectedFeeApy[0] + config.characteristics.expectedFeeApy[1]) / 2;
  console.log(`  Expected Uniswap Fee APY: ~${expectedFeeApy}%`);
  
  // Heuristic: $5M imbalance often creates ~10-20% APR funding in major markets.
  // Let's assume $1M imbalance = 2% Funding APR for ETH/BTC (Deep markets).
  // For ARB/LINK (Shallower), $1M imbalance = 5% Funding APR.

  let fundingSensitivity = 2; // % per $1M
  if (config.characteristics.liquidityRating === "medium") fundingSensitivity = 5;
  if (config.characteristics.liquidityRating === "low") fundingSensitivity = 10;
  
  const maxAcceptableFundingAPY = expectedFeeApy;
  const additionalCapacityUSD = (maxAcceptableFundingAPY / fundingSensitivity) * 1_000_000;
  
  const economicMaxShortOI = (Number(fundingFlipCapacity) / 1e30) + additionalCapacityUSD;
  const economicMaxTVL = economicMaxShortOI / HEDGE_RATIO;

  console.log(`  Max Tolerable Funding Cost: ${maxAcceptableFundingAPY}% APY`);
  console.log(`  Est. Extra Capacity via Fees: $${additionalCapacityUSD.toLocaleString()} (Sensitivity: ${fundingSensitivity}%/$1M)`);
  
  console.log(`  -> Economic Break-Even TVL: $${economicMaxTVL.toLocaleString()}`);
  console.log(`  -> Dominance Soft Limit:    $${maxVaultTVL_Dominance.toLocaleString()}`);

  const recommendedLimit = Math.min(economicMaxTVL, maxVaultTVL_Dominance);
  
  console.log(`\n  >> Recommended Max Vault Size: $${recommendedLimit.toLocaleString()}`);
  console.log(`     (Constrained by: ${economicMaxTVL < maxVaultTVL_Dominance ? 'Funding Costs' : 'Uniswap Dominance'})`);
}

// Run
const marketId = process.env.MARKET || "ETH";
analyzeVaultSize(marketId)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
