import { ethers } from "ethers";
import { UniswapPositionManager, DecreaseLiquidityParams, CollectParams } from "./types";
import { UNISWAP_POSITION_MANAGER_WRITE_ABI } from "../../utils/abis";

const POSITION_MANAGER_INTERFACE = new ethers.Interface(UNISWAP_POSITION_MANAGER_WRITE_ABI);

export function buildDecreaseLiquidityParams(
  params: DecreaseLiquidityParams
): DecreaseLiquidityParams {
  return params;
}

export function buildCollectParams(params: CollectParams): CollectParams {
  return params;
}

export function encodeDecreaseLiquidityCalldata(params: DecreaseLiquidityParams): string {
  return POSITION_MANAGER_INTERFACE.encodeFunctionData("decreaseLiquidity", [params]);
}

export function encodeCollectCalldata(params: CollectParams): string {
  return POSITION_MANAGER_INTERFACE.encodeFunctionData("collect", [params]);
}

export async function decreaseLiquidity(
  manager: UniswapPositionManager,
  params: DecreaseLiquidityParams
): Promise<{ hash: string; wait: () => Promise<unknown> }> {
  // Let ethers manage nonce automatically - no manual nonce management
  return manager.decreaseLiquidity(params) as Promise<{
    hash: string;
    wait: () => Promise<unknown>;
  }>;
}

export async function collectFees(
  manager: UniswapPositionManager,
  params: CollectParams
): Promise<{ hash: string; wait: () => Promise<ethers.TransactionReceipt> }> {
  // Let ethers manage nonce automatically - no manual nonce management
  return manager.collect(params) as Promise<{
    hash: string;
    wait: () => Promise<ethers.TransactionReceipt>;
  }>;
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
