import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { DeltaNeutralMonitor } from "../../../strategy/monitor";
import { StrategyAction } from "../../../strategy/types";
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
import { IERC20 as UniswapIERC20 } from "../../../modules/uniswap/types";
import {
  ERC20_ABI,
  UNISWAP_POOL_ABI,
  UNISWAP_ROUTER_ABI,
  UNISWAP_QUOTER_ABI,
} from "../../../utils/abis";

import { toBigInt } from "../../../utils/helpers";

const MAX_UINT128 = (1n << 128n) - 1n;

export interface ExecuteAdjustRangeOptions {
  account?: string;
  tokenId?: string;
  rangeWidth?: number;
  priceLower?: number;
  priceUpper?: number;
  slippageBps?: bigint;
  dryRun?: boolean;
}

export async function executeAdjustRange(options: ExecuteAdjustRangeOptions = {}): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);

  console.log("\n" + "=".repeat(60));
  console.log("EXECUTE RANGE ADJUSTMENT");
  console.log("=".repeat(60) + "\n");

  console.log("Executing account:", account);

  // 1. Check Strategy Status
  const tokenIds = options.tokenId ? [BigInt(options.tokenId)] : undefined;

  const monitorConfig = loadStrategyConfig({
    minFeeThresholdUsd: ethers.parseUnits("10", 30),
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

  if (recommendation.action !== StrategyAction.ADJUST_RANGE) {
    console.log(`No range adjustment needed. Status: ${recommendation.action}`);
    console.log(`Reason: ${recommendation.reason}`);
    return;
  }

  console.log("RANGE ADJUSTMENT RECOMMENDED");
  console.log(`Reason: ${recommendation.reason}`);

  if (status.uniswap.length === 0) {
    console.error("No Uniswap positions found.");
    return;
  }

  // 2. Get positions to adjust
  const positionsToAdjust = status.uniswap.filter((pos) => pos.liquidity > 0n);

  if (positionsToAdjust.length === 0) {
    console.log("No positions with liquidity to adjust.");
    return;
  }

  console.log(`\nFound ${positionsToAdjust.length} position(s) to adjust:`);
  for (const pos of positionsToAdjust) {
    const currentRangeWidth = ((pos.priceUpper - pos.priceLower) / pos.currentPrice) * 100;
    console.log(
      `  Position ${pos.tokenId}: Range ${pos.priceLower.toFixed(2)} - ${pos.priceUpper.toFixed(2)} (${currentRangeWidth.toFixed(1)}% width)`
    );
  }

  // 3. Get current pool state for new position
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

  // Calculate new range bounds using configured default
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

  // 4. Check for dry run
  const executeFlag = !options.dryRun;

  // 5. Execute: Close old positions and open new one
  if (!executeFlag) {
    console.log("\n[DRY RUN] Range adjustment would be executed:");
    console.log(`\n1. Close ${positionsToAdjust.length} LP position(s):`);
    for (const pos of positionsToAdjust) {
      console.log(`   - Position ${pos.tokenId}: Collect fees and remove liquidity`);
    }
    console.log(`\n2. Close GMX short position (if exists)`);
  } else {
    console.log("\nExecuting range adjustment...");
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
      // Wait for transaction confirmation
      if (signer.provider) {
        const txReceipt = await signer.provider.waitForTransaction(closeResult.txHash);
        if (txReceipt) {
          console.log(`  Transaction confirmed in block ${txReceipt.blockNumber}`);
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

  // Close each LP position and collect tokens
  for (const pos of positionsToAdjust) {
    const tokenId = BigInt(pos.tokenId);
    if (executeFlag) {
      console.log(`\nClosing position ${pos.tokenId}...`);
    }

    const position = await getPosition(reader, tokenId);

    if (executeFlag) {
      if (position.liquidity > 0n) {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
        console.log(`  Removing liquidity: ${position.liquidity.toString()}`);

        await decreaseLiquidity(manager, {
          tokenId,
          liquidity: position.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline,
        });
        console.log(`  Decrease liquidity transaction submitted`);
      } else {
        console.log(`  Position has no liquidity; collecting fees only.`);
      }

      // Always collect fees (even if liquidity was 0)
      console.log(`  Collecting fees...`);
      await collectFees(manager, {
        tokenId,
        recipient: account,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      });
      console.log(`  Collect fees transaction submitted`);
    } else {
      if (position.liquidity > 0n) {
        console.log(`  Would remove liquidity: ${position.liquidity.toString()}`);
      } else {
        console.log(`  Position has no liquidity; would collect fees only.`);
      }
      console.log(`  Would collect fees`);
    }
  }

  // Get current balances (includes tokens from closed positions)
  const [balance0, balance1] = await Promise.all([
    token0Contract.balanceOf(account),
    token1Contract.balanceOf(account),
  ]);

  console.log(`\nAvailable tokens after closing positions:`);
  console.log(`  ${token0Symbol}: ${ethers.formatUnits(balance0, token0Decimals)}`);
  console.log(`  ${token1Symbol}: ${ethers.formatUnits(balance1, token1Decimals)}`);

  if (balance0 === 0n && balance1 === 0n) {
    console.error("No tokens available to create new position.");
    return;
  }

  // Calculate total capital value in USD
  const wethBalance = isToken0Weth ? balance0 : balance1;
  const usdcBalance = isToken0Usdc ? balance0 : balance1;
  const wethDecimals = isToken0Weth ? token0Decimals : token1Decimals;
  const usdcDecimals = isToken0Usdc ? token0Decimals : token1Decimals;

  const wethValueUsd = Number(ethers.formatUnits(wethBalance, wethDecimals)) * priceUsdcPerWeth;
  const usdcValueUsd = Number(ethers.formatUnits(usdcBalance, usdcDecimals));
  const totalCapitalUsd =
    (BigInt(Math.floor(wethValueUsd * 1e6)) * PRECISION.GMX_USD) / BigInt(10 ** 6) +
    (BigInt(Math.floor(usdcValueUsd * 1e6)) * PRECISION.GMX_USD) / BigInt(10 ** 6);

  console.log(`\nTotal capital: $${ethers.formatUnits(totalCapitalUsd, 30)}`);
  console.log(`Max position size: $${ethers.formatUnits(monitorConfig.maxPositionSizeUsd, 30)}`);

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
  let nonce = await signer.getNonce("pending");

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

  // Get final balances after swap
  if (executeFlag) {
    const [newBalance0, newBalance1] = await Promise.all([
      token0Contract.balanceOf(account),
      token1Contract.balanceOf(account),
    ]);
    finalBalance0 = newBalance0;
    finalBalance1 = newBalance1;
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

    console.log(`\n✅ Range adjustment complete!`);
    console.log(`  LP position: ${mintResult.txHash || "minted"}`);
    if (allocation.gmxShortSizeUsd > 0n) {
      console.log(`  GMX hedge: ${allocation.gmxShortSizeUsd > 0n ? "order created" : "skipped"}`);
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
    console.log("\nTo execute, run without --dry-run flag");
  }
}
