/**
 * Centralized ABI definitions for the Harmonia project
 *
 * This module provides all ABI definitions used across the codebase to avoid duplication.
 * Import from here instead of defining ABIs locally.
 */

// ============================================================================
// ERC20 Token ABI
// ============================================================================

/**
 * Standard ERC20 token ABI
 * Includes all common functions: decimals, symbol, balanceOf, allowance, approve
 * Use this single ABI for all ERC20 token interactions to ensure consistency.
 */
export const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

// ============================================================================
// Uniswap V3 ABIs
// ============================================================================

/**
 * Uniswap V3 Pool ABI
 * Used for reading pool state (slot0, liquidity, tokens, fee)
 * Use this single ABI for all Uniswap V3 pool interactions to ensure consistency.
 */
export const UNISWAP_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
] as const;

/**
 * Uniswap V3 Position Manager ABI (read-only)
 * Used for reading position data
 */
export const UNISWAP_POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
] as const;

/**
 * Uniswap V3 Position Manager ABI (write operations)
 * Used for minting, increasing/decreasing liquidity, collecting fees
 */
export const UNISWAP_POSITION_MANAGER_WRITE_ABI = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
] as const;

/**
 * Uniswap V3 Factory ABI
 * Used for pool creation and queries
 */
export const UNISWAP_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
] as const;

/**
 * Uniswap V3 Swap Router ABI
 * Used for executing swaps
 */
export const UNISWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
] as const;

/**
 * Uniswap V3 Quoter ABI
 * Used for getting swap quotes
 */
export const UNISWAP_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
] as const;

// ============================================================================
// GMX V2 ABIs
// ============================================================================

/**
 * GMX Reader ABI
 * Used for reading GMX positions and market data
 */
export const GMX_READER_ABI = [
  "function getAccountPositions(address dataStore, address account, uint256 start, uint256 end) view returns (tuple(tuple(address account, address market, address collateralToken) addresses, tuple(uint256 sizeInUsd, uint256 sizeInTokens, uint256 collateralAmount, uint256 borrowingFactor, uint256 fundingFeeAmountPerSize, uint256 longTokenClaimableFundingAmountPerSize, uint256 shortTokenClaimableFundingAmountPerSize, uint256 increasedAtTime, uint256 decreasedAtTime) numbers, tuple(bool isLong) flags)[])",
  "function getMarket(address dataStore, address key) view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken))",
] as const;

/**
 * GMX Router ABI
 * Used for creating orders and executing GMX operations
 */
export const GMX_ROUTER_ABI = [
  "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
  "function sendTokens(address token, address receiver, uint256 amount) external payable",
  "function sendWnt(address receiver, uint256 amount) external payable",
  "function createOrder(((address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath),(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime),uint8 orderType,uint8 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList) params) external payable returns (bytes32 orderKey)",
] as const;

// ============================================================================
// Chainlink ABIs
// ============================================================================

/**
 * Chainlink Price Feed ABI
 * Used for reading price data from Chainlink feeds
 */
export const CHAINLINK_FEED_ABI = [
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
] as const;
