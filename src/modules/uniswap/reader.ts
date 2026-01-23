import { ethers } from "ethers";
import { UniswapPoolState, UniswapPosition, UniswapPositionManager, UniswapV3Pool } from "./types";
import { getUnclaimedFees } from "./fees";

export const UNISWAP_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

export const UNISWAP_POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
];

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
    tokenIds.push(typeof tokenId === "bigint" ? tokenId : BigInt(tokenId.toString()));
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
