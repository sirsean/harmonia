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
import { refreshNonce } from "../../utils/helpers";

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
  const MAX_UINT256 = (1n << 256n) - 1n;
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) {
    return false;
  }
  const approval = await token.approve(spender, MAX_UINT256);
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

export function encodeMintCalldata(params: MintParams): string {
  const iface = new ethers.Interface(UNISWAP_POSITION_MANAGER_WRITE_ABI);
  return iface.encodeFunctionData("mint", [params]);
}

export function encodeIncreaseLiquidityCalldata(params: IncreaseLiquidityParams): string {
  const iface = new ethers.Interface(UNISWAP_POSITION_MANAGER_WRITE_ABI);
  return iface.encodeFunctionData("increaseLiquidity", [params]);
}

export async function mintPosition(
  manager: UniswapPositionManager,
  token0: IERC20,
  token1: IERC20,
  params: MintParams,
  config: UniswapExecutionConfig & { owner: string; spender: string }
): Promise<UniswapTransactionResult<MintParams>> {
  // CRITICAL: Process approvals sequentially to avoid nonce conflicts
  if (config.performApproval !== false) {
    // Sequential approvals - let ethers manage nonces automatically
    await ensureAllowance(token0, config.owner, config.spender, params.amount0Desired);
    const managerContract = manager as unknown as ethers.Contract;
    const provider = managerContract.runner?.provider;
    if (provider && typeof provider === "object" && "getTransactionCount" in provider) {
      await refreshNonce(provider as ethers.Provider, config.owner);
    }
    await ensureAllowance(token1, config.owner, config.spender, params.amount1Desired);
    if (provider && typeof provider === "object" && "getTransactionCount" in provider) {
      await refreshNonce(provider as ethers.Provider, config.owner);
    }
  }

  // Let ethers manage nonce automatically - no manual nonce management
  const tx = await manager.mint(buildMintParams(params));
  // CRITICAL: Always wait for receipt to ensure transaction is confirmed
  await tx.wait();
  return { params, txHash: tx.hash };
}

export async function increaseLiquidity(
  manager: UniswapPositionManager,
  token0: IERC20,
  token1: IERC20,
  params: IncreaseLiquidityParams & { owner: string; spender: string },
  config: UniswapExecutionConfig = {}
): Promise<UniswapTransactionResult<IncreaseLiquidityParams>> {
  // CRITICAL: Process approvals sequentially to avoid nonce conflicts
  if (config.performApproval !== false) {
    // Sequential approvals - let ethers manage nonces automatically
    await ensureAllowance(token0, params.owner, params.spender, params.amount0Desired);
    const managerContract = manager as unknown as ethers.Contract;
    const provider = managerContract.runner?.provider;
    if (provider && typeof provider === "object" && "getTransactionCount" in provider) {
      await refreshNonce(provider as ethers.Provider, params.owner);
    }
    await ensureAllowance(token1, params.owner, params.spender, params.amount1Desired);
    if (provider && typeof provider === "object" && "getTransactionCount" in provider) {
      await refreshNonce(provider as ethers.Provider, params.owner);
    }
  }

  const { owner, spender, ...callParams } = params;
  // Let ethers manage nonce automatically - no manual nonce management
  const tx = await manager.increaseLiquidity(buildIncreaseLiquidityParams(callParams));
  // CRITICAL: Always wait for receipt to ensure transaction is confirmed
  await tx.wait();

  return { params: callParams, txHash: tx.hash };
}
