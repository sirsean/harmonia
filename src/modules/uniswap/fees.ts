import {
  CollectParams,
  DecreaseLiquidityParams,
  UniswapPositionManager,
  UniswapTransactionResult,
} from "./types";

export function buildDecreaseLiquidityParams(
  params: DecreaseLiquidityParams
): DecreaseLiquidityParams {
  return { ...params };
}

export function buildCollectParams(params: CollectParams): CollectParams {
  return { ...params };
}

export async function decreaseLiquidity(
  manager: UniswapPositionManager,
  params: DecreaseLiquidityParams,
  overrides?: { nonce?: number }
): Promise<UniswapTransactionResult<DecreaseLiquidityParams>> {
  const callParams = buildDecreaseLiquidityParams(params);
  const tx = overrides
    ? await manager.decreaseLiquidity(callParams, overrides)
    : await manager.decreaseLiquidity(callParams);
  await tx.wait();
  return { params, txHash: tx.hash };
}

export async function collectFees(
  manager: UniswapPositionManager,
  params: CollectParams,
  overrides?: { nonce?: number }
): Promise<UniswapTransactionResult<CollectParams>> {
  const callParams = buildCollectParams(params);
  const tx = overrides
    ? await manager.collect(callParams, overrides)
    : await manager.collect(callParams);
  await tx.wait();
  return { params, txHash: tx.hash };
}
