import { ethers } from "ethers";
import { UniswapPoolState, UniswapPosition, UniswapPositionManager, UniswapV3Pool } from "./types";
import { getUnclaimedFees } from "./fees";
import { UNISWAP_POOL_ABI, UNISWAP_POSITION_MANAGER_ABI } from "../../utils/abis";

export function createPool(address: string, provider: ethers.Provider): UniswapV3Pool {
  return new ethers.Contract(address, UNISWAP_POOL_ABI, provider) as unknown as UniswapV3Pool;
}

export function createPositionManager(
  address: string,
  provider: ethers.Provider
): UniswapPositionManager {
  return new ethers.Contract(
    address,
    UNISWAP_POSITION_MANAGER_ABI,
    provider
  ) as unknown as UniswapPositionManager;
}

export async function getPoolState(pool: UniswapV3Pool): Promise<UniswapPoolState> {
  const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
  return {
    sqrtPriceX96: slot0[0],
    tick: Number(slot0[1]),
    liquidity,
  };
}

export async function getPosition(
  manager: UniswapPositionManager,
  tokenId: bigint
): Promise<UniswapPosition> {
  const data = await manager.positions(tokenId);
  return {
    nonce: data[0],
    operator: data[1],
    token0: data[2],
    token1: data[3],
    fee: Number(data[4]),
    tickLower: Number(data[5]),
    tickUpper: Number(data[6]),
    liquidity: data[7],
    feeGrowthInside0LastX128: data[8],
    feeGrowthInside1LastX128: data[9],
    tokensOwed0: data[10],
    tokensOwed1: data[11],
  };
}

export async function getPositionWithFees(
  manager: UniswapPositionManager,
  tokenId: bigint,
  owner: string
): Promise<UniswapPosition> {
  const position = await getPosition(manager, tokenId);
  const fees = await getUnclaimedFees(manager, tokenId, owner);
  return {
    ...position,
    tokensOwed0: fees.amount0,
    tokensOwed1: fees.amount1,
  };
}

export async function getTokenIdsForOwner(
  manager: UniswapPositionManager,
  owner: string
): Promise<bigint[]> {
  const balance = await manager.balanceOf(owner);
  const count = Number(balance);
  const tokenIds: bigint[] = [];

  for (let i = 0; i < count; i++) {
    const tokenId = await manager.tokenOfOwnerByIndex(owner, i);
    tokenIds.push(typeof tokenId === "bigint" ? tokenId : BigInt(String(tokenId)));
  }

  return tokenIds;
}

export async function getActivePositionsForOwner(
  manager: UniswapPositionManager,
  owner: string
): Promise<{ tokenId: bigint; position: UniswapPosition }[]> {
  const tokenIds = await getTokenIdsForOwner(manager, owner);
  const activePositions: { tokenId: bigint; position: UniswapPosition }[] = [];

  for (const tokenId of tokenIds) {
    const position = await getPositionWithFees(manager, tokenId, owner);
    if (position.liquidity > 0n) {
      activePositions.push({ tokenId, position });
    }
  }

  return activePositions;
}
