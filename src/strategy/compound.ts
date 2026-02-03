import { ethers } from "ethers";
import * as uniswapFees from "../modules/uniswap/fees";
import * as uniswapLiquidity from "../modules/uniswap/liquidity";
import * as uniswapReader from "../modules/uniswap/reader";
import { UniswapPositionManager, IERC20, UniswapV3Pool } from "../modules/uniswap/types";
import { MonitoringDatabase } from "../utils/database";
import { getLatestPrice } from "../modules/chainlink/price";
import { ARBITRUM_MAINNET } from "../config/addresses";

/**
 * Result of a compound operation
 */
export interface CompoundResult {
  /** Token ID that was compounded */
  tokenId: bigint;
  /** Amount of token0 collected */
  amount0Collected: bigint;
  /** Amount of token1 collected */
  amount1Collected: bigint;
  /** Amount of token0 actually added to liquidity */
  amount0Added: bigint;
  /** Amount of token1 actually added to liquidity */
  amount1Added: bigint;
  /** Transaction hash for fee collection */
  collectTxHash?: string;
  /** Transaction hash for liquidity increase */
  increaseLiquidityTxHash?: string;
}

/**
 * Configuration for compound operation
 */
export interface CompoundConfig {
  /** Position manager contract */
  positionManager: UniswapPositionManager;
  /** Pool contract (for reading pool state) */
  pool: UniswapV3Pool;
  /** Token0 contract (for approvals) */
  token0: IERC20;
  /** Token1 contract (for approvals) */
  token1: IERC20;
  /** Account that owns the positions */
  owner: string;
  /** Spender address (position manager) */
  spender: string;
  /** Whether to perform token approvals */
  performApproval?: boolean;
  /** Optional database instance for recording fee collections */
  db?: MonitoringDatabase;
  /** Optional provider for getting token prices (required if db is provided) */
  provider?: ethers.Provider;
  // Note: All transactions always wait for receipt - no option to disable
}

/**
 * Compound fees from Uniswap positions back into liquidity
 *
 * This function:
 * 1. Collects unclaimed fees from the specified position
 * 2. Adds the collected fees back to the position as liquidity
 * 3. Does NOT enforce maxPositionSizeUsd - allows position to exceed max size
 *
 * Note: The Uniswap V3 increaseLiquidity function will automatically calculate
 * the correct ratio of token0/token1 based on the current price and position range.
 * If the collected fees don't match the required ratio, Uniswap will use what it can
 * and the rest will remain in the owner's wallet.
 *
 * @param tokenId The NFT token ID of the position to compound
 * @param config Configuration for the compound operation
 * @returns Result containing collected amounts and transaction hashes
 */
export async function compoundFees(
  tokenId: bigint,
  config: CompoundConfig
): Promise<CompoundResult> {
  const { positionManager, pool, token0, token1, owner, spender } = config;

  // 1. Get current position state and unclaimed fees
  await uniswapReader.getPositionWithFees(positionManager, tokenId, owner);

  // Get fees before collecting (to know how much we'll collect)
  const feesBefore = await uniswapFees.getUnclaimedFees(positionManager, tokenId, owner);
  const amount0Collected = feesBefore.amount0;
  const amount1Collected = feesBefore.amount1;

  // If no fees to collect, return early
  if (amount0Collected === 0n && amount1Collected === 0n) {
    return {
      tokenId,
      amount0Collected: 0n,
      amount1Collected: 0n,
      amount0Added: 0n,
      amount1Added: 0n,
    };
  }

  // 2. Collect fees
  // Use MAX_UINT128 to collect all available fees
  // Note: The collect function signature is:
  // collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params)
  // The amount0Max and amount1Max are uint128, so we cap at MAX_UINT128
  const MAX_UINT128 = (1n << 128n) - 1n;
  const collectParams = {
    tokenId,
    recipient: owner, // Collect fees to owner
    amount0Max: amount0Collected > MAX_UINT128 ? MAX_UINT128 : (amount0Collected as bigint),
    amount1Max: amount1Collected > MAX_UINT128 ? MAX_UINT128 : (amount1Collected as bigint),
  };

  // Record fee collection in database if database is provided
  if (config.db && config.provider && (amount0Collected > 0n || amount1Collected > 0n)) {
    try {
      // Get pool to determine token order
      const token0Address = await pool.token0();
      const token1Address = await pool.token1();
      const isToken0Weth = token0Address.toLowerCase() === ARBITRUM_MAINNET.weth.toLowerCase();

      // Get token decimals
      // Cast to Contract to access decimals() method
      const token0Contract = token0 as unknown as ethers.Contract;
      const token1Contract = token1 as unknown as ethers.Contract;
      const decimals0 = await token0Contract.decimals();
      const decimals1 = await token1Contract.decimals();

      // Get ETH price for USD conversion
      const priceResult = await getLatestPrice(
        ARBITRUM_MAINNET.chainlinkEthUsdFeed,
        config.provider,
        { outputDecimals: 12, maxStaleSeconds: 3600 }
      );
      const ethPriceUsd = priceResult.outputPrice
        ? Number(ethers.formatUnits(priceResult.outputPrice, 12))
        : 3000;

      // Calculate USD value (30 decimals)
      let feesCollectedUsd = 0n;
      if (isToken0Weth) {
        // token0 is WETH, token1 is USDC
        const wethValueUsd =
          amount0Collected > 0n
            ? (amount0Collected * BigInt(Math.floor(ethPriceUsd * 1e12)) * 10n ** 18n) /
              (10n ** BigInt(decimals0) * 10n ** 12n)
            : 0n;
        const usdcValueUsd =
          amount1Collected > 0n ? (amount1Collected * 10n ** 30n) / 10n ** BigInt(decimals1) : 0n;
        feesCollectedUsd = wethValueUsd + usdcValueUsd;
      } else {
        // token0 is USDC, token1 is WETH
        const usdcValueUsd =
          amount0Collected > 0n ? (amount0Collected * 10n ** 30n) / 10n ** BigInt(decimals0) : 0n;
        const wethValueUsd =
          amount1Collected > 0n
            ? (amount1Collected * BigInt(Math.floor(ethPriceUsd * 1e12)) * 10n ** 18n) /
              (10n ** BigInt(decimals1) * 10n ** 12n)
            : 0n;
        feesCollectedUsd = usdcValueUsd + wethValueUsd;
      }

      if (feesCollectedUsd > 0n) {
        config.db.recordFeeCollection(
          owner,
          tokenId.toString(),
          feesCollectedUsd,
          amount0Collected,
          amount1Collected
        );
      }
    } catch (error: any) {
      // Don't fail compound operation if fee recording fails
      console.warn(
        `Warning: Failed to record fee collection for token ${tokenId}: ${error.message}`
      );
    }
  }

  // 3. Add liquidity back to position
  // Uniswap's increaseLiquidity will automatically calculate the correct ratio
  // based on current price and position range. We pass the collected amounts
  // as desired amounts, and Uniswap will use what it can.
  const increaseLiquidityParams = {
    tokenId,
    amount0Desired: amount0Collected,
    amount1Desired: amount1Collected,
    amount0Min: 0n, // Allow slippage - we're compounding fees, any addition is good
    amount1Min: 0n, // Allow slippage - we're compounding fees, any addition is good
    deadline: BigInt(Math.floor(Date.now() / 1000) + 1800), // 30 minutes from now
    owner,
    spender,
  };
  if (config.performApproval !== false) {
    await uniswapLiquidity.ensureAllowance(token0, owner, spender, amount0Collected);
    await uniswapLiquidity.ensureAllowance(token1, owner, spender, amount1Collected);
  }

  const multicallData = [
    uniswapFees.encodeCollectCalldata(collectParams),
    uniswapLiquidity.encodeIncreaseLiquidityCalldata(increaseLiquidityParams),
  ];

  const multicallTx = await positionManager.multicall(multicallData);
  await multicallTx.wait();
  const multicallTxHash = multicallTx.hash;

  // Note: To get the actual amounts added, we would need to:
  // 1. Parse the transaction receipt return values, or
  // 2. Read the position again after the transaction
  // For now, we'll use the collected amounts as an approximation
  // The actual amounts may be less if the ratio doesn't match exactly

  return {
    tokenId,
    amount0Collected,
    amount1Collected,
    amount0Added: amount0Collected, // Approximation - actual may be less
    amount1Added: amount1Collected, // Approximation - actual may be less
    collectTxHash: multicallTxHash,
    increaseLiquidityTxHash: multicallTxHash,
  };
}

/**
 * Compound fees from multiple positions
 *
 * @param tokenIds Array of token IDs to compound
 * @param config Configuration for the compound operation
 * @returns Array of compound results
 */
export async function compoundFeesForPositions(
  tokenIds: bigint[],
  config: CompoundConfig
): Promise<CompoundResult[]> {
  const results: CompoundResult[] = [];

  for (const tokenId of tokenIds) {
    try {
      const result = await compoundFees(tokenId, config);
      results.push(result);
    } catch (error) {
      console.error(`Failed to compound fees for token ${tokenId}:`, error);
      // Continue with other positions
    }
  }

  return results;
}
