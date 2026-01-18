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
  // We need price.
  // Price = quote/base (if base is token0? No, standard logic)
  const baseDecimals = config.baseToken.decimals;
  const quoteDecimals = config.quoteToken.decimals;
  
  // Calculate price from sqrtPriceX96
  // price = (sqrtPrice / 2^96)^2
  const Q96 = BigInt(2) ** BigInt(96);
  const priceNum = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = priceNum * priceNum; // price in token1/token0 units

  // Adjust for decimals to get human price
  // If token0 is WBTC (8) and token1 is USDC (6)
  // rawPrice = USDC / WBTC * 10^(8-6) = USDC/WBTC * 100
  // Real Price = rawPrice / 10^(dec0 - dec1)
  
  let priceBaseToQuote = 0;
  if (config.baseTokenIsToken0) {
      // base is token0, quote is token1
      // rawPrice is token1/token0 = quote/base
      // We need to adjust decimals: quote_decimals - base_decimals
      // But rawPrice includes the decimal shift from contract math? No, rawPrice is just Ratio.
      // 1 token0 = rawPrice token1
      // 1 Base = rawPrice * 10^(dec0 - dec1) Quote ??
      
      // Let's use the standard formula:
      // price = rawPrice * 10^(dec0 - dec1)
      const decimalDiff = baseDecimals - quoteDecimals;
      priceBaseToQuote = rawPrice * (10 ** decimalDiff);
  } else {
      // base is token1, quote is token0
      // rawPrice is token1/token0 = base/quote
      // We want quote/base = 1/rawPrice
      const decimalDiff = quoteDecimals - baseDecimals; // Adjust inverse
      // 1 token1 = rawPrice token0
      // 1 Base = rawPrice * 10^(dec1 - dec0) Quote
      priceBaseToQuote = (1/rawPrice) * (10 ** (baseDecimals - quoteDecimals));
  }
  
  // Actually simpler:
  // Value of liquidity L in range [Pa, Pb] is roughly L * (sqrt(Pb) - sqrt(Pa)) in Token1 terms...
  // Let's just estimate TVL roughly using liquidity and current price, assuming full range for simplicity of magnitude.
  // Or better, just define dominance based on L directly.
  
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
  
  
  
      } catch (e) {
  
  
  
          console.log(`  ERROR: Could not verify market with Reader: ${e.message}`);
  
  
  
      }
  
  
  
      
  
  
  
        // Keys for GMX DataStore
  
  
  
      
  
  
  
        // GMX V2 uses keccak256(abi.encode("OPEN_INTEREST")) as the prefix
  
  
  
      
  
  
  
        // NOT keccak256(bytes("OPEN_INTEREST"))
  
  
  
      
  
  
  
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
  
  
  
      
  
  
  
        
  
  
  
      
  
  
  
        // Fallback to old structure just in case
  
  
  
      
  
  
  
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
  
  
  
      // This is the standard for GMX V2 (Single Token Pools per side)
  
  
  
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
  
  
  
    
  
    
  
    // If maxShortOI is 0, it might mean unlimited or not set. 
  
    // But for main markets like ETH, it is usually set.
  
    // If currentShortOI is 0, that's definitely wrong for ETH.
  
    
  
    const availableShortOI = maxShortOI > currentShortOI ? maxShortOI - currentShortOI : 0n;
  
    
  
    // Convert to USD (30 decimals)
  
    const formatUSD = (val: bigint) => `${(Number(val) / 1e30).toLocaleString(undefined, {maximumFractionDigits: 0})}`;
  
    
  
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
  
    // How much short OI can we add before Shorts > Longs?
  
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
  
    console.log(`  Economic Max TVL (GMX Funding Flip):     ${maxTvLGMX_Soft.toLocaleString()}`);
  
    
  
    // Dominance Limit in USD
  
    // For Dominance, we have Liquidity L.
  
    // We estimated priceBaseToQuote.
  
    // Uniswap V3 TVL ~= L * Price (very roughly for full range). 
  
    // Let's use a better approximation.
  
    // Amount0 = L * (1/sqrtP - 1/sqrtPb)
  
    // Amount1 = L * (sqrtP - sqrtPa)
  
    // If we assume a +/- 10% range.
  
    // Pa = P * 0.9, Pb = P * 1.1
  
    // sqrtPa = sqrt(P)*0.948, sqrtPb = sqrt(P)*1.048
  
    // Amount1 = L * sqrtP * (1 - 0.948) = L * sqrtP * 0.052
  
    // Amount0 = L * (1/sqrtP) * (1 - 1/1.048) = L/sqrtP * 0.045
  
    // Value = Amount1 + Amount0 * P = L*sqrtP*0.052 + (L/sqrtP*0.045)*P = L*sqrtP*0.097
  
    // So roughly Value = L * sqrt(P) * RangeWidth/2 * 2 = L * sqrt(P) * RangeWidth.
  
    
  
    // sqrt(Price) in proper units.
  
    // We have sqrtPriceX96.
  
    // sqrt(P) = sqrtPriceX96 / 2^96. 
  
    // Wait, units.
  
    // L is in calculated units.
  
    // Value (Token1) = L * sqrtPriceX96 / Q96 * (sqrtPb_ratio - sqrtPa_ratio)
  
    // If we take RangeWidth = 20% (0.2).
  
    // Value ~= L * (Price^0.5) * 0.2?
  
    
  
    // Let's use the crude metric: L is roughly the amount of Token1 needed to move price by 100%? No.
  
    // Standard approximation:
  
    // TVL in active tick = L^2 / Price? No.
  
    
  
    // Let's stick to just printing L and noting that 20% of L is the limit.
  
    // Converting to USD is hard without exact range.
  
    // But we can assume the vault deploys into a standard range (e.g. +/- 10%).
  
    // In a +/- 10% range, the capital efficiency is ~5x vs full range.
  
    // Full range TVL ~ L * Price^0.5 * 2?
  
    // Let's just output L.
  
    
  
    const recommendedLimit = maxTvLGMX_Soft > 0 ? maxTvLGMX_Soft : 0;
  
    
  
    console.log(`\n  >> Recommended Max Vault Size (Economic): ${recommendedLimit.toLocaleString()} (plus Uniswap liquidity constraints)`);
  
  
}

// Run
const marketId = process.env.MARKET || "ETH";
analyzeVaultSize(marketId)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
