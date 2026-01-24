import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { createReader, getAccountPositions, getMarket } from "../../../modules/gmx/reader";
import {
  averagePrice,
  fetchTokenPrices,
  findTokenPrice,
  price30ToPrice12,
  scalePriceTo30,
} from "../../../modules/gmx/prices";
import {
  computeCollateralUsd30,
  computeEntryPrice12,
  computePnlUsd30FromPrices,
  computeLiquidationPrice12,
} from "../../../modules/gmx/position";
import { getSignerAndAccount } from "../base";

const ERC20_ABI = ["function decimals() view returns (uint8)"];

async function getTokenDecimals(tokenAddress: string) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, ethers.provider);
  return Number(await token.decimals());
}

export interface GmxReadPositionOptions {
  account?: string;
  start?: number;
  end?: number;
  market?: string;
  maintenanceMarginBps?: bigint;
}

export async function gmxReadPosition(options: GmxReadPositionOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  const start = options.start ?? 0;
  const end = options.end ?? 10;
  const marketFilter = options.market?.toLowerCase() || "";

  const reader = createReader(ARBITRUM_MAINNET.gmxReader, ethers.provider);
  const positions = await getAccountPositions(
    reader,
    ARBITRUM_MAINNET.gmxDataStore,
    account,
    start,
    end
  );

  console.log("Reader:", ARBITRUM_MAINNET.gmxReader);
  console.log("Account:", account);
  console.log(`Range: ${start}..${end}`);
  console.log("Positions:", positions.length);

  const prices = await fetchTokenPrices(ARBITRUM_MAINNET.gmxPriceApi);
  const maintenanceMarginBps = options.maintenanceMarginBps ?? 100n;

  for (const position of positions) {
    const addresses = position.addresses;
    const numbers = position.numbers;
    const flags = position.flags;

    if (marketFilter && addresses.market.toLowerCase() !== marketFilter) {
      continue;
    }

    const market = await getMarket(reader, ARBITRUM_MAINNET.gmxDataStore, addresses.market);
    const indexPrice = findTokenPrice(prices, market.indexToken);
    const shortPrice = findTokenPrice(prices, market.shortToken);

    const [indexDecimals, collateralDecimals] = await Promise.all([
      getTokenDecimals(market.indexToken),
      getTokenDecimals(addresses.collateralToken),
    ]);

    const entryPrice12 = computeEntryPrice12(
      numbers.sizeInUsd,
      numbers.sizeInTokens,
      indexDecimals
    );
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
      flags.isLong
    );

    const minCollateralUsd30 = (numbers.sizeInUsd * maintenanceMarginBps) / 10_000n;

    const liquidationPrice12 = computeLiquidationPrice12(
      entryPrice12,
      collateralUsd30,
      minCollateralUsd30,
      numbers.sizeInTokens,
      indexDecimals,
      flags.isLong
    );

    const netValueUsd30 = collateralUsd30 + pnlUsd30;

    console.log("\nMarket:", addresses.market);
    console.log("Collateral:", addresses.collateralToken);
    console.log("Is Long:", flags.isLong);
    console.log("Size (USD):", ethers.formatUnits(numbers.sizeInUsd, 30));
    console.log("Size (Tokens):", ethers.formatUnits(numbers.sizeInTokens, indexDecimals));
    console.log(
      "Collateral Amount:",
      ethers.formatUnits(numbers.collateralAmount, collateralDecimals)
    );
    console.log("Net Value (USD):", ethers.formatUnits(netValueUsd30, 30));
    console.log("Entry Price:", ethers.formatUnits(entryPrice12, 12));
    console.log("Mark Price:", ethers.formatUnits(markPrice12, 12));
    console.log(
      "Liquidation Price (approx):",
      liquidationPrice12 ? ethers.formatUnits(liquidationPrice12, 12) : "n/a"
    );
    console.log("Increased At:", numbers.increasedAtTime?.toString?.() || "0");
    console.log("Decreased At:", numbers.decreasedAtTime?.toString?.() || "0");
  }
}
