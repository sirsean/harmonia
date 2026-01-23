import { ethers } from "ethers";
import {
  IERC20,
  IncreaseLiquidityParams,
  MintParams,
  UniswapExecutionConfig,
  UniswapPositionManager,
  UniswapTransactionResult,
} from "./types";

export const UNISWAP_POSITION_MANAGER_WRITE_ABI = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
];

export function createPositionManager(
  address: string,
  signer: ethers.Signer
): UniswapPositionManager {
  return new ethers.Contract(
    address,
    UNISWAP_POSITION_MANAGER_WRITE_ABI,
    signer
  ) as unknown as UniswapPositionManager;
}

export async function ensureAllowance(
  token: IERC20,
  owner: string,
  spender: string,
  amount: bigint
): Promise<boolean> {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) {
    return false;
  }
  const approval = await token.approve(spender, amount);
  await approval.wait();
  return true;
}

export function buildMintParams(params: MintParams): MintParams {
  return { ...params };
}

export function buildIncreaseLiquidityParams(
  params: IncreaseLiquidityParams
): IncreaseLiquidityParams {
  return { ...params };
}

export async function mintPosition(
  manager: UniswapPositionManager,
  token0: IERC20,
  token1: IERC20,
  params: MintParams,
  config: UniswapExecutionConfig & { owner: string; spender: string }
): Promise<UniswapTransactionResult<MintParams>> {
  if (config.performApproval !== false) {
    await Promise.all([
      ensureAllowance(token0, config.owner, config.spender, params.amount0Desired),
      ensureAllowance(token1, config.owner, config.spender, params.amount1Desired),
    ]);
  }

  const tx = await manager.mint(buildMintParams(params), config.overrides);
  if (config.waitForReceipt !== false) {
    await tx.wait();
  }

  return { params, txHash: tx.hash };
}

export async function increaseLiquidity(
  manager: UniswapPositionManager,
  token0: IERC20,
  token1: IERC20,
  params: IncreaseLiquidityParams & { owner: string; spender: string },
  config: UniswapExecutionConfig = {}
): Promise<UniswapTransactionResult<IncreaseLiquidityParams>> {
  if (config.performApproval !== false) {
    await Promise.all([
      ensureAllowance(token0, params.owner, params.spender, params.amount0Desired),
      ensureAllowance(token1, params.owner, params.spender, params.amount1Desired),
    ]);
  }

  const { owner, spender, ...callParams } = params;
  const tx = await manager.increaseLiquidity(
    buildIncreaseLiquidityParams(callParams),
    config.overrides
  );
  if (config.waitForReceipt !== false) {
    await tx.wait();
  }

  return { params: callParams, txHash: tx.hash };
}
