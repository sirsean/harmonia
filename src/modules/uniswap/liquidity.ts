import { ethers } from "ethers";
import {
  IERC20,
  IncreaseLiquidityParams,
  MintParams,
  UniswapExecutionConfig,
  UniswapPositionManager,
  UniswapTransactionResult,
} from "./types";
import { UNISWAP_POSITION_MANAGER_WRITE_ABI } from "../../utils/abis";

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
    return { params, txHash: tx.hash };
  }

  return { params, txHash: tx.hash, tx };
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
