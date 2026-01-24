import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import {
  createPool,
  createPositionManager,
  getPoolState,
  getPosition,
  getPositionWithFees,
  getTokenIdsForOwner,
} from "../../../modules/uniswap/reader";
import {
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  tickToPriceWithDecimals,
} from "../../../modules/math/ticks";
import { getSignerAndAccount } from "../base";
import { ERC20_ABI, UNISWAP_FACTORY_ABI } from "../../../utils/abis";

async function printPosition(tokenId: bigint, owner: string) {
  const manager = createPositionManager(ARBITRUM_MAINNET.uniswapV3PositionManager, ethers.provider);
  const position = await getPositionWithFees(manager, tokenId, owner);

  const token0 = new ethers.Contract(position.token0, ERC20_ABI, ethers.provider);
  const token1 = new ethers.Contract(position.token1, ERC20_ABI, ethers.provider);
  const [token0Symbol, token1Symbol, token0Decimals, token1Decimals] = await Promise.all([
    token0.symbol(),
    token1.symbol(),
    token0.decimals(),
    token1.decimals(),
  ]);

  const factory = new ethers.Contract(
    ARBITRUM_MAINNET.uniswapV3Factory,
    UNISWAP_FACTORY_ABI,
    ethers.provider
  );
  const poolAddress = await factory.getPool(position.token0, position.token1, position.fee);
  const pool = createPool(poolAddress, ethers.provider);
  const poolState = await getPoolState(pool);
  const poolToken0 = await pool.token0();
  const poolToken1 = await pool.token1();

  const sqrtLower = getSqrtRatioAtTick(position.tickLower);
  const sqrtUpper = getSqrtRatioAtTick(position.tickUpper);
  const { amount0, amount1 } = getAmountsForLiquidity(
    poolState.sqrtPriceX96,
    sqrtLower,
    sqrtUpper,
    position.liquidity
  );
  const rawCurrentPrice = tickToPriceWithDecimals(poolState.tick, token0Decimals, token1Decimals);
  const rawLowerPrice = tickToPriceWithDecimals(position.tickLower, token0Decimals, token1Decimals);
  const rawUpperPrice = tickToPriceWithDecimals(position.tickUpper, token0Decimals, token1Decimals);
  const positionMatchesPool =
    poolToken0.toLowerCase() === position.token0.toLowerCase() &&
    poolToken1.toLowerCase() === position.token1.toLowerCase();
  const currentPrice = positionMatchesPool ? rawCurrentPrice : 1 / rawCurrentPrice;
  const lowerPrice = positionMatchesPool ? rawLowerPrice : 1 / rawLowerPrice;
  const upperPrice = positionMatchesPool ? rawUpperPrice : 1 / rawUpperPrice;

  console.log("\nToken ID:", tokenId.toString());
  console.log("Token0:", position.token0, token0Symbol);
  console.log("Token1:", position.token1, token1Symbol);
  console.log("Fee:", position.fee);
  console.log(
    "Current:",
    `tick ${poolState.tick}, price ${currentPrice.toFixed(6)} ${token1Symbol}/${token0Symbol}`
  );
  console.log(
    "Tick Lower:",
    `${position.tickLower} (price ${lowerPrice.toFixed(6)} ${token1Symbol}/${token0Symbol})`
  );
  console.log(
    "Tick Upper:",
    `${position.tickUpper} (price ${upperPrice.toFixed(6)} ${token1Symbol}/${token0Symbol})`
  );
  console.log("Liquidity:", position.liquidity.toString());
  console.log(
    "Amounts:",
    `${ethers.formatUnits(amount0, token0Decimals)} ${token0Symbol}, ${ethers.formatUnits(
      amount1,
      token1Decimals
    )} ${token1Symbol}`
  );
  console.log(
    "Claimable Fees:",
    `${ethers.formatUnits(position.tokensOwed0, token0Decimals)} ${token0Symbol}, ${ethers.formatUnits(position.tokensOwed1, token1Decimals)} ${token1Symbol}`
  );
}

export interface UniswapReadPositionOptions {
  account?: string;
  tokenId?: string;
  showClosed?: boolean;
}

export async function uniswapReadPosition(options: UniswapReadPositionOptions = {}): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("UNISWAP V3 READ POSITION");
  console.log("=".repeat(60) + "\n");

  const { account } = await getSignerAndAccount(options.account);
  const showClosed = options.showClosed ?? false;

  const tokenIdRaw = options.tokenId;
  if (tokenIdRaw) {
    await printPosition(BigInt(tokenIdRaw), account);
    return;
  }

  const manager = createPositionManager(ARBITRUM_MAINNET.uniswapV3PositionManager, ethers.provider);
  const tokenIds = await getTokenIdsForOwner(manager, account);

  if (tokenIds.length === 0) {
    console.log("No Uniswap V3 positions found for:", account);
    return;
  }

  const activeTokenIds: bigint[] = [];

  for (const tokenId of tokenIds) {
    const position = await getPosition(manager, tokenId);
    if (position.liquidity === 0n) {
      if (showClosed) {
        activeTokenIds.push(tokenId);
      }
      continue;
    }
    activeTokenIds.push(tokenId);
  }

  console.log("Owner:", account);
  console.log("Positions:", activeTokenIds.length);

  for (const tokenId of activeTokenIds) {
    await printPosition(tokenId, account);
  }
}
