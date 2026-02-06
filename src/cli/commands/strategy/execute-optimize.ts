import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { DeltaNeutralMonitor } from "../../../strategy/monitor";
import { loadStrategyConfig, DEFAULT_STRATEGY_CONFIG, PRECISION } from "../../../config/strategy";
import { getDefaultRangeBounds } from "../../../config/markets";
import { createPositionManager, getPosition } from "../../../modules/uniswap/reader";
import {
  createPositionManager as createPositionManagerWriter,
  mintPosition,
} from "../../../modules/uniswap/liquidity";
import { createPool, getPoolState } from "../../../modules/uniswap/reader";
import { closePositions } from "./close-all";
import {
  priceToTickWithDecimals,
  roundTickDown,
  roundTickUp,
  tickToPriceWithDecimals,
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
} from "../../../modules/math/ticks";
import * as gmxReader from "../../../modules/gmx/reader";
import * as gmxOrders from "../../../modules/gmx/orders";
import { getLatestPrice } from "../../../modules/chainlink/price";
import { calculateOptimalAllocation, calculateLpTokenAmounts } from "../../../strategy/allocation";
import { RebalanceManager } from "../../../strategy/rebalance";
import {
  fetchTokenPrices,
  findTokenPrice,
  averagePrice,
  scalePriceTo30,
} from "../../../modules/gmx/prices";
import { getSignerAndAccount } from "../base";
import { MonitoringDatabase } from "../../../utils/database";
import { StateManager } from "../../../utils/state";
import { getAPRMetrics } from "../../../utils/apr";
import { IERC20 as UniswapIERC20 } from "../../../modules/uniswap/types";
import {
  ERC20_ABI,
  UNISWAP_POOL_ABI,
  UNISWAP_ROUTER_ABI,
  UNISWAP_QUOTER_ABI,
} from "../../../utils/abis";

import { toBigInt, refreshNonce } from "../../../utils/helpers";
import { sendErrorAlert, sendSuccessAlert } from "../../../utils/alerts";

export interface ExecuteOptimizeOptions {
  account?: string;
  tokenId?: string;
  rangeWidth?: number;
  priceLower?: number;
  priceUpper?: number;
  slippageBps?: bigint;
  execute?: boolean;
  suppressAlert?: boolean;
}

/**
 * Optimize strategy position by:
 * 1. Collecting fees from LP positions
 * 2. Recentering LP position (even if still in range)
 * 3. Optimizing GMX hedge using funds from LP
 *
 * Unlike `adjust-range`, this command always executes regardless of monitor recommendations.
 * This is useful when delta has drifted but LP is still technically "in range".
 */
export interface ExecuteOptimizeResult {
  feesCollectedUsd: bigint;
}

type SweepWethContract = {
  balanceOf: (account: string) => Promise<bigint>;
  allowance: (owner: string, spender: string) => Promise<bigint>;
  approve: (
    spender: string,
    amount: bigint
  ) => Promise<{ wait: () => Promise<{ gasUsed?: bigint; gasPrice?: bigint }> }>;
};

type SweepSwapRouter = {
  exactInputSingle: (params: {
    tokenIn: string;
    tokenOut: string;
    fee: number;
    recipient: string;
    deadline: bigint;
    amountIn: bigint;
    amountOutMinimum: bigint;
    sqrtPriceLimitX96: number;
  }) => Promise<{ hash: string; wait: () => Promise<{ gasUsed?: bigint; gasPrice?: bigint }> }>;
};

type SweepQuoter = {
  quoteExactInputSingle: {
    staticCall: (
      tokenIn: string,
      tokenOut: string,
      fee: number,
      amountIn: bigint,
      sqrtPriceLimitX96: number
    ) => Promise<bigint>;
  };
};

export async function sweepIdleWethToUsdc(params: {
  account: string;
  wethContract: SweepWethContract;
  swapRouter: SweepSwapRouter;
  quoter: SweepQuoter;
  wethToken: string;
  usdcToken: string;
  fee: number;
  slippageBps: bigint;
  dustThreshold: bigint;
  refreshNonce: (provider: any, account: string) => Promise<void>;
  provider: any;
  transactionReceipts?: Array<{ gasUsed: bigint; gasPrice: bigint }>;
}): Promise<{ amountIn: bigint; amountOutMin: bigint } | null> {
  const {
    account,
    wethContract,
    swapRouter,
    quoter,
    wethToken,
    usdcToken,
    fee,
    slippageBps,
    dustThreshold,
    refreshNonce: refreshNonceFn,
    provider,
    transactionReceipts,
  } = params;

  const amountIn = await wethContract.balanceOf(account);
  if (amountIn <= dustThreshold) {
    return null;
  }

  let quoteOut: bigint;
  try {
    const quoteOutRaw = await quoter.quoteExactInputSingle.staticCall(
      wethToken,
      usdcToken,
      fee,
      amountIn,
      0
    );
    quoteOut = toBigInt(quoteOutRaw);
    if (quoteOut === 0n) {
      throw new Error("Quoter returned 0 - insufficient liquidity or invalid parameters");
    }
  } catch (error: any) {
    const errorMsg = error.reason || error.message || String(error);
    throw new Error(`Failed to get sweep quote: ${errorMsg}`);
  }

  const amountOutMin = (quoteOut * (10_000n - slippageBps)) / 10_000n;
  const allowance = await wethContract.allowance(account, ARBITRUM_MAINNET.uniswapV3SwapRouter);

  if (allowance < amountIn) {
    const approval = await wethContract.approve(
      ARBITRUM_MAINNET.uniswapV3SwapRouter,
      (1n << 256n) - 1n
    );
    const approvalReceipt = await approval.wait();
    if (approvalReceipt?.gasUsed && approvalReceipt?.gasPrice && transactionReceipts) {
      transactionReceipts.push({
        gasUsed: approvalReceipt.gasUsed,
        gasPrice: approvalReceipt.gasPrice,
      });
    }
    await refreshNonceFn(provider, account);
  }

  const swapTx = await swapRouter.exactInputSingle({
    tokenIn: wethToken,
    tokenOut: usdcToken,
    fee,
    recipient: account,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    amountIn,
    amountOutMinimum: amountOutMin,
    sqrtPriceLimitX96: 0,
  });

  const swapReceipt = await swapTx.wait();
  if (swapReceipt?.gasUsed && swapReceipt?.gasPrice && transactionReceipts) {
    transactionReceipts.push({
      gasUsed: swapReceipt.gasUsed,
      gasPrice: swapReceipt.gasPrice,
    });
  }
  await refreshNonceFn(provider, account);

  return { amountIn, amountOutMin };
}

/**
 * Robust swap helper with retries and improved error handling
 */
export async function swapTokenToToken(params: {
  account: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  contractIn: Contract;
  swapRouter: Contract;
  routerAddress: string;
  quoter: Contract;
  fee: number;
  slippageBps: bigint;
  signer: Signer;
  refreshNonceFn: (provider: any, account: string) => Promise<void>;
  transactionReceipts?: Array<{ gasUsed: bigint; gasPrice: bigint }>;
  executeFlag: boolean;
  logPrefix?: string;
}): Promise<void> {
  const {
    account,
    tokenIn,
    tokenOut,
    amountIn,
    contractIn,
    swapRouter,
    routerAddress,
    quoter,
    fee,
    slippageBps,
    signer,
    refreshNonceFn,
    transactionReceipts,
    executeFlag,
    logPrefix = "",
  } = params;

  if (!executeFlag) return;

  let lastError: any;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 1. Get Quote with Retry Logic
      let quoteOut: bigint;
      try {
        const quoteOutRaw = await quoter.quoteExactInputSingle.staticCall(
          tokenIn,
          tokenOut,
          fee,
          amountIn,
          0
        );
        quoteOut = toBigInt(quoteOutRaw);
        if (quoteOut === 0n) {
          throw new Error("Quoter returned 0 - insufficient liquidity or invalid parameters");
        }
      } catch (error: any) {
        const errorMsg = error.reason || error.message || String(error);
        throw new Error(`Failed to get swap quote: ${errorMsg}`);
      }

      const amountOutMin = (quoteOut * (10_000n - slippageBps)) / 10_000n;

      // 2. Check/Approve Allowance
      // We check allowance every retry just in case it was consumed or reset
      const allowance = await contractIn.allowance(account, routerAddress);
      if (allowance < amountIn) {
        console.log(`${logPrefix}Approving swap router...`);
        // Let ethers manage nonce automatically
        const approval = await contractIn.approve(routerAddress, ethers.MaxUint256);
        // CRITICAL: Wait for approval before proceeding
        const approvalReceipt = await approval.wait();

        if (
          approvalReceipt &&
          approvalReceipt.gasUsed &&
          approvalReceipt.gasPrice &&
          transactionReceipts
        ) {
          transactionReceipts.push({
            gasUsed: approvalReceipt.gasUsed,
            gasPrice: approvalReceipt.gasPrice,
          });
        }
        await refreshNonceFn(signer.provider, account);
      }

      // 3. Execute Swap
      // Let ethers manage nonce automatically
      const swapTx = await swapRouter.exactInputSingle({
        tokenIn,
        tokenOut,
        fee,
        recipient: account,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600), // 10 minutes from now
        amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0,
      });

      console.log(`${logPrefix}Swap tx: ${swapTx.hash}`);
      // CRITICAL: Wait for swap confirmation before proceeding
      const swapReceipt = await swapTx.wait();

      if (swapReceipt && swapReceipt.gasUsed && swapReceipt.gasPrice && transactionReceipts) {
        transactionReceipts.push({
          gasUsed: swapReceipt.gasUsed,
          gasPrice: swapReceipt.gasPrice,
        });
      }

      await refreshNonceFn(signer.provider, account);
      return; // Success
    } catch (error: any) {
      lastError = error;
      const errorMsg = error.reason || error.message || String(error);

      // Don't retry if it's a user rejection or known fatal error
      if (errorMsg.includes("User denied") || errorMsg.includes("insufficient funds")) {
        throw error;
      }

      console.warn(`${logPrefix}Swap attempt ${attempt}/${maxRetries} failed: ${errorMsg}`);

      if (attempt < maxRetries) {
        const delay = 1000 * attempt; // Progressive backoff: 1s, 2s, 3s
        console.log(`${logPrefix}Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `${logPrefix}Swap failed after ${maxRetries} attempts. Last error: ${lastError?.message || lastError}`
  );
}

export async function executeOptimize(
  options: ExecuteOptimizeOptions = {}
): Promise<ExecuteOptimizeResult> {
  const { signer, account } = await getSignerAndAccount(options.account);

  console.log("\n" + "=".repeat(60));
  console.log("OPTIMIZE STRATEGY POSITION");
  console.log("=".repeat(60) + "\n");

  console.log("Executing account:", account);

  try {
    // 1. Check Strategy Status (for information, but don't gate execution)
    const tokenIds = options.tokenId ? [BigInt(options.tokenId)] : undefined;

    const monitorConfig = loadStrategyConfig({
      minOptimizationFeeThresholdUsd: ethers.parseUnits("10", 30),
    });

    const monitorContext = {
      uniswap: {
        positionManager: ARBITRUM_MAINNET.uniswapV3PositionManager,
        pool: ARBITRUM_MAINNET.uniswapV3EthUsdcPool,
        tokenIds: tokenIds,
      },
      gmx: {
        reader: ARBITRUM_MAINNET.gmxReader,
        dataStore: ARBITRUM_MAINNET.gmxDataStore,
        account: account,
        market: ARBITRUM_MAINNET.gmxEthUsdMarket,
        collateralToken: ARBITRUM_MAINNET.usdc,
      },
      multicall3: ARBITRUM_MAINNET.multicall3,
    };

    const monitor = new DeltaNeutralMonitor(ethers.provider, monitorConfig, monitorContext);

    console.log("Checking position status...");
    const { status, recommendation } = await monitor.check();

    console.log(`Current status: ${recommendation.action}`);
    console.log(`Reason: ${recommendation.reason}`);
    console.log(`Net delta: ${status.netDelta.toString()}`);
    console.log(`Delta drift: ${(status.deltaDrift * 100).toFixed(2)}%`);

    // Always proceed with optimization regardless of recommendation
    console.log("\n⚠️  OPTIMIZE mode: Will reset position regardless of current status");

    // 2. Get positions to optimize (may be empty)
    const positionsToOptimize = status.uniswap.filter((pos) => pos.liquidity > 0n);

    if (positionsToOptimize.length > 0) {
      console.log(`\nFound ${positionsToOptimize.length} position(s) to optimize:`);
      for (const pos of positionsToOptimize) {
        const currentRangeWidth = ((pos.priceUpper - pos.priceLower) / pos.currentPrice) * 100;
        console.log(
          `  Position ${pos.tokenId}: Range ${pos.priceLower.toFixed(2)} - ${pos.priceUpper.toFixed(2)} (${currentRangeWidth.toFixed(1)}% width)`
        );
      }
    } else {
      console.log("\nNo existing positions to close. Will open new optimized positions.");
    }

    // 3. Get current pool state for new position (always needed)
    const poolAddress = ARBITRUM_MAINNET.uniswapV3EthUsdcPool;
    const pool = createPool(poolAddress, ethers.provider);
    const poolTokens = new ethers.Contract(poolAddress, UNISWAP_POOL_ABI, ethers.provider);
    const [poolState, token0, token1] = await Promise.all([
      getPoolState(pool),
      poolTokens.token0(),
      poolTokens.token1(),
    ]);

    const token0Contract = new ethers.Contract(token0, ERC20_ABI, signer);
    const token1Contract = new ethers.Contract(token1, ERC20_ABI, signer);

    const [token0DecimalsRaw, token1DecimalsRaw, token0Symbol, token1Symbol] = await Promise.all([
      token0Contract.decimals(),
      token1Contract.decimals(),
      token0Contract.symbol(),
      token1Contract.symbol(),
    ]);
    const token0Decimals = Number(token0DecimalsRaw);
    const token1Decimals = Number(token1DecimalsRaw);

    const priceToken1PerToken0 = tickToPriceWithDecimals(
      poolState.tick,
      token0Decimals,
      token1Decimals
    );

    const isToken0Usdc = token0.toLowerCase() === ARBITRUM_MAINNET.usdc.toLowerCase();
    const isToken1Usdc = token1.toLowerCase() === ARBITRUM_MAINNET.usdc.toLowerCase();
    const isToken0Weth = token0.toLowerCase() === ARBITRUM_MAINNET.weth.toLowerCase();
    const isToken1Weth = token1.toLowerCase() === ARBITRUM_MAINNET.weth.toLowerCase();

    if (!(isToken0Usdc || isToken1Usdc) || !(isToken0Weth || isToken1Weth)) {
      throw new Error("Pool does not match WETH/USDC.");
    }

    const priceUsdcPerWeth = isToken0Weth ? priceToken1PerToken0 : 1 / priceToken1PerToken0;

    // Calculate new range bounds using configured default (centered on current price)
    const rangeWidth = options.rangeWidth ?? Number(DEFAULT_STRATEGY_CONFIG.defaultRangeWidth);
    const defaultBounds = getDefaultRangeBounds(priceUsdcPerWeth, rangeWidth);
    const lowerPrice = options.priceLower ?? Number(defaultBounds.lower.toFixed(6));
    const upperPrice = options.priceUpper ?? Number(defaultBounds.upper.toFixed(6));

    const priceLowerForTicks = isToken0Weth ? lowerPrice : 1 / lowerPrice;
    const priceUpperForTicks = isToken0Weth ? upperPrice : 1 / upperPrice;

    const tickSpacing = 10;
    const tickLower = roundTickDown(
      priceToTickWithDecimals(priceLowerForTicks, token0Decimals, token1Decimals),
      tickSpacing
    );
    const tickUpper = roundTickUp(
      priceToTickWithDecimals(priceUpperForTicks, token0Decimals, token1Decimals),
      tickSpacing
    );

    if (tickLower >= tickUpper) {
      throw new Error("Computed tickLower >= tickUpper.");
    }

    console.log("\nNew Position Configuration:");
    console.log(`  Current Price (USDC/WETH): ${priceUsdcPerWeth.toFixed(6)}`);
    console.log(
      `  Range Width: ${(rangeWidth * 100).toFixed(1)}% (±${((rangeWidth / 2) * 100).toFixed(1)}%)`
    );
    console.log(`  Price Lower: ${lowerPrice.toFixed(6)}`);
    console.log(`  Price Upper: ${upperPrice.toFixed(6)}`);
    console.log(`  Tick Lower: ${tickLower}`);
    console.log(`  Tick Upper: ${tickUpper}`);

    // 4. Check for execution flag (default: dry-run)
    const executeFlag = options.execute ?? false;

    // Get GMX position for closing and capital calculation
    const gmxReaderContract = gmxReader.createReader(ARBITRUM_MAINNET.gmxReader, ethers.provider);
    const gmxPosition = await gmxReader.getPosition(
      gmxReaderContract,
      ARBITRUM_MAINNET.gmxDataStore,
      account,
      {
        market: ARBITRUM_MAINNET.gmxEthUsdMarket,
        collateralToken: ARBITRUM_MAINNET.usdc,
        isLong: false,
      }
    );

    // 5. Execute: Close old positions and open new one
    if (!executeFlag) {
      console.log("\n[DRY RUN] Optimization would be executed:");
      console.log(`\n1. Collect fees and close ${positionsToOptimize.length} LP position(s):`);
      for (const pos of positionsToOptimize) {
        console.log(`   - Position ${pos.tokenId}: Collect fees and remove liquidity`);
      }
      if (gmxPosition && gmxPosition.numbers.sizeInUsd > 0n) {
        console.log(`\n2. Close GMX short position`);
      } else {
        console.log(`\n2. No GMX position to close`);
      }
    } else {
      console.log("\nExecuting optimization...");
    }

    // Create reader for position queries
    const reader = createPositionManager(
      ARBITRUM_MAINNET.uniswapV3PositionManager,
      ethers.provider
    );

    // Calculate what tokens we'll get back from closing positions BEFORE actually closing them
    // This is needed to properly calculate total capital
    let totalTokens0FromPositions = 0n;
    let totalTokens1FromPositions = 0n;

    if (positionsToOptimize.length > 0) {
      console.log(`\nCalculating tokens to be returned from closing positions...`);
      for (const pos of positionsToOptimize) {
        const tokenId = BigInt(pos.tokenId);
        const position = await getPosition(reader, tokenId);

        // Determine token mapping between position and pool
        const posToken0 = position.token0.toLowerCase();
        const posToken1 = position.token1.toLowerCase();
        const isPosToken0SameAsPoolToken0 = posToken0 === token0.toLowerCase();

        if (position.liquidity > 0n) {
          // Calculate what tokens we'll get back from removing liquidity
          // getAmountsForLiquidity returns amounts in pool token order (token0, token1)
          const sqrtLower = getSqrtRatioAtTick(position.tickLower);
          const sqrtUpper = getSqrtRatioAtTick(position.tickUpper);
          const { amount0, amount1 } = getAmountsForLiquidity(
            poolState.sqrtPriceX96,
            sqrtLower,
            sqrtUpper,
            position.liquidity
          );

          // amount0 and amount1 are already in pool token order (token0, token1)
          totalTokens0FromPositions += amount0;
          totalTokens1FromPositions += amount1;

          console.log(
            `  Position ${pos.tokenId}: Will return ${ethers.formatUnits(amount0, token0Decimals)} ${token0Symbol}, ${ethers.formatUnits(amount1, token1Decimals)} ${token1Symbol}`
          );
        }

        // Map unclaimed fees from position token order to pool token order
        // position.tokensOwed0/1 are in position token order
        if (isPosToken0SameAsPoolToken0) {
          totalTokens0FromPositions += position.tokensOwed0;
          totalTokens1FromPositions += position.tokensOwed1;
        } else {
          // Position tokens are swapped relative to pool
          totalTokens0FromPositions += position.tokensOwed1;
          totalTokens1FromPositions += position.tokensOwed0;
        }

        if (position.tokensOwed0 > 0n || position.tokensOwed1 > 0n) {
          // Get position token decimals for display
          const posToken0Contract = new ethers.Contract(
            position.token0,
            ERC20_ABI,
            ethers.provider
          );
          const posToken1Contract = new ethers.Contract(
            position.token1,
            ERC20_ABI,
            ethers.provider
          );
          const [posToken0Decimals, posToken1Decimals, posToken0Symbol, posToken1Symbol] =
            await Promise.all([
              posToken0Contract.decimals(),
              posToken1Contract.decimals(),
              posToken0Contract.symbol(),
              posToken1Contract.symbol(),
            ]);

          console.log(
            `  Position ${pos.tokenId}: Unclaimed fees ${ethers.formatUnits(position.tokensOwed0, Number(posToken0Decimals))} ${posToken0Symbol}, ${ethers.formatUnits(position.tokensOwed1, Number(posToken1Decimals))} ${posToken1Symbol}`
          );
        }
      }
    } else {
      console.log(`\nNo positions to close - using current wallet balances.`);
    }

    // Get current wallet balances
    const [currentBalance0, currentBalance1] = await Promise.all([
      token0Contract.balanceOf(account),
      token1Contract.balanceOf(account),
    ]);

    // Total available = current wallet balance + what we'll get from closing positions
    const totalAvailable0 = currentBalance0 + totalTokens0FromPositions;
    const totalAvailable1 = currentBalance1 + totalTokens1FromPositions;

    console.log(`\nCurrent wallet balances:`);
    console.log(`  ${token0Symbol}: ${ethers.formatUnits(currentBalance0, token0Decimals)}`);
    console.log(`  ${token1Symbol}: ${ethers.formatUnits(currentBalance1, token1Decimals)}`);

    console.log(`\nTokens from closing positions:`);
    console.log(
      `  ${token0Symbol}: ${ethers.formatUnits(totalTokens0FromPositions, token0Decimals)}`
    );
    console.log(
      `  ${token1Symbol}: ${ethers.formatUnits(totalTokens1FromPositions, token1Decimals)}`
    );

    console.log(`\nTotal available tokens after closing positions:`);
    console.log(`  ${token0Symbol}: ${ethers.formatUnits(totalAvailable0, token0Decimals)}`);
    console.log(`  ${token1Symbol}: ${ethers.formatUnits(totalAvailable1, token1Decimals)}`);

    // Note: We'll check total capital later - don't return early here
    // Even if no tokens from positions, we might have wallet balance or GMX collateral

    // Close positions using shared close function
    // Note: We calculate tokens before closing (above) so we can plan the new position
    // The closePositions function handles the actual closing logic
    // Create database instance for recording fee collections (will be reused later for optimization recording)
    const db = new MonitoringDatabase();

    // Track transaction receipts for gas cost calculation
    const transactionReceipts: Array<{ gasUsed: bigint; gasPrice: bigint }> = [];

    const closeResult = await closePositions(
      account,
      signer,
      positionsToOptimize.map((pos) => ({ tokenId: pos.tokenId, liquidity: pos.liquidity })),
      gmxPosition || null,
      executeFlag,
      monitorConfig,
      db
    );
    if (executeFlag) {
      await refreshNonce(signer.provider, account);
    }

    // Get actual balances after closing (for execution path)
    // For dry-run, we use the calculated totals above
    let balance0 = totalAvailable0;
    let balance1 = totalAvailable1;

    if (executeFlag) {
      const [newBalance0, newBalance1] = await Promise.all([
        token0Contract.balanceOf(account),
        token1Contract.balanceOf(account),
      ]);
      balance0 = newBalance0;
      balance1 = newBalance1;
      console.log(`\nActual balances after closing positions:`);
      console.log(`  ${token0Symbol}: ${ethers.formatUnits(balance0, token0Decimals)}`);
      console.log(`  ${token1Symbol}: ${ethers.formatUnits(balance1, token1Decimals)}`);
    }

    // Calculate total capital value in USD
    // Include GMX collateral that will be returned (if GMX position exists and we're in dry-run)
    let gmxCollateralToAdd = 0n;
    if (!executeFlag && gmxPosition && gmxPosition.numbers.collateralAmount > 0n) {
      // In dry-run, add GMX collateral to total capital since it will be returned
      gmxCollateralToAdd =
        (gmxPosition.numbers.collateralAmount * PRECISION.GMX_USD) / BigInt(10 ** 6);
      console.log(
        `\nGMX collateral to be returned: $${ethers.formatUnits(gmxCollateralToAdd, 30)} (included in total capital)`
      );
    }

    const wethBalance = isToken0Weth ? balance0 : balance1;
    const usdcBalance = isToken0Usdc ? balance0 : balance1;
    const wethDecimals = isToken0Weth ? token0Decimals : token1Decimals;
    const usdcDecimals = isToken0Usdc ? token0Decimals : token1Decimals;

    const wethValueUsd = Number(ethers.formatUnits(wethBalance, wethDecimals)) * priceUsdcPerWeth;
    const usdcValueUsd = Number(ethers.formatUnits(usdcBalance, usdcDecimals));
    const totalCapitalUsd =
      (BigInt(Math.floor(wethValueUsd * 1e6)) * PRECISION.GMX_USD) / BigInt(10 ** 6) +
      (BigInt(Math.floor(usdcValueUsd * 1e6)) * PRECISION.GMX_USD) / BigInt(10 ** 6) +
      gmxCollateralToAdd;

    console.log(`\nTotal capital: $${ethers.formatUnits(totalCapitalUsd, 30)}`);
    console.log(`Max position size: $${ethers.formatUnits(monitorConfig.maxPositionSizeUsd, 30)}`);

    // Check if we have sufficient capital
    if (totalCapitalUsd === 0n) {
      console.error("No capital available to create positions.");
      return { feesCollectedUsd: 0n };
    }

    // Calculate optimal allocation between LP and GMX hedge
    console.log(`\nCalculating optimal allocation...`);
    const allocation = calculateOptimalAllocation(
      totalCapitalUsd,
      monitorConfig.maxPositionSizeUsd,
      priceUsdcPerWeth,
      lowerPrice,
      upperPrice,
      monitorConfig.targetLeverage,
      1.0 // USDC price
    );

    console.log(`  LP size: $${ethers.formatUnits(allocation.lpSizeUsd, 30)}`);
    console.log(`  GMX short size: $${ethers.formatUnits(allocation.gmxShortSizeUsd, 30)}`);
    console.log(`  GMX collateral: $${ethers.formatUnits(allocation.gmxCollateralUsd, 30)}`);
    console.log(`  Total capital used: $${ethers.formatUnits(allocation.totalCapitalUsd, 30)}`);

    // Calculate token amounts for LP position
    const { wethAmount, usdcAmount } = calculateLpTokenAmounts(
      allocation.lpSizeUsd,
      priceUsdcPerWeth,
      lowerPrice,
      upperPrice,
      wethDecimals,
      usdcDecimals
    );

    console.log(`\nLP token amounts:`);
    console.log(`  WETH: ${ethers.formatUnits(wethAmount, wethDecimals)}`);
    console.log(`  USDC: ${ethers.formatUnits(usdcAmount, usdcDecimals)}`);

    // Calculate GMX collateral requirement if we're opening a GMX position
    let gmxCollateralAmount = 0n;
    if (allocation.gmxShortSizeUsd > 0n) {
      // Create a temporary RebalanceManager to calculate collateral
      const gmxRouter = gmxOrders.createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer);
      const usdcContractForGmx = new ethers.Contract(ARBITRUM_MAINNET.usdc, ERC20_ABI, signer);
      const rebalanceManager = new RebalanceManager(
        gmxRouter as any,
        usdcContractForGmx as any,
        monitorConfig,
        {
          account,
          market: ARBITRUM_MAINNET.gmxEthUsdMarket,
          collateralTokenAddress: ARBITRUM_MAINNET.usdc,
          orderVault: ARBITRUM_MAINNET.gmxOrderVault,
        }
      );
      const { amount: collateralAmount } = rebalanceManager.calculateRequiredCollateral(
        allocation.gmxShortSizeUsd,
        1.0, // USDC price
        6 // USDC decimals
      );
      gmxCollateralAmount = collateralAmount;
      console.log(`  GMX collateral needed: ${ethers.formatUnits(gmxCollateralAmount, 6)} USDC`);
    }

    // Check if we have enough tokens, swap if needed
    // Account for both LP and GMX collateral requirements
    const wethNeeded = wethAmount; // Only LP needs WETH
    const usdcNeeded = usdcAmount + gmxCollateralAmount; // LP + GMX collateral
    const wethAvailable = wethBalance;
    const usdcAvailable = usdcBalance;

    const wethShortfall = wethNeeded > wethAvailable ? wethNeeded - wethAvailable : 0n;
    const usdcShortfall = usdcNeeded > usdcAvailable ? usdcNeeded - usdcAvailable : 0n;

    // Swap tokens if needed to achieve target amounts
    const swapRouter = new ethers.Contract(
      ARBITRUM_MAINNET.uniswapV3SwapRouter,
      UNISWAP_ROUTER_ABI,
      signer
    );
    const quoter = new ethers.Contract(
      ARBITRUM_MAINNET.uniswapV3Quoter,
      UNISWAP_QUOTER_ABI,
      signer
    );
    const wethToken = isToken0Weth ? token0 : token1;
    const usdcToken = isToken0Usdc ? token0 : token1;
    const wethContract = isToken0Weth ? token0Contract : token1Contract;
    const usdcContract = isToken0Usdc ? token0Contract : token1Contract;
    const fee = 500; // 0.05% fee tier
    const slippageBps = options.slippageBps ?? 50n; // 0.5% slippage

    let finalBalance0 = balance0;
    let finalBalance1 = balance1;

    // If we need more WETH, swap USDC for WETH
    if (wethShortfall > 0n && executeFlag) {
      const wethShortfallNum = Number(ethers.formatUnits(wethShortfall, wethDecimals));
      const usdcNeededNum = wethShortfallNum * priceUsdcPerWeth;
      const usdcToSwap = ethers.parseUnits(
        (usdcNeededNum * 1.01).toFixed(usdcDecimals),
        usdcDecimals
      ); // Add 1% buffer

      const minSwapAmount = ethers.parseUnits("1", usdcDecimals);

      if (usdcAvailable >= usdcToSwap && usdcToSwap >= minSwapAmount) {
        const amountIn = usdcToSwap > usdcAvailable ? usdcAvailable : usdcToSwap;
        console.log(`\nSwapping ${ethers.formatUnits(amountIn, usdcDecimals)} USDC for WETH...`);

        await swapTokenToToken({
          account,
          tokenIn: usdcToken,
          tokenOut: wethToken,
          amountIn,
          contractIn: usdcContract,
          swapRouter,
          routerAddress: ARBITRUM_MAINNET.uniswapV3SwapRouter,
          quoter,
          fee,
          slippageBps,
          signer,
          refreshNonceFn: refreshNonce,
          transactionReceipts,
          executeFlag,
          logPrefix: "  ",
        });

        const [newBalance0, newBalance1] = await Promise.all([
          token0Contract.balanceOf(account),
          token1Contract.balanceOf(account),
        ]);
        finalBalance0 = newBalance0;
        finalBalance1 = newBalance1;
      }
    }
    // If we need more USDC, swap WETH for USDC
    else if (usdcShortfall > 0n && executeFlag) {
      const usdcShortfallNum = Number(ethers.formatUnits(usdcShortfall, usdcDecimals));
      const wethNeededNum = usdcShortfallNum / priceUsdcPerWeth;
      const wethToSwap = ethers.parseUnits(
        (wethNeededNum * 1.01).toFixed(wethDecimals),
        wethDecimals
      ); // Add 1% buffer

      const minSwapAmount = ethers.parseUnits("0.0001", wethDecimals);
      const excessWeth = wethAvailable - wethNeeded;

      if (excessWeth >= wethToSwap && wethToSwap >= minSwapAmount) {
        const amountIn = wethToSwap > excessWeth ? excessWeth : wethToSwap;
        console.log(`\nSwapping ${ethers.formatUnits(amountIn, wethDecimals)} WETH for USDC...`);

        await swapTokenToToken({
          account,
          tokenIn: wethToken,
          tokenOut: usdcToken,
          amountIn,
          contractIn: wethContract,
          swapRouter,
          routerAddress: ARBITRUM_MAINNET.uniswapV3SwapRouter,
          quoter,
          fee,
          slippageBps,
          signer,
          refreshNonceFn: refreshNonce,
          transactionReceipts,
          executeFlag,
          logPrefix: "  ",
        });

        const [newBalance0, newBalance1] = await Promise.all([
          token0Contract.balanceOf(account),
          token1Contract.balanceOf(account),
        ]);
        finalBalance0 = newBalance0;
        finalBalance1 = newBalance1;
      } else {
        if (wethToSwap < minSwapAmount) {
          console.log(
            `\nSkipping WETH->USDC swap: amount ${ethers.formatUnits(wethToSwap, wethDecimals)} WETH below minimum ${ethers.formatUnits(minSwapAmount, wethDecimals)} WETH`
          );
        } else {
          console.log(
            `\nSkipping WETH->USDC swap: insufficient excess WETH (have ${ethers.formatUnits(excessWeth, wethDecimals)} excess, need ${ethers.formatUnits(wethToSwap, wethDecimals)})`
          );
        }
      }
    } else if (!executeFlag) {
      if (wethShortfall > 0n) {
        console.log(`\nWould swap USDC for WETH to cover shortfall`);
      } else if (usdcShortfall > 0n) {
        console.log(
          `\nWould swap WETH for USDC to cover shortfall (${ethers.formatUnits(usdcShortfall, usdcDecimals)} USDC needed)`
        );
      } else {
        console.log(
          `\nToken amounts are sufficient for LP position${gmxCollateralAmount > 0n ? " and GMX collateral" : ""}.`
        );
      }
    }

    // Get final balances after swap (if executing)
    if (executeFlag) {
      const [newBalance0, newBalance1] = await Promise.all([
        token0Contract.balanceOf(account),
        token1Contract.balanceOf(account),
      ]);
      finalBalance0 = newBalance0;
      finalBalance1 = newBalance1;
    } else {
      // For dry-run, use the calculated totals
      finalBalance0 = balance0;
      finalBalance1 = balance1;
    }

    // Use calculated amounts (may need to adjust if swaps didn't complete perfectly)
    const amount0Desired = isToken0Weth ? wethAmount : usdcAmount;
    const amount1Desired = isToken1Weth ? wethAmount : usdcAmount;

    // Cap to available balances
    const finalAmount0 = amount0Desired > finalBalance0 ? finalBalance0 : amount0Desired;
    const finalAmount1 = amount1Desired > finalBalance1 ? finalBalance1 : amount1Desired;

    console.log(`\nFinal token amounts for LP position:`);
    console.log(`  ${token0Symbol}: ${ethers.formatUnits(finalAmount0, token0Decimals)}`);
    console.log(`  ${token1Symbol}: ${ethers.formatUnits(finalAmount1, token1Decimals)}`);

    // Open new LP position and GMX hedge
    if (executeFlag) {
      // Check if we have non-zero amounts to mint
      if (finalAmount0 === 0n && finalAmount1 === 0n) {
        console.warn(
          "⚠️  Warning: Both finalAmount0 and finalAmount1 are 0. Skipping LP minting to avoid revert."
        );
        // We can still proceed with GMX hedge if applicable, or just return
        if (allocation.gmxShortSizeUsd === 0n) {
          return { feesCollectedUsd: closeResult.totalFeesCollectedUsd };
        }
      }

      console.log(`\nOpening new LP position...`);
      console.log(`  Minting params:`, {
        token0,
        token1,
        fee: 500,
        tickLower,
        tickUpper,
        amount0Desired: finalAmount0.toString(),
        amount1Desired: finalAmount1.toString(),
        recipient: account,
      });

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const positionManager = ARBITRUM_MAINNET.uniswapV3PositionManager;

      // Calculate GMX collateral requirement if we're opening a GMX position
      let gmxCollateralAmount = 0n;
      if (allocation.gmxShortSizeUsd > 0n) {
        // Create a temporary RebalanceManager to calculate collateral
        // We need to create the router and token contracts, but we can use a minimal config
        const gmxRouter = gmxOrders.createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer);
        const usdcContractForGmx = new ethers.Contract(ARBITRUM_MAINNET.usdc, ERC20_ABI, signer);
        const rebalanceManager = new RebalanceManager(
          gmxRouter as any,
          usdcContractForGmx as any,
          monitorConfig,
          {
            account,
            market: ARBITRUM_MAINNET.gmxEthUsdMarket,
            collateralTokenAddress: ARBITRUM_MAINNET.usdc,
            orderVault: ARBITRUM_MAINNET.gmxOrderVault,
          }
        );
        const { amount: collateralAmount } = rebalanceManager.calculateRequiredCollateral(
          allocation.gmxShortSizeUsd,
          1.0, // USDC price
          6 // USDC decimals
        );
        gmxCollateralAmount = collateralAmount;
      }

      let mintResult: { txHash?: string } = {};

      if (finalAmount0 > 0n || finalAmount1 > 0n) {
        // Verify balances before proceeding - must account for both LP and GMX collateral
        const [currentBalance0, currentBalance1, allowance0, allowance1] = await Promise.all([
          token0Contract.balanceOf(account),
          token1Contract.balanceOf(account),
          token0Contract.allowance(account, positionManager),
          token1Contract.allowance(account, positionManager),
        ]);

        // Calculate total USDC needed (LP + GMX collateral)
        const usdcForLp = isToken0Usdc ? finalAmount0 : finalAmount1;
        const totalUsdcNeeded = usdcForLp + gmxCollateralAmount;

        // Calculate total WETH needed (only for LP, GMX uses USDC collateral)
        const wethForLp = isToken0Weth ? finalAmount0 : finalAmount1;
        const totalWethNeeded = wethForLp;

        console.log(`  Current balances:`);
        console.log(`    ${token0Symbol}: ${ethers.formatUnits(currentBalance0, token0Decimals)}`);
        console.log(`    ${token1Symbol}: ${ethers.formatUnits(currentBalance1, token1Decimals)}`);
        console.log(`  Required amounts for LP:`);
        console.log(`    ${token0Symbol}: ${ethers.formatUnits(finalAmount0, token0Decimals)}`);
        console.log(`    ${token1Symbol}: ${ethers.formatUnits(finalAmount1, token1Decimals)}`);
        if (gmxCollateralAmount > 0n) {
          console.log(
            `  Required USDC for GMX collateral: ${ethers.formatUnits(gmxCollateralAmount, 6)}`
          );
          console.log(
            `  Total USDC needed (LP + GMX): ${ethers.formatUnits(totalUsdcNeeded, isToken0Usdc ? token0Decimals : token1Decimals)}`
          );
        }

        // Check balances accounting for both LP and GMX requirements
        const currentWeth = isToken0Weth ? currentBalance0 : currentBalance1;
        const currentUsdc = isToken0Usdc ? currentBalance0 : currentBalance1;
        const usdcDecimalsForCheck = isToken0Usdc ? token0Decimals : token1Decimals;

        // Both usdcForLp and gmxCollateralAmount should be in 6 decimals (USDC)
        // But usdcForLp might be in token0/token1 decimals, so normalize gmxCollateralAmount
        // to match usdcForLp's decimals for the comparison
        const gmxCollateralNormalized =
          usdcDecimalsForCheck === 6
            ? gmxCollateralAmount
            : gmxCollateralAmount * 10n ** BigInt(usdcDecimalsForCheck - 6);
        const totalUsdcNeededNormalized = usdcForLp + gmxCollateralNormalized;

        if (currentWeth < totalWethNeeded) {
          throw new Error(
            `Insufficient WETH balance: have ${ethers.formatUnits(currentWeth, wethDecimals)}, need ${ethers.formatUnits(totalWethNeeded, wethDecimals)} for LP position`
          );
        }
        if (currentUsdc < totalUsdcNeededNormalized) {
          throw new Error(
            `Insufficient USDC balance: have ${ethers.formatUnits(currentUsdc, usdcDecimalsForCheck)}, need ${ethers.formatUnits(totalUsdcNeededNormalized, usdcDecimalsForCheck)} (${ethers.formatUnits(usdcForLp, usdcDecimalsForCheck)} for LP + ${ethers.formatUnits(gmxCollateralAmount, 6)} for GMX collateral)`
          );
        }

        // Check and approve if needed - approve MAX_UINT256 to avoid re-approvals
        const MAX_UINT256 = ethers.MaxUint256;
        if (allowance0 < finalAmount0 && finalAmount0 > 0n) {
          console.log(`  Approving ${token0Symbol}...`);
          // Let ethers manage nonce automatically
          const approval = await token0Contract.approve(positionManager, MAX_UINT256);
          // CRITICAL: Wait for approval before proceeding
          const receipt = await approval.wait();

          // Verify transaction didn't revert
          if (receipt.status !== 1) {
            throw new Error(`Approval transaction reverted for ${token0Symbol}`);
          }
          if (executeFlag && receipt && receipt.gasUsed && receipt.gasPrice) {
            transactionReceipts.push({
              gasUsed: receipt.gasUsed,
              gasPrice: receipt.gasPrice,
            });
          }

          // Verify approval succeeded - check with a small delay to ensure state is updated
          await new Promise((resolve) => setTimeout(resolve, 500));
          const newAllowance0 = await token0Contract.allowance(account, positionManager);
          if (newAllowance0 < finalAmount0) {
            throw new Error(
              `Approval failed for ${token0Symbol}: allowance is ${ethers.formatUnits(newAllowance0, token0Decimals)}, need ${ethers.formatUnits(finalAmount0, token0Decimals)}`
            );
          }
          console.log(
            `  ✓ Approved ${token0Symbol}: ${ethers.formatUnits(newAllowance0, token0Decimals)}`
          );
          await refreshNonce(signer.provider, account);
        }
        if (allowance1 < finalAmount1 && finalAmount1 > 0n) {
          console.log(`  Approving ${token1Symbol}...`);
          // Let ethers manage nonce automatically
          const approval = await token1Contract.approve(positionManager, MAX_UINT256);
          // CRITICAL: Wait for approval before proceeding
          const receipt = await approval.wait();

          // Verify transaction didn't revert
          if (receipt.status !== 1) {
            throw new Error(`Approval transaction reverted for ${token1Symbol}`);
          }
          if (executeFlag && receipt && receipt.gasUsed && receipt.gasPrice) {
            transactionReceipts.push({
              gasUsed: receipt.gasUsed,
              gasPrice: receipt.gasPrice,
            });
          }

          // Verify approval succeeded - check with a small delay to ensure state is updated
          await new Promise((resolve) => setTimeout(resolve, 500));
          const newAllowance1 = await token1Contract.allowance(account, positionManager);
          if (newAllowance1 < finalAmount1) {
            throw new Error(
              `Approval failed for ${token1Symbol}: allowance is ${ethers.formatUnits(newAllowance1, token1Decimals)}, need ${ethers.formatUnits(finalAmount1, token1Decimals)}`
            );
          }
          console.log(
            `  ✓ Approved ${token1Symbol}: ${ethers.formatUnits(newAllowance1, token1Decimals)}`
          );
          await refreshNonce(signer.provider, account);
        }

        console.log(`  Minting LP position...`);

        // Create position manager for minting
        const manager = createPositionManagerWriter(
          ARBITRUM_MAINNET.uniswapV3PositionManager,
          signer
        );

        // Let ethers manage nonce automatically - no manual nonce management
        const actualMintResult = await mintPosition(
          manager,
          token0Contract as unknown as UniswapIERC20,
          token1Contract as unknown as UniswapIERC20,
          {
            token0,
            token1,
            fee: 500, // 0.05% fee tier
            tickLower,
            tickUpper,
            amount0Desired: finalAmount0,
            amount1Desired: finalAmount1,
            amount0Min: 0n,
            amount1Min: 0n,
            recipient: account,
            deadline,
          },
          {
            owner: account,
            spender: positionManager,
            performApproval: false,
          }
        );

        mintResult = actualMintResult;

        if (mintResult.txHash) {
          console.log(`  LP position minted. Tx: ${mintResult.txHash}`);
          // Transaction already waited for receipt (always waits)
          console.log(`  LP position confirmed`);
          // Get receipt for gas cost tracking
          if (executeFlag && signer.provider) {
            try {
              const mintReceipt = await signer.provider.getTransactionReceipt(mintResult.txHash);
              if (mintReceipt && mintReceipt.gasUsed && mintReceipt.gasPrice) {
                transactionReceipts.push({
                  gasUsed: mintReceipt.gasUsed,
                  gasPrice: mintReceipt.gasPrice,
                });
              }
            } catch (error) {
              // Receipt might not be available yet, that's okay
            }
          }
        }
      } else {
        console.log("  Skipping minting because token amounts are 0");
      }

      // Open GMX hedge position
      let gmxResult: { txHash?: string; tx?: any } | undefined;
      if (allocation.gmxShortSizeUsd > 0n) {
        console.log(`\nOpening GMX short hedge...`);
        console.log(`  Short size: $${ethers.formatUnits(allocation.gmxShortSizeUsd, 30)}`);
        console.log(`  Collateral: $${ethers.formatUnits(allocation.gmxCollateralUsd, 30)}`);

        // Get prices for GMX order
        const prices = await fetchTokenPrices(ARBITRUM_MAINNET.gmxPriceApi);
        const wethPriceData = findTokenPrice(prices, ARBITRUM_MAINNET.weth);
        const wethPrice30 = scalePriceTo30(averagePrice(wethPriceData), 18);

        // Calculate collateral amount
        const rebalanceManager = new RebalanceManager(
          gmxOrders.createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer),
          new ethers.Contract(ARBITRUM_MAINNET.usdc, ERC20_ABI, signer) as any,
          monitorConfig,
          {
            account,
            market: ARBITRUM_MAINNET.gmxEthUsdMarket,
            collateralTokenAddress: ARBITRUM_MAINNET.usdc,
            orderVault: ARBITRUM_MAINNET.gmxOrderVault,
          }
        );

        const { amount: collateralAmount } = rebalanceManager.calculateRequiredCollateral(
          allocation.gmxShortSizeUsd,
          1.0, // USDC price
          6 // USDC decimals
        );

        // Get acceptable price
        const priceResult = await getLatestPrice(
          ARBITRUM_MAINNET.chainlinkEthUsdFeed,
          ethers.provider,
          {
            outputDecimals: 12,
            maxStaleSeconds: 3600,
          }
        );

        if (!priceResult.outputPrice) {
          throw new Error("Missing output price for GMX order");
        }

        // Acceptable price: current - max slippage (for opening short, we're selling)
        // Use maxSlippage from config (default 1%) for acceptable price tolerance
        // Convert maxSlippage to basis points: 0.01 = 1% = 100 bps
        const slippageBps = BigInt(Math.round(monitorConfig.maxSlippage * 10000));
        const slippageFactor = 10000n - slippageBps;
        const acceptablePrice = (priceResult.outputPrice * slippageFactor) / 10000n;

        console.log(
          `  Acceptable price: ${ethers.formatUnits(acceptablePrice, 12)} (${monitorConfig.maxSlippage * 100}% slippage tolerance)`
        );

        // Approve USDC for GMX
        const usdcContractForGmx = new ethers.Contract(ARBITRUM_MAINNET.usdc, ERC20_ABI, signer);
        const usdcAllowance = await usdcContractForGmx.allowance(
          account,
          ARBITRUM_MAINNET.gmxExchangeRouter
        );
        if (usdcAllowance < collateralAmount) {
          console.log(`  Approving USDC for GMX...`);
          // Let ethers manage nonce automatically
          const approval = await usdcContractForGmx.approve(
            ARBITRUM_MAINNET.gmxExchangeRouter,
            ethers.MaxUint256
          );
          // CRITICAL: Wait for approval before proceeding
          await approval.wait();
          await refreshNonce(signer.provider, account);
        }

        // Let ethers manage nonce automatically - no manual nonce management
        const gmxRouter = gmxOrders.createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer);
        gmxResult = await gmxOrders.createIncreaseOrder(
          gmxRouter,
          usdcContractForGmx as any,
          {
            account,
            market: ARBITRUM_MAINNET.gmxEthUsdMarket,
            collateralToken: ARBITRUM_MAINNET.usdc,
            sizeDeltaUsd: allocation.gmxShortSizeUsd,
            collateralAmount,
            acceptablePrice,
            executionFee: monitorConfig.defaultExecutionFee,
            isLong: false,
          },
          {
            orderVault: ARBITRUM_MAINNET.gmxOrderVault,
          }
        );

        console.log(`  GMX short order created. Tx: ${gmxResult.txHash}`);
        // CRITICAL: Wait for GMX transaction confirmation before proceeding
        if (gmxResult.tx) {
          const gmxReceipt = await gmxResult.tx.wait();
          console.log(`  GMX order confirmed in block ${(gmxReceipt as any).blockNumber}`);
          if (
            executeFlag &&
            gmxReceipt &&
            (gmxReceipt as any).gasUsed &&
            (gmxReceipt as any).gasPrice
          ) {
            transactionReceipts.push({
              gasUsed: (gmxReceipt as any).gasUsed,
              gasPrice: (gmxReceipt as any).gasPrice,
            });
          }
        } else {
          throw new Error("GMX order transaction was not returned - cannot proceed safely");
        }
      }

      // Sweep idle WETH to USDC after positions are open
      const wethDustThreshold = ethers.parseUnits("0.0001", wethDecimals);
      console.log(`\nSweeping idle WETH to USDC...`);
      try {
        const sweepResult = await sweepIdleWethToUsdc({
          account,
          wethContract: wethContract as unknown as SweepWethContract,
          swapRouter: swapRouter as unknown as SweepSwapRouter,
          quoter: quoter as unknown as SweepQuoter,
          wethToken,
          usdcToken,
          fee,
          slippageBps,
          dustThreshold: wethDustThreshold,
          refreshNonce,
          provider: signer.provider,
          transactionReceipts,
        });

        if (sweepResult) {
          console.log(
            `  Swept ${ethers.formatUnits(sweepResult.amountIn, wethDecimals)} WETH for USDC (min ${ethers.formatUnits(sweepResult.amountOutMin, usdcDecimals)} USDC)`
          );
        } else {
          console.log(`  No idle WETH above dust threshold.`);
        }
      } catch (error: any) {
        const errorMsg = error.reason || error.message || String(error);
        console.warn(`  Warning: WETH sweep failed (${errorMsg}). Continuing.`);
      }

      console.log(`\n✅ Optimization complete!`);
      console.log(`  LP position: ${mintResult.txHash || "minted"}`);
      if (allocation.gmxShortSizeUsd > 0n) {
        console.log(
          `  GMX hedge: ${allocation.gmxShortSizeUsd > 0n ? "order created" : "skipped"}`
        );
      }

      // Record optimization in database using StateManager
      // Reuse the database instance created earlier for fee recording
      // Use actual fees collected from closing positions
      const totalFeesUsd = closeResult.totalFeesCollectedUsd;
      let totalGasCostUsd = 0n;
      let gmxExecutionFeeUsd = 0n;
      let dbClosed = false;
      try {
        const stateManager = new StateManager(db);

        const benefitUsd = totalFeesUsd; // Simplified - could calculate more accurately

        // Track actual gas costs from transaction receipts
        // Get ETH price for USD conversion
        const ethPriceResult = await getLatestPrice(
          ARBITRUM_MAINNET.chainlinkEthUsdFeed,
          signer.provider!,
          { outputDecimals: 12, maxStaleSeconds: 3600 }
        );
        const ethPriceUsd = ethPriceResult.outputPrice
          ? Number(ethers.formatUnits(ethPriceResult.outputPrice, 12))
          : 3000;

        // Calculate total gas cost from transaction receipts
        let totalGasCostWei = 0n;
        for (const receipt of transactionReceipts) {
          totalGasCostWei += receipt.gasUsed * receipt.gasPrice;
        }

        // Convert gas cost to USD (30 decimals)
        // gasCostWei is in wei, ethPriceUsd is in USD per ETH
        // We need: (gasCostWei / 1e18) * ethPriceUsd * 1e30
        const gasCostEth = Number(ethers.formatEther(totalGasCostWei));
        const gasCostUsdFloat = gasCostEth * ethPriceUsd;
        totalGasCostUsd = ethers.parseUnits(gasCostUsdFloat.toFixed(18), 30);

        // GMX execution fee: ~0.00011 ETH (net after refund)
        // This is the actual cost, not the full execution fee sent
        const gmxExecutionFeeEth = ethers.parseEther("0.00011");
        gmxExecutionFeeUsd = ethers.parseUnits(
          (Number(ethers.formatEther(gmxExecutionFeeEth)) * ethPriceUsd).toFixed(18),
          30
        );

        // Only add GMX execution fee if we actually created a GMX order
        const actualGmxExecutionFeeUsd = allocation.gmxShortSizeUsd > 0n ? gmxExecutionFeeUsd : 0n;

        // Record optimization operation via StateManager (tracks operation history and metrics)
        await stateManager.recordOperation(
          account,
          "optimization",
          totalGasCostUsd,
          {
            deltaDrift: status.deltaDrift,
            totalFeesUsd: totalFeesUsd.toString(),
            benefitUsd: benefitUsd.toString(),
            anyOutOfRange: recommendation.data?.anyOutOfRange || false,
          },
          actualGmxExecutionFeeUsd
        );

        // Also record in optimization_history table for backward compatibility
        // Use total costs (gas + GMX execution fee) for gas_cost_usd field
        db.recordOptimization(
          account,
          status.deltaDrift,
          totalFeesUsd,
          totalGasCostUsd + actualGmxExecutionFeeUsd,
          benefitUsd
        );

        // Update fees collected metric if fees were collected
        if (totalFeesUsd > 0n) {
          const metrics = await stateManager.getMetrics(account);
          await stateManager.updateMetrics(account, {
            totalFeesCollected: metrics.totalFeesCollected + totalFeesUsd,
          });
        }

        console.log(`  Optimization recorded in database`);
      } catch (error) {
        console.warn(`  Warning: Failed to record optimization in database: ${error}`);
      }

      // Send success alert to Discord
      if (!options.suppressAlert) {
        try {
          // Fetch APR metrics
          let apr1d: number | undefined;
          let apr7d: number | undefined;
          try {
            const metrics = await getAPRMetrics(db, account);
            apr1d = metrics.rolling1d?.aprPercent;
            apr7d = metrics.rolling7d?.aprPercent;
          } catch (error) {
            console.warn("Failed to fetch APR metrics for alert", error);
          }

          // Get updated wallet balances
          const [balance0, balance1, nativeEthBalance] = await Promise.all([
            token0Contract.balanceOf(account),
            token1Contract.balanceOf(account),
            signer.provider!.getBalance(account),
          ]);
          const balance0Str = `${ethers.formatUnits(balance0, token0Decimals)} ${token0Symbol}`;
          const balance1Str = `${ethers.formatUnits(balance1, token1Decimals)} ${token1Symbol}`;
          const balanceEthStr = `${ethers.formatEther(nativeEthBalance)} ETH`;

          // Calculate total NAV
          // Use current prices and balances
          const ethPriceResult = await getLatestPrice(
            ARBITRUM_MAINNET.chainlinkEthUsdFeed,
            signer.provider!,
            { outputDecimals: 12, maxStaleSeconds: 3600 }
          );
          const ethPriceUsd = ethPriceResult.outputPrice
            ? Number(ethers.formatUnits(ethPriceResult.outputPrice, 12))
            : 3000;

          // Simplified NAV calculation for the alert (just LP + GMX capital)
          // For a precise NAV we'd need the full monitor check, but this is sufficient for the alert context
          const lpValueUsd = allocation.lpSizeUsd;
          const gmxValueUsd = allocation.gmxCollateralUsd; // Approx net value
          const totalNavUsd = lpValueUsd + gmxValueUsd;

          const fields: Array<{ name: string; value: string; inline?: boolean }> = [
            {
              name: "Total NAV",
              value: `$${parseFloat(ethers.formatUnits(totalNavUsd, 30)).toFixed(4)}`,
              inline: true,
            },
            {
              name: "Delta Drift Before",
              value: `${(status.deltaDrift * 100).toFixed(2)}% (${status.netDelta > 0n ? "under" : "over"}-hedged)`,
              inline: true,
            },
            {
              name: "Fees Collected",
              value: `$${parseFloat(ethers.formatUnits(totalFeesUsd, 30)).toFixed(4)}`,
              inline: true,
            },
          ];

          if (apr1d !== undefined) {
            fields.push({ name: "1d APR", value: `${apr1d.toFixed(2)}%`, inline: true });
          }
          if (apr7d !== undefined) {
            fields.push({ name: "7d APR", value: `${apr7d.toFixed(2)}%`, inline: true });
          }

          fields.push({
            name: "Wallet Balances",
            value: `${balance0Str}\n${balance1Str}\n${balanceEthStr}`,
            inline: false,
          });

          await sendSuccessAlert("✅ Harmonia : Optimized", "", fields);
        } catch (alertError) {
          // Don't fail optimization if alert fails
          console.warn("Failed to send Discord alert:", alertError);
        }
      }
      // Close database instance after alerts (APR metrics uses db)
      if (!dbClosed) {
        try {
          db.close();
        } finally {
          dbClosed = true;
        }
      }

      // Return fees collected from execution
      return {
        feesCollectedUsd: totalFeesUsd,
      };
    } else {
      console.log(`\n3. Open new LP position:`);
      console.log(`   - Range: ${lowerPrice.toFixed(6)} - ${upperPrice.toFixed(6)}`);
      console.log(`   - Ticks: ${tickLower} - ${tickUpper}`);
      console.log(`   - LP size: $${ethers.formatUnits(allocation.lpSizeUsd, 30)}`);
      console.log(
        `   - Token amounts: ${ethers.formatUnits(wethAmount, wethDecimals)} WETH, ${ethers.formatUnits(usdcAmount, usdcDecimals)} USDC`
      );
      console.log(`\n4. Open GMX short hedge:`);
      console.log(`   - Short size: $${ethers.formatUnits(allocation.gmxShortSizeUsd, 30)}`);
      console.log(`   - Collateral: $${ethers.formatUnits(allocation.gmxCollateralUsd, 30)}`);
      console.log(
        `   - Total capital used: $${ethers.formatUnits(allocation.totalCapitalUsd, 30)}`
      );
      const currentWethBalance = isToken0Weth ? balance0 : balance1;
      const estimatedIdleWeth =
        currentWethBalance > wethAmount ? currentWethBalance - wethAmount : 0n;
      const wethDustThreshold = ethers.parseUnits("0.0001", wethDecimals);
      console.log(`\n5. Sweep remaining WETH to USDC:`);
      console.log(
        `   - Estimated idle WETH: ${ethers.formatUnits(estimatedIdleWeth, wethDecimals)}`
      );
      console.log(
        `   - Action: ${estimatedIdleWeth > wethDustThreshold ? "Convert to USDC to remove price exposure" : "Skip (below dust threshold)"}`
      );
      console.log("\nTo execute, run with --execute flag");
      // Return 0 for dry-run
      return { feesCollectedUsd: 0n };
    }
  } catch (error: any) {
    console.error("\nError during optimization:");
    console.error(error);

    // Send error alert to Discord
    await sendErrorAlert(
      "❌ Strategy Optimization Failed",
      `An error occurred while optimizing the strategy position.`,
      error
    ).catch((alertError) => {
      // Don't fail the optimize command if alert fails
      console.warn("Failed to send Discord alert:", alertError);
    });

    throw error;
  }
}
