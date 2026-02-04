import { ethers } from "ethers";
import { MULTICALL3_ABI } from "./abis";

export interface MulticallRequest {
  target: string;
  iface: ethers.Interface;
  functionName: string;
  args: any[];
  allowFailure?: boolean;
}

export interface MulticallResult {
  success: boolean;
  data: ethers.Result;
}

/**
 * Batch multiple read calls into a single RPC call using Multicall3.
 *
 * Each request specifies a target contract, the interface/function to call,
 * and the arguments. All calls are encoded, sent as a single aggregate3
 * call to the Multicall3 contract, and the results are decoded.
 *
 * @param provider - ethers Provider
 * @param multicall3Address - address of the Multicall3 contract
 * @param requests - array of call specifications
 * @returns array of decoded results in the same order as requests
 * @throws if any call with allowFailure=false (default) fails on-chain
 */
export async function multicallRead(
  provider: ethers.Provider,
  multicall3Address: string,
  requests: MulticallRequest[]
): Promise<MulticallResult[]> {
  if (requests.length === 0) {
    return [];
  }

  const calls = requests.map((req) => ({
    target: req.target,
    allowFailure: req.allowFailure ?? false,
    callData: req.iface.encodeFunctionData(req.functionName, req.args),
  }));

  const multicall = new ethers.Contract(multicall3Address, MULTICALL3_ABI, provider);
  const rawResults: { success: boolean; returnData: string }[] = await multicall.aggregate3(calls);

  return rawResults.map((raw, i): MulticallResult => {
    if (!raw.success) {
      if (!requests[i].allowFailure) {
        throw new Error(
          `Multicall: call ${i} to ${requests[i].target}.${requests[i].functionName} failed`
        );
      }
      return { success: false, data: ethers.Result.fromItems([]) };
    }

    const decoded = requests[i].iface.decodeFunctionResult(
      requests[i].functionName,
      raw.returnData
    );
    return { success: true, data: decoded };
  });
}
