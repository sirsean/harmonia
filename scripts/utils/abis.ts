/**
 * Shared ABI definitions for scripts
 *
 * These ABIs are used across multiple scripts to avoid duplication.
 */

/**
 * Standard ERC20 token ABI
 * Includes common functions: decimals, symbol, balanceOf, allowance, approve
 */
export const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

/**
 * Minimal ERC20 ABI (only decimals)
 * Used when only decimals are needed
 */
export const ERC20_MINIMAL_ABI = ["function decimals() view returns (uint8)"] as const;

/**
 * Uniswap V3 Pool token ABI
 * Used to get token0 and token1 addresses from a pool
 */
export const POOL_TOKEN_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
] as const;

/**
 * Uniswap V3 Swap Router ABI
 * Used for executing swaps
 */
export const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
] as const;

/**
 * Uniswap V3 Quoter ABI
 * Used for getting swap quotes
 */
export const QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
] as const;
