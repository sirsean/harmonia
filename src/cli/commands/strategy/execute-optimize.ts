import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { DeltaNeutralMonitor } from "../../../strategy/monitor";
import { loadStrategyConfig, DEFAULT_STRATEGY_CONFIG, PRECISION } from "../../../config/strategy";
import { getDefaultRangeBounds } from "../../../config/markets";
import { createPositionManager, getPosition } from "../../../modules/uniswap/reader";
import { collectFees, decreaseLiquidity } from "../../../modules/uniswap/fees";
import {
  createPositionManager as createPositionManagerWriter,
  mintPosition,
} from "../../../modules/uniswap/liquidity";
import { createPool, getPoolState } from "../../../modules/uniswap/reader";
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
import { IERC20 as UniswapIERC20 } from "../../../modules/uniswap/types";
import {
  ERC20_ABI,
  UNISWAP_POOL_ABI,
  UNISWAP_ROUTER_ABI,
  UNISWAP_QUOTER_ABI,
} from "../../../utils/abis";

import { toBigInt } from "../../../utils/helpers";

const MAX_UINT128 = (1n << 128n) - 1n;

export interface ExecuteOptimizeOptions {
  account?: string;
  tokenId?: string;
  rangeWidth?: number;
  priceLower?: number;
  priceUpper?: number;
  slippageBps?: bigint;
  execute?: boolean;
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
export async function executeOptimize(options: ExecuteOptimizeOptions = {}): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);

  console.log("\n" + "=".repeat(60));
  console.log("OPTIMIZE STRATEGY POSITION");
  console.log("=".repeat(60) + "\n");

  console.log("Executing account:", account);

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

  // 5. Execute: Close old positions and open new one
  if (!executeFlag) {
    console.log("\n[DRY RUN] Optimization would be executed:");
    console.log(`\n1. Collect fees and close ${positionsToOptimize.length} LP position(s):`);
    for (const pos of positionsToOptimize) {
      console.log(`   - Position ${pos.tokenId}: Collect fees and remove liquidity`);
    }
    console.log(`\n2. Close GMX short position (if exists)`);
  } else {
    console.log("\nExecuting optimization...");
  }

  const reader = createPositionManager(ARBITRUM_MAINNET.uniswapV3PositionManager, ethers.provider);
  const manager = createPositionManagerWriter(ARBITRUM_MAINNET.uniswapV3PositionManager, signer);

  // Close GMX short position first (if exists)
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

  if (gmxPosition && gmxPosition.numbers.sizeInUsd > 0n) {
    if (executeFlag) {
      console.log(`\nClosing GMX short position...`);
      console.log(`  Size: $${ethers.formatUnits(gmxPosition.numbers.sizeInUsd, 30)}`);

      const priceResult = await getLatestPrice(
        ARBITRUM_MAINNET.chainlinkEthUsdFeed,
        ethers.provider,
        {
          outputDecimals: 12,
          maxStaleSeconds: 3600,
        }
      );

      if (!priceResult.outputPrice) {
        throw new Error("Missing output price for GMX close order");
      }

      // Acceptable price: current price + 1% slippage (for closing short, we're buying)
      const acceptablePrice = (priceResult.outputPrice * 101n) / 100n;
      const executionFee = monitorConfig.defaultExecutionFee;

      const router = gmxOrders.createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer);
      const nonce = await signer.getNonce("pending");

      const closeResult = await gmxOrders.createDecreaseOrder(
        router,
        {
          account: account,
          market: ARBITRUM_MAINNET.gmxEthUsdMarket,
          collateralToken: ARBITRUM_MAINNET.usdc,
          sizeDeltaUsd: gmxPosition.numbers.sizeInUsd,
          acceptablePrice,
          executionFee,
          isLong: false,
        },
        {
          orderVault: ARBITRUM_MAINNET.gmxOrderVault,
          gasLimit: 4000000,
          nonce,
          performStaticCall: false,
        }
      );

      console.log(`  Close GMX order tx: ${closeResult.txHash}`);
      // Try to wait for transaction confirmation (not available in Hardhat)
      if (signer.provider && typeof signer.provider.waitForTransaction === "function") {
        try {
          const txReceipt = await signer.provider.waitForTransaction(closeResult.txHash);
          if (txReceipt) {
            console.log(`  Transaction confirmed in block ${txReceipt.blockNumber}`);
          }
        } catch (error) {
          // Ignore errors - transaction is still submitted
          console.log(`  Transaction submitted (waitForTransaction not available)`);
        }
      }
    } else {
      console.log(`\nWould close GMX short position`);
      console.log(`  Size: $${ethers.formatUnits(gmxPosition.numbers.sizeInUsd, 30)}`);
    }
  } else {
    if (!executeFlag) {
      console.log(`\nNo GMX position to close`);
    }
  }

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
        const posToken0Contract = new ethers.Contract(position.token0, ERC20_ABI, ethers.provider);
        const posToken1Contract = new ethers.Contract(position.token1, ERC20_ABI, ethers.provider);
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

  // Close each LP position and collect tokens (if executing)
  for (const pos of positionsToOptimize) {
    const tokenId = BigInt(pos.tokenId);
    if (executeFlag) {
      console.log(`\nClosing position ${pos.tokenId}...`);
    }

    const position = await getPosition(reader, tokenId);

    if (executeFlag) {
      // Get fresh nonce for each position operation
      let positionNonce = await signer.getNonce("pending");

      if (position.liquidity > 0n) {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
        console.log(`  Removing liquidity: ${position.liquidity.toString()}`);

        const decreaseTx = await decreaseLiquidity(
          manager,
          {
            tokenId,
            liquidity: position.liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline,
          },
          { nonce: positionNonce }
        );
        console.log(`  Decrease liquidity transaction submitted: ${decreaseTx.hash}`);
        await decreaseTx.wait();
        console.log(`  Decrease liquidity confirmed`);

        // Get fresh nonce after decreaseLiquidity confirms
        positionNonce = await signer.getNonce("pending");
      } else {
        console.log(`  Position has no liquidity; collecting fees only.`);
      }

      // Always collect fees and tokens (even if liquidity was 0)
      // Note: decreaseLiquidity stores tokens in the position contract - collect() transfers them to wallet
      console.log(`  Collecting fees and tokens...`);
      const collectTx = await collectFees(
        manager,
        {
          tokenId,
          recipient: account,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
        { nonce: positionNonce }
      );
      console.log(`  Collect transaction submitted: ${collectTx.hash}`);
      await collectTx.wait();
      console.log(`  Collect confirmed - tokens transferred to wallet`);
    } else {
      if (position.liquidity > 0n) {
        console.log(`  Would remove liquidity: ${position.liquidity.toString()}`);
      } else {
        console.log(`  Position has no liquidity; would collect fees only.`);
      }
      console.log(`  Would collect fees`);
    }
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
    return;
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

  // Check if we have enough tokens, swap if needed
  const wethNeeded = wethAmount;
  const usdcNeeded = usdcAmount;
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
  const quoter = new ethers.Contract(ARBITRUM_MAINNET.uniswapV3Quoter, UNISWAP_QUOTER_ABI, signer);
  const wethToken = isToken0Weth ? token0 : token1;
  const usdcToken = isToken0Usdc ? token0 : token1;
  const wethContract = isToken0Weth ? token0Contract : token1Contract;
  const usdcContract = isToken0Usdc ? token0Contract : token1Contract;
  const fee = 500; // 0.05% fee tier
  const slippageBps = options.slippageBps ?? 50n; // 0.5% slippage

  let finalBalance0 = balance0;
  let finalBalance1 = balance1;
  // Get fresh nonce for swaps (after closing positions)
  let nonce = executeFlag ? await signer.getNonce("pending") : 0;

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

      let quoteOut: bigint;
      try {
        const quoteOutRaw = await quoter.quoteExactInputSingle.staticCall(
          usdcToken,
          wethToken,
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
        console.error(`  Error getting quote: ${errorMsg}`);
        throw new Error(`Failed to get swap quote: ${errorMsg}`);
      }
      const amountOutMin = (quoteOut * (10_000n - slippageBps)) / 10_000n;

      const allowance = await usdcContract.allowance(account, ARBITRUM_MAINNET.uniswapV3SwapRouter);
      if (allowance < amountIn) {
        const approval = await usdcContract.approve(
          ARBITRUM_MAINNET.uniswapV3SwapRouter,
          amountIn,
          { nonce }
        );
        await approval.wait();
        nonce += 1;
      }
      const swapTx = await swapRouter.exactInputSingle(
        {
          tokenIn: usdcToken,
          tokenOut: wethToken,
          fee,
          recipient: account,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
          amountIn,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0,
        },
        { nonce }
      );
      console.log(`  Swap tx: ${swapTx.hash}`);
      await swapTx.wait();
      nonce += 1;

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

    const minSwapAmount = ethers.parseUnits("0.001", wethDecimals);

    if (wethAvailable >= wethToSwap && wethToSwap >= minSwapAmount) {
      const amountIn = wethToSwap > wethAvailable ? wethAvailable : wethToSwap;
      console.log(`\nSwapping ${ethers.formatUnits(amountIn, wethDecimals)} WETH for USDC...`);

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
        console.error(`  Error getting quote: ${errorMsg}`);
        throw new Error(`Failed to get swap quote: ${errorMsg}`);
      }
      const amountOutMin = (quoteOut * (10_000n - slippageBps)) / 10_000n;

      const allowance = await wethContract.allowance(account, ARBITRUM_MAINNET.uniswapV3SwapRouter);
      if (allowance < amountIn) {
        const approval = await wethContract.approve(
          ARBITRUM_MAINNET.uniswapV3SwapRouter,
          amountIn,
          { nonce }
        );
        await approval.wait();
        nonce += 1;
      }
      const swapTx = await swapRouter.exactInputSingle(
        {
          tokenIn: wethToken,
          tokenOut: usdcToken,
          fee,
          recipient: account,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
          amountIn,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0,
        },
        { nonce }
      );
      console.log(`  Swap tx: ${swapTx.hash}`);
      await swapTx.wait();
      nonce += 1;

      const [newBalance0, newBalance1] = await Promise.all([
        token0Contract.balanceOf(account),
        token1Contract.balanceOf(account),
      ]);
      finalBalance0 = newBalance0;
      finalBalance1 = newBalance1;
    }
  } else if (!executeFlag) {
    if (wethShortfall > 0n) {
      console.log(`\nWould swap USDC for WETH to cover shortfall`);
    } else if (usdcShortfall > 0n) {
      console.log(`\nWould swap WETH for USDC to cover shortfall`);
    } else {
      console.log(`\nToken amounts are sufficient for LP position.`);
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
    console.log(`\nOpening new LP position...`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const positionManager = ARBITRUM_MAINNET.uniswapV3PositionManager;

    // Check and approve if needed
    const [allowance0, allowance1] = await Promise.all([
      token0Contract.allowance(account, positionManager),
      token1Contract.allowance(account, positionManager),
    ]);

    if (allowance0 < finalAmount0 && finalAmount0 > 0n) {
      console.log(`  Approving ${token0Symbol}...`);
      const approval = await token0Contract.approve(positionManager, finalAmount0, { nonce });
      await approval.wait();
      nonce += 1;
    }
    if (allowance1 < finalAmount1 && finalAmount1 > 0n) {
      console.log(`  Approving ${token1Symbol}...`);
      const approval = await token1Contract.approve(positionManager, finalAmount1, { nonce });
      await approval.wait();
      nonce += 1;
    }

    console.log(`  Minting LP position...`);

    const mintResult = await mintPosition(
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
        overrides: { nonce },
      }
    );

    if (mintResult.txHash) {
      console.log(`  LP position minted. Tx: ${mintResult.txHash}`);
      nonce += 1;
    }

    // Open GMX hedge position
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

      // Acceptable price: current - 1% slippage (for opening short, we're selling)
      const acceptablePrice = (priceResult.outputPrice * 99n) / 100n;

      // Approve USDC for GMX
      const usdcContractForGmx = new ethers.Contract(ARBITRUM_MAINNET.usdc, ERC20_ABI, signer);
      const usdcAllowance = await usdcContractForGmx.allowance(
        account,
        ARBITRUM_MAINNET.gmxExchangeRouter
      );
      if (usdcAllowance < collateralAmount) {
        console.log(`  Approving USDC for GMX...`);
        const approval = await usdcContractForGmx.approve(
          ARBITRUM_MAINNET.gmxExchangeRouter,
          collateralAmount,
          {
            nonce,
          }
        );
        await approval.wait();
        nonce += 1;
      }

      const gmxRouter = gmxOrders.createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer);
      const gmxResult = await gmxOrders.createIncreaseOrder(
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
    }

    console.log(`\n✅ Optimization complete!`);
    console.log(`  LP position: ${mintResult.txHash || "minted"}`);
    if (allocation.gmxShortSizeUsd > 0n) {
      console.log(`  GMX hedge: ${allocation.gmxShortSizeUsd > 0n ? "order created" : "skipped"}`);
    }

    // Record optimization in database
    try {
      const db = new MonitoringDatabase();
      const gasCostUsd = monitorConfig.estimatedOptimizationGasCostUsd;
      // Calculate total fees from status
      let totalFeesUsd = 0n;
      for (const pos of status.uniswap) {
        // Simplified fee calculation - use recommendation data if available
        if (recommendation.data?.totalFeesUsd) {
          totalFeesUsd = recommendation.data.totalFeesUsd;
          break;
        }
      }
      const benefitUsd = totalFeesUsd; // Simplified - could calculate more accurately
      db.recordOptimization(account, status.deltaDrift, totalFeesUsd, gasCostUsd, benefitUsd);
      console.log(`  Optimization recorded in database`);
    } catch (error) {
      console.warn(`  Warning: Failed to record optimization in database: ${error}`);
    }
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
    console.log(`   - Total capital used: $${ethers.formatUnits(allocation.totalCapitalUsd, 30)}`);
    console.log("\nTo execute, run with --execute flag");
  }
}
