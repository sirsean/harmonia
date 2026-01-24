import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../src/config/addresses";
import { createReader, getPosition } from "../src/modules/gmx/reader";
import {
  computeCollateralUsd30,
  computeEntryPrice12,
  computePnlUsd30FromPrices,
} from "../src/modules/gmx/position";
import {
  averagePrice,
  fetchTokenPrices,
  findTokenPrice,
  price30ToPrice12,
  scalePriceTo30,
} from "../src/modules/gmx/prices";

const ERC20_ABI = ["function decimals() view returns (uint8)"];

async function getTokenDecimals(tokenAddress: string) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, ethers.provider);
  return Number(await token.decimals());
}

async function main() {
  const [signer] = await ethers.getSigners();
  const account = process.env.ACCOUNT || signer.address;
  const initialDeposit = process.env.INITIAL_DEPOSIT
    ? parseFloat(process.env.INITIAL_DEPOSIT)
    : 500;

  console.log("=== Loss Analysis ===\n");
  console.log(`Account: ${account}`);
  console.log(`Initial Deposit: $${initialDeposit.toFixed(2)}\n`);

  // Get GMX position
  const reader = createReader(ARBITRUM_MAINNET.gmxReader, ethers.provider);
  const gmxPosition = await getPosition(reader, ARBITRUM_MAINNET.gmxDataStore, account, {
    market: ARBITRUM_MAINNET.gmxEthUsdMarket,
    collateralToken: ARBITRUM_MAINNET.usdc,
    isLong: false,
  });

  if (!gmxPosition) {
    console.log("No GMX position found");
    return;
  }

  const prices = await fetchTokenPrices(ARBITRUM_MAINNET.gmxPriceApi);
  const market = await reader.getMarket(
    ARBITRUM_MAINNET.gmxDataStore,
    ARBITRUM_MAINNET.gmxEthUsdMarket
  );
  const indexPrice = findTokenPrice(prices, market.indexToken);
  const shortPrice = findTokenPrice(prices, market.shortToken);

  const [indexDecimals, collateralDecimals] = await Promise.all([
    getTokenDecimals(market.indexToken),
    getTokenDecimals(ARBITRUM_MAINNET.usdc),
  ]);

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

  const netValueUsd30 = collateralUsd30 + pnlUsd30;

  // Calculate funding fees
  // fundingFeeAmountPerSize is cumulative funding fees paid per unit of size
  // The exact calculation depends on GMX's internal representation
  // For now, let's display the raw values and calculate based on size
  // fundingFeeAmountPerSize is typically in USD (30 decimals) per token (scaled)
  // We need to multiply by sizeInTokens and adjust for decimals
  const sizeInTokensScaled = numbers.sizeInTokens * 10n ** BigInt(30 - indexDecimals);
  const totalFundingFeesUsd30 = (numbers.fundingFeeAmountPerSize * sizeInTokensScaled) / 10n ** 30n;

  // Also check claimable funding (this would be positive if we're receiving funding)
  const claimableFundingUsd30 =
    (numbers.shortTokenClaimableFundingAmountPerSize * sizeInTokensScaled) / 10n ** 30n;

  console.log("[GMX Position Details]");
  console.log(`  Size: $${ethers.formatUnits(numbers.sizeInUsd, 30)}`);
  console.log(`  Collateral: $${ethers.formatUnits(collateralUsd30, 30)}`);
  console.log(`  Entry Price: $${ethers.formatUnits(entryPrice12, 12)}`);
  console.log(`  Mark Price: $${ethers.formatUnits(markPrice12, 12)}`);
  console.log(
    `  Price Change: ${(((Number(markPrice12) - Number(entryPrice12)) / Number(entryPrice12)) * 100).toFixed(4)}%`
  );
  console.log(`  PnL from Price: $${ethers.formatUnits(pnlUsd30, 30)}`);
  console.log(`  Net Value: $${ethers.formatUnits(netValueUsd30, 30)}`);
  console.log(`\n[GMX Funding Fees]`);
  console.log(
    `  Funding Fee Amount Per Size: ${ethers.formatUnits(numbers.fundingFeeAmountPerSize, 30)}`
  );
  console.log(`  Total Funding Fees Paid: $${ethers.formatUnits(totalFundingFeesUsd30, 30)}`);
  console.log(
    `  Claimable Funding (per size): ${ethers.formatUnits(numbers.shortTokenClaimableFundingAmountPerSize, 30)}`
  );
  console.log(`  Total Claimable Funding: $${ethers.formatUnits(claimableFundingUsd30, 30)}`);

  // Estimate hourly funding rate
  // We need to know when the position was opened
  const positionAgeSeconds =
    numbers.increasedAtTime > 0n
      ? Math.floor(Date.now() / 1000) - Number(numbers.increasedAtTime)
      : 3600; // Assume 1 hour if not available
  const positionAgeHours = positionAgeSeconds / 3600;

  if (positionAgeHours > 0) {
    const hourlyFundingRate =
      Number(totalFundingFeesUsd30) / Number(numbers.sizeInUsd) / positionAgeHours;
    const annualFundingRate = hourlyFundingRate * 24 * 365;
    console.log(`\n[Funding Rate Analysis]`);
    console.log(`  Position Age: ${positionAgeHours.toFixed(2)} hours`);
    console.log(`  Hourly Funding Rate: ${(hourlyFundingRate * 100).toFixed(4)}%`);
    console.log(`  Annual Funding Rate: ${(annualFundingRate * 100).toFixed(2)}%`);
  }

  // Calculate expected total value
  // LP Position: $412.63 (from monitor output)
  // GMX Position: $71.24 (from monitor output)
  const currentTotalValue = 412.63 + Number(ethers.formatUnits(netValueUsd30, 30));
  const loss = initialDeposit - currentTotalValue;
  const lossPercentage = (loss / initialDeposit) * 100;

  console.log(`\n[Portfolio Analysis]`);
  console.log(`  Current Total Value: $${currentTotalValue.toFixed(2)}`);
  console.log(`  Initial Deposit: $${initialDeposit.toFixed(2)}`);
  console.log(`  Total Loss: $${loss.toFixed(2)} (${lossPercentage.toFixed(2)}%)`);

  console.log(`\n[Loss Breakdown]`);
  console.log(`  GMX Price PnL: $${ethers.formatUnits(pnlUsd30, 30)}`);
  console.log(`  GMX Funding Fees: $${ethers.formatUnits(totalFundingFeesUsd30, 30)}`);
  const otherLoss =
    loss -
    Number(ethers.formatUnits(pnlUsd30, 30)) -
    Number(ethers.formatUnits(totalFundingFeesUsd30, 30));
  console.log(`  Other Losses (slippage/gas/IL): $${otherLoss.toFixed(2)}`);

  console.log(`\n[Key Insights]`);
  if (Number(totalFundingFeesUsd30) > 0.01) {
    console.log(
      `  ⚠️  GMX funding fees are costing $${ethers.formatUnits(totalFundingFeesUsd30, 30)}`
    );
    if (positionAgeHours > 0) {
      const hourlyFundingRate =
        Number(totalFundingFeesUsd30) / Number(numbers.sizeInUsd) / positionAgeHours;
      const annualFundingRate = hourlyFundingRate * 24 * 365;
      console.log(
        `  ⚠️  At current rate, this is ${(hourlyFundingRate * 100).toFixed(4)}% per hour`
      );
      console.log(`  ⚠️  Annualized: ${(annualFundingRate * 100).toFixed(2)}% per year`);
    }
  } else {
    console.log(
      `  ℹ️  GMX funding fees are minimal (likely due to short position receiving funding)`
    );
  }
  if (otherLoss > 5) {
    console.log(`  ⚠️  Significant other losses ($${otherLoss.toFixed(2)}) suggest:`);
    console.log(`      - Opening slippage when entering LP position`);
    console.log(`      - Opening slippage when entering GMX short`);
    console.log(`      - Gas fees (typically $1-3 per transaction)`);
    console.log(`      - Possible impermanent loss from initial position entry`);
  }

  // Calculate what the expected opening costs should be
  const lpPositionValue = 412.63;
  const gmxCollateral = Number(ethers.formatUnits(collateralUsd30, 30));
  const expectedDeposit = lpPositionValue + gmxCollateral;
  const openingCosts = initialDeposit - expectedDeposit;

  console.log(`\n[Opening Cost Analysis]`);
  console.log(`  LP Position Value: $${lpPositionValue.toFixed(2)}`);
  console.log(`  GMX Collateral: $${gmxCollateral.toFixed(2)}`);
  console.log(`  Expected Total After Opening: $${expectedDeposit.toFixed(2)}`);
  console.log(`  Actual Deposit: $${initialDeposit.toFixed(2)}`);
  console.log(`  Opening Costs (slippage + gas): $${openingCosts.toFixed(2)}`);
  console.log(`  Opening Cost %: ${((openingCosts / initialDeposit) * 100).toFixed(2)}%`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
