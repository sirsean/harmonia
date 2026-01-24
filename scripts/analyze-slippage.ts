import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../src/config/addresses";
import { createReader, getPosition } from "../src/modules/gmx/reader";
import {
  computeEntryPrice12,
  computePnlUsd30FromPrices,
  computeCollateralUsd30,
} from "../src/modules/gmx/position";
import {
  averagePrice,
  fetchTokenPrices,
  findTokenPrice,
  price30ToPrice12,
  scalePriceTo30,
} from "../src/modules/gmx/prices";
import { getAmountsForLiquidity, getSqrtRatioAtTick } from "../src/modules/math/ticks";
import * as uniswapReader from "../src/modules/uniswap/reader";
import { getLatestPrice } from "../src/modules/chainlink/price";
import { ERC20_ABI } from "../src/utils/abis";

async function getTokenInfo(tokenAddress: string, provider: ethers.Provider) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
  return { decimals: Number(decimals), symbol };
}

async function main() {
  const [signer] = await ethers.getSigners();
  const account = process.env.ACCOUNT || signer.address;
  const provider = ethers.provider;

  console.log("=== Slippage Analysis ===\n");
  console.log(`Account: ${account}\n`);

  // Get current prices
  const chainlinkPrice = await getLatestPrice(ARBITRUM_MAINNET.chainlinkEthUsdFeed, provider, {
    outputDecimals: 12,
  });
  const ethPriceChainlink = Number(chainlinkPrice.outputPrice || chainlinkPrice.price) / 1e12;

  // Get Uniswap pool state
  const poolContract = uniswapReader.createPool(ARBITRUM_MAINNET.uniswapV3EthUsdcPool, provider);
  const poolState = await uniswapReader.getPoolState(poolContract);
  const [poolToken0, poolToken1] = await Promise.all([
    poolContract.token0(),
    poolContract.token1(),
  ]);

  const token0Info = await getTokenInfo(poolToken0, provider);
  const token1Info = await getTokenInfo(poolToken1, provider);

  const isToken0Weth = poolToken0.toLowerCase() === ARBITRUM_MAINNET.weth.toLowerCase();
  const wethInfo = isToken0Weth ? token0Info : token1Info;
  const usdcInfo = isToken0Weth ? token1Info : token0Info;

  // Calculate current Uniswap price
  const sqrtPriceX96 = poolState.sqrtPriceX96;
  const priceRatio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const priceToken1PerToken0 = priceRatio * 10 ** (token0Info.decimals - token1Info.decimals);
  const ethPriceUniswap = isToken0Weth ? 1 / priceToken1PerToken0 : priceToken1PerToken0;

  console.log("[Current Prices]");
  console.log(`  Chainlink ETH/USD: $${ethPriceChainlink.toFixed(2)}`);
  console.log(`  Uniswap ETH/USD: $${ethPriceUniswap.toFixed(2)}`);
  console.log(
    `  Price Difference: ${(((ethPriceUniswap - ethPriceChainlink) / ethPriceChainlink) * 100).toFixed(4)}%\n`
  );

  // Get Uniswap position
  const pmContract = uniswapReader.createPositionManager(
    ARBITRUM_MAINNET.uniswapV3PositionManager,
    provider
  );
  // Get active positions (with liquidity > 0)
  const activePositions = await uniswapReader.getActivePositionsForOwner(pmContract, account);

  if (activePositions.length === 0) {
    console.log("No active Uniswap positions found");
    return;
  }

  // Use the first active position (or check if we can find token ID 5240204)
  const tokenIdEnv = process.env.UNISWAP_TOKEN_ID;
  let targetPosition = activePositions[0];
  if (tokenIdEnv) {
    const found = activePositions.find((p) => p.tokenId.toString() === tokenIdEnv);
    if (found) targetPosition = found;
  }

  const position = targetPosition.position;
  const tokenId = targetPosition.tokenId;
  const sqrtPriceAX96 = getSqrtRatioAtTick(position.tickLower);
  const sqrtPriceBX96 = getSqrtRatioAtTick(position.tickUpper);
  const { amount0, amount1 } = getAmountsForLiquidity(
    sqrtPriceX96,
    sqrtPriceAX96,
    sqrtPriceBX96,
    position.liquidity
  );

  const wethAmount = isToken0Weth ? amount0 : amount1;
  const usdcAmount = isToken0Weth ? amount1 : amount0;

  const currentLpValueUsd =
    Number(ethers.formatUnits(wethAmount, wethInfo.decimals)) * ethPriceChainlink +
    Number(ethers.formatUnits(usdcAmount, usdcInfo.decimals));

  console.log("[Uniswap LP Position]");
  console.log(`  Token ID: ${tokenId}`);
  console.log(`  WETH Amount: ${ethers.formatUnits(wethAmount, wethInfo.decimals)}`);
  console.log(`  USDC Amount: ${ethers.formatUnits(usdcAmount, usdcInfo.decimals)}`);
  console.log(`  Current Value: $${currentLpValueUsd.toFixed(2)}`);
  console.log(`  Tick Range: [${position.tickLower}, ${position.tickUpper}]`);

  // Estimate what was deposited (assuming 50/50 split at entry)
  // If price was similar, we can estimate the deposit amount
  const estimatedWethDeposit = Number(ethers.formatUnits(wethAmount, wethInfo.decimals));
  const estimatedUsdcDeposit = Number(ethers.formatUnits(usdcAmount, usdcInfo.decimals));
  const estimatedLpDeposit = estimatedWethDeposit * ethPriceChainlink + estimatedUsdcDeposit;

  console.log(`\n  Estimated Deposit (if 50/50):`);
  console.log(
    `    WETH: ${estimatedWethDeposit.toFixed(6)} (~$${(estimatedWethDeposit * ethPriceChainlink).toFixed(2)})`
  );
  console.log(`    USDC: ${estimatedUsdcDeposit.toFixed(2)}`);
  console.log(`    Total: $${estimatedLpDeposit.toFixed(2)}`);

  // Get GMX position
  const reader = createReader(ARBITRUM_MAINNET.gmxReader, provider);
  const gmxPosition = await getPosition(reader, ARBITRUM_MAINNET.gmxDataStore, account, {
    market: ARBITRUM_MAINNET.gmxEthUsdMarket,
    collateralToken: ARBITRUM_MAINNET.usdc,
    isLong: false,
  });

  if (!gmxPosition) {
    console.log("\nNo GMX position found");
    return;
  }

  const prices = await fetchTokenPrices(ARBITRUM_MAINNET.gmxPriceApi);
  const market = await reader.getMarket(
    ARBITRUM_MAINNET.gmxDataStore,
    ARBITRUM_MAINNET.gmxEthUsdMarket
  );
  const indexPrice = findTokenPrice(prices, market.indexToken);
  const shortPrice = findTokenPrice(prices, market.shortToken);

  const indexDecimals = wethInfo.decimals;
  const collateralDecimals = usdcInfo.decimals;

  const numbers = gmxPosition.numbers;
  const entryPrice12 = computeEntryPrice12(numbers.sizeInUsd, numbers.sizeInTokens, indexDecimals);
  const markPriceRaw = averagePrice(indexPrice);
  const markPrice30 = scalePriceTo30(markPriceRaw, indexDecimals);
  const markPrice12 = price30ToPrice12(markPrice30);
  const collateralPriceRaw = averagePrice(shortPrice);
  const collateralUsd30 = computeCollateralUsd30(numbers.collateralAmount, collateralPriceRaw);
  const pnlUsd30 = computePnlUsd30FromPrices(
    numbers.sizeInTokens,
    entryPrice12,
    markPrice12,
    indexDecimals,
    gmxPosition.flags.isLong
  );

  const entryPriceUsd = Number(entryPrice12) / 1e12;
  const markPriceUsd = Number(markPrice12) / 1e12;
  const executionSlippage = ((entryPriceUsd - markPriceUsd) / markPriceUsd) * 100;

  console.log("\n[GMX Short Position]");
  console.log(`  Size: $${ethers.formatUnits(numbers.sizeInUsd, 30)}`);
  console.log(`  Collateral: $${ethers.formatUnits(collateralUsd30, 30)}`);
  console.log(`  Entry Price: $${entryPriceUsd.toFixed(2)}`);
  console.log(`  Current Mark Price: $${markPriceUsd.toFixed(2)}`);
  console.log(`  Execution Slippage: ${executionSlippage.toFixed(4)}%`);
  console.log(`  PnL: $${ethers.formatUnits(pnlUsd30, 30)}`);

  // Calculate what the expected entry price should have been
  // GMX script uses acceptablePrice = currentPrice * 0.99 (1% slippage tolerance)
  const expectedEntryPrice = markPriceUsd * 0.99;
  const actualSlippageVsExpected =
    ((entryPriceUsd - expectedEntryPrice) / expectedEntryPrice) * 100;

  console.log(`\n  Expected Entry (99% of mark): $${expectedEntryPrice.toFixed(2)}`);
  console.log(`  Actual Entry: $${entryPriceUsd.toFixed(2)}`);
  console.log(`  Slippage vs Expected: ${actualSlippageVsExpected.toFixed(4)}%`);

  // Calculate total costs
  const totalCurrentValue =
    currentLpValueUsd + Number(ethers.formatUnits(collateralUsd30 + pnlUsd30, 30));
  const estimatedTotalDeposit =
    estimatedLpDeposit + Number(ethers.formatUnits(numbers.collateralAmount, collateralDecimals));

  console.log("\n[Total Portfolio Analysis]");
  console.log(`  Estimated Total Deposit: $${estimatedTotalDeposit.toFixed(2)}`);
  console.log(`  Current Total Value: $${totalCurrentValue.toFixed(2)}`);
  console.log(`  Total Loss: $${(estimatedTotalDeposit - totalCurrentValue).toFixed(2)}`);

  // Breakdown of losses
  const lpSlippage = estimatedLpDeposit - currentLpValueUsd;
  const gmxSlippageCost =
    (entryPriceUsd - markPriceUsd) *
    Number(ethers.formatUnits(numbers.sizeInTokens, indexDecimals));

  console.log("\n[Loss Breakdown]");
  console.log(`  LP Position Slippage/IL: $${lpSlippage.toFixed(2)}`);
  console.log(`  GMX Execution Slippage: $${gmxSlippageCost.toFixed(2)}`);
  console.log(`  GMX Price PnL: $${ethers.formatUnits(pnlUsd30, 30)}`);
  const otherLosses =
    estimatedTotalDeposit -
    totalCurrentValue -
    lpSlippage -
    gmxSlippageCost -
    Number(ethers.formatUnits(pnlUsd30, 30));
  console.log(`  Other (gas, fees, etc): $${otherLosses.toFixed(2)}`);

  console.log("\n[Key Findings]");
  if (Math.abs(executionSlippage) > 0.1) {
    console.log(`  ⚠️  GMX execution slippage: ${executionSlippage.toFixed(4)}%`);
  }
  if (lpSlippage > 5) {
    console.log(`  ⚠️  LP position lost $${lpSlippage.toFixed(2)} - likely from:`);
    console.log(`     - Swap slippage when converting USDC to WETH`);
    console.log(`     - Mint slippage (amount0Min/amount1Min set to 0!)`);
    console.log(`     - Impermanent loss from price movement`);
  }
  if (otherLosses > 2) {
    console.log(`  ⚠️  Additional $${otherLosses.toFixed(2)} in other costs (gas, fees)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
