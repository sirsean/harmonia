import { ethers } from "ethers";
import { UniswapPositionManager, DecreaseLiquidityParams, CollectParams } from "./types";

export function buildDecreaseLiquidityParams(
  params: DecreaseLiquidityParams
): DecreaseLiquidityParams {
  return params;
}

export function buildCollectParams(params: CollectParams): CollectParams {
  return params;
}

export async function decreaseLiquidity(
  manager: UniswapPositionManager,
  params: DecreaseLiquidityParams,
  overrides?: { nonce?: number }
): Promise<{ wait: () => Promise<unknown> }> {
  if (overrides) {
    return manager.decreaseLiquidity(params, overrides);
  }
  return manager.decreaseLiquidity(params);
}

export async function collectFees(
  manager: UniswapPositionManager,
  params: CollectParams,
  overrides?: { nonce?: number }
): Promise<{ wait: () => Promise<unknown> }> {
  if (overrides) {
    return manager.collect(params, overrides);
  }
  return manager.collect(params);
}

export async function getUnclaimedFees(
  manager: UniswapPositionManager,
  tokenId: bigint,
  owner: string
): Promise<{ amount0: bigint; amount1: bigint }> {
  const MAX_UINT128 = (1n << 128n) - 1n;

  const params = {
    tokenId: tokenId,
    recipient: owner,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };

  try {
    // Cast manager to any to access staticCall
    const contract = manager as any;

    if (contract.collect && contract.collect.staticCall) {
      const result = await contract.collect.staticCall(params);
      return { amount0: result[0], amount1: result[1] };
    }

    // If we can't find staticCall, maybe it's a raw ethers Contract and we can try callStatic (v5) logic or just fail gracefully.
    // In ethers v6, staticCall is the way.

    return { amount0: 0n, amount1: 0n };
  } catch (error) {
    console.warn(`Failed to simulate fee collection for token ${tokenId}:`, error);
    return { amount0: 0n, amount1: 0n };
  }
}
