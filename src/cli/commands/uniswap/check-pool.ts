import { ethers } from "hardhat";
import { createPool, getPoolState } from "../../../modules/uniswap/reader";
import { tickToPriceWithDecimals } from "../../../modules/math/ticks";
import { ERC20_ABI } from "../../../utils/abis";

export interface UniswapCheckPoolOptions {
  pool: string;
}

export async function uniswapCheckPool(options: UniswapCheckPoolOptions): Promise<void> {
  const pool = createPool(options.pool, ethers.provider);
  const [poolState, token0, token1, liquidity] = await Promise.all([
    getPoolState(pool),
    pool.token0(),
    pool.token1(),
    pool.liquidity(),
  ]);

  const token0Contract = new ethers.Contract(token0, ERC20_ABI, ethers.provider);
  const token1Contract = new ethers.Contract(token1, ERC20_ABI, ethers.provider);
  const [token0Decimals, token1Decimals, token0Symbol, token1Symbol] = await Promise.all([
    token0Contract.decimals(),
    token1Contract.decimals(),
    token0Contract.symbol(),
    token1Contract.symbol(),
  ]);

  const price = tickToPriceWithDecimals(
    poolState.tick,
    Number(token0Decimals),
    Number(token1Decimals)
  );

  console.log("Pool:", options.pool);
  console.log("Token0:", token0, token0Symbol);
  console.log("Token1:", token1, token1Symbol);
  console.log("Fee:", await pool.fee());
  console.log("Tick:", poolState.tick.toString());
  console.log("Price:", `${price.toFixed(6)} ${token1Symbol}/${token0Symbol}`);
  console.log("Liquidity:", liquidity.toString());
  console.log("sqrtPriceX96:", poolState.sqrtPriceX96.toString());
}
