import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../src/config/addresses";
import { DeltaNeutralMonitor } from "../src/strategy/monitor";
import { StrategyAction } from "../src/strategy/types";
import { loadStrategyConfig, DEFAULT_STRATEGY_CONFIG, PRECISION } from "../src/config/strategy";
import { getDefaultRangeBounds } from "../src/config/markets";
import {
  createPositionManager,
  getPosition,
  getActivePositionsForOwner,
} from "../src/modules/uniswap/reader";
import { collectFees, decreaseLiquidity } from "../src/modules/uniswap/fees";
import {
  createPositionManager as createPositionManagerWriter,
  mintPosition,
} from "../src/modules/uniswap/liquidity";
import { createPool, getPoolState } from "../src/modules/uniswap/reader";
import {
  priceToTickWithDecimals,
  roundTickDown,
  roundTickUp,
  tickToPriceWithDecimals,
} from "../src/modules/math/ticks";
import { ERC20_ABI, POOL_TOKEN_ABI, ROUTER_ABI, QUOTER_ABI, toBigInt } from "./utils";
import * as gmxReader from "../src/modules/gmx/reader";
import * as gmxOrders from "../src/modules/gmx/orders";
import { getLatestPrice } from "../src/modules/chainlink/price";
import { calculateOptimalAllocation, calculateLpTokenAmounts } from "../src/strategy/allocation";
import { RebalanceManager } from "../src/strategy/rebalance";
import {
  fetchTokenPrices,
  findTokenPrice,
  averagePrice,
  scalePriceTo30,
} from "../src/modules/gmx/prices";

const MAX_UINT128 = (1n << 128n) - 1n;

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("EXECUTE RANGE ADJUSTMENT");
  console.log("=".repeat(60) + "\n");

  const [signer] = await ethers.getSigners();
  const account = await signer.getAddress();
  console.log("Executing account:", account);

  // 1. Check Strategy Status
  const tokenIdEnv = process.env.UNISWAP_TOKEN_ID;
  const tokenIds = tokenIdEnv ? [BigInt(tokenIdEnv)] : undefined;

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
  const poolTokens = new ethers.Contract(poolAddress, POOL_TOKEN_ABI, ethers.provider);
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
  const rangeWidth = Number(process.env.RANGE_WIDTH || DEFAULT_STRATEGY_CONFIG.defaultRangeWidth);
  const defaultBounds = getDefaultRangeBounds(priceUsdcPerWeth, rangeWidth);
  const lowerPrice = Number(process.env.PRICE_LOWER || defaultBounds.lower.toFixed(6));
  const upperPrice = Number(process.env.PRICE_UPPER || defaultBounds.upper.toFixed(6));

  const priceLowerForTicks = isToken0Weth ? lowerPrice : 1 / lowerPrice;
  const priceUpperForTicks = isToken0Weth ? upperPrice : 1 / upperPrice;

  const tickSpacing = Number(process.env.TICK_SPACING || "10");
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

  // 4. Check for EXECUTE env var
  const executeFlag = process.env.EXECUTE === "true";

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
      const txReceipt = await signer.provider.waitForTransaction(closeResult.txHash);
      console.log(`  Transaction confirmed in block ${txReceipt.blockNumber}`);
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

        const decreaseTx = await decreaseLiquidity(manager, {
          tokenId,
          liquidity: position.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline,
        });
        console.log(`  Decrease liquidity tx: ${decreaseTx.hash}`);
        await decreaseTx.wait();
      } else {
        console.log(`  Position has no liquidity; collecting fees only.`);
      }

      // Always collect fees (even if liquidity was 0)
      console.log(`  Collecting fees...`);
      const collectTx = await collectFees(manager, {
        tokenId,
        recipient: account,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      });
      console.log(`  Collect fees tx: ${collectTx.hash}`);
      await collectTx.wait();
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
  const swapRouter = new ethers.Contract(ARBITRUM_MAINNET.uniswapV3SwapRouter, ROUTER_ABI, signer);
  const quoter = new ethers.Contract(ARBITRUM_MAINNET.uniswapV3Quoter, QUOTER_ABI, signer);
  const wethToken = isToken0Weth ? token0 : token1;
  const usdcToken = isToken0Usdc ? token0 : token1;
  const wethContract = isToken0Weth ? token0Contract : token1Contract;
  const usdcContract = isToken0Usdc ? token0Contract : token1Contract;
  const fee = 500; // 0.05% fee tier
  const slippageBps = BigInt(process.env.SLIPPAGE_BPS || "50"); // 0.5% slippage

  let finalBalance0 = balance0;
  let finalBalance1 = balance1;
  let nonce = await signer.getNonce("pending");

  // If we need more WETH, swap USDC for WETH
  if (wethShortfall > 0n) {
    // Calculate how much USDC to swap (need enough to cover shortfall + some buffer)
    // Convert WETH shortfall (in 18 decimals) to USDC value (in 6 decimals)
    // wethShortfall is in WETH native decimals (18), price is USDC per WETH
    // USDC needed = wethShortfall * price (convert from 18 dec to 6 dec)
    const wethShortfallNum = Number(ethers.formatUnits(wethShortfall, wethDecimals));
    const usdcNeededNum = wethShortfallNum * priceUsdcPerWeth;
    const usdcToSwap = ethers.parseUnits(
      (usdcNeededNum * 1.01).toFixed(usdcDecimals),
      usdcDecimals
    ); // Add 1% buffer

    // Minimum swap amount to avoid quoter issues (e.g., $1 USDC)
    const minSwapAmount = ethers.parseUnits("1", usdcDecimals);

    if (usdcAvailable >= usdcToSwap && usdcToSwap >= minSwapAmount) {
      const amountIn = usdcToSwap > usdcAvailable ? usdcAvailable : usdcToSwap;
      console.log(`\nSwapping ${ethers.formatUnits(amountIn, usdcDecimals)} USDC for WETH...`);

      let quoteOut: bigint;
      try {
        // Use staticCall to handle reverts properly
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
        // Check if it's a revert (insufficient liquidity, etc.)
        const errorMsg = error.reason || error.message || String(error);
        if (errorMsg.includes("revert") || errorMsg.includes("STF") || errorMsg.includes("SPL")) {
          console.error(`  Quoter reverted - likely insufficient liquidity for this swap`);
          console.error(
            `  Consider: reducing swap amount, checking pool liquidity, or using a different fee tier`
          );
        }
        console.error(`  Error getting quote: ${errorMsg}`);
        console.error(
          `  Token in: ${usdcToken}, Token out: ${wethToken}, Fee: ${fee}, Amount: ${ethers.formatUnits(amountIn, usdcDecimals)}`
        );
        throw new Error(`Failed to get swap quote: ${errorMsg}`);
      }
      const amountOutMin = (quoteOut * (10_000n - slippageBps)) / 10_000n;

      if (executeFlag) {
        const allowance = await usdcContract.allowance(
          account,
          ARBITRUM_MAINNET.uniswapV3SwapRouter
        );
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

        // Update balances
        const [newBalance0, newBalance1] = await Promise.all([
          token0Contract.balanceOf(account),
          token1Contract.balanceOf(account),
        ]);
        finalBalance0 = newBalance0;
        finalBalance1 = newBalance1;
      } else {
        console.log(`  [DRY RUN] Would swap ${ethers.formatUnits(amountIn, usdcDecimals)} USDC`);
        console.log(`  Expected WETH out: ${ethers.formatUnits(quoteOut, wethDecimals)}`);
        // Update final balances for dry run (simulate the swap)
        finalBalance0 = isToken0Weth ? finalBalance0 + quoteOut : finalBalance0 - amountIn;
        finalBalance1 = isToken1Weth ? finalBalance1 + quoteOut : finalBalance1 - amountIn;
      }
    } else if (usdcToSwap < minSwapAmount) {
      console.log(
        `\nSkipping swap: amount too small (${ethers.formatUnits(usdcToSwap, usdcDecimals)} USDC < ${ethers.formatUnits(minSwapAmount, usdcDecimals)} USDC minimum)`
      );
      console.log(`  WETH shortfall: ${ethers.formatUnits(wethShortfall, wethDecimals)}`);
      console.log(`  Will use available WETH: ${ethers.formatUnits(wethAvailable, wethDecimals)}`);
    } else {
      console.log(
        `\nInsufficient USDC to swap: need ${ethers.formatUnits(usdcToSwap, usdcDecimals)}, have ${ethers.formatUnits(usdcAvailable, usdcDecimals)}`
      );
    }
  }
  // If we need more USDC, swap WETH for USDC
  else if (usdcShortfall > 0n) {
    // Calculate how much WETH to swap
    // Convert USDC shortfall (in 6 decimals) to WETH value (in 18 decimals)
    const usdcShortfallNum = Number(ethers.formatUnits(usdcShortfall, usdcDecimals));
    const wethNeededNum = usdcShortfallNum / priceUsdcPerWeth;
    const wethToSwap = ethers.parseUnits(
      (wethNeededNum * 1.01).toFixed(wethDecimals),
      wethDecimals
    ); // Add 1% buffer

    // Minimum swap amount to avoid quoter issues (e.g., 0.001 WETH ≈ $3)
    const minSwapAmount = ethers.parseUnits("0.001", wethDecimals);

    if (wethAvailable >= wethToSwap && wethToSwap >= minSwapAmount) {
      const amountIn = wethToSwap > wethAvailable ? wethAvailable : wethToSwap;
      console.log(`\nSwapping ${ethers.formatUnits(amountIn, wethDecimals)} WETH for USDC...`);

      let quoteOut: bigint;
      try {
        // Use staticCall to handle reverts properly
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
        // Check if it's a revert (insufficient liquidity, etc.)
        const errorMsg = error.reason || error.message || String(error);
        if (errorMsg.includes("revert") || errorMsg.includes("STF") || errorMsg.includes("SPL")) {
          console.error(`  Quoter reverted - likely insufficient liquidity for this swap`);
          console.error(
            `  Consider: reducing swap amount, checking pool liquidity, or using a different fee tier`
          );
        }
        console.error(`  Error getting quote: ${errorMsg}`);
        console.error(
          `  Token in: ${wethToken}, Token out: ${usdcToken}, Fee: ${fee}, Amount: ${ethers.formatUnits(amountIn, wethDecimals)}`
        );
        throw new Error(`Failed to get swap quote: ${errorMsg}`);
      }
      const amountOutMin = (quoteOut * (10_000n - slippageBps)) / 10_000n;

      if (executeFlag) {
        const allowance = await wethContract.allowance(
          account,
          ARBITRUM_MAINNET.uniswapV3SwapRouter
        );
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

        // Update balances
        const [newBalance0, newBalance1] = await Promise.all([
          token0Contract.balanceOf(account),
          token1Contract.balanceOf(account),
        ]);
        finalBalance0 = newBalance0;
        finalBalance1 = newBalance1;
      } else {
        console.log(`  [DRY RUN] Would swap ${ethers.formatUnits(amountIn, wethDecimals)} WETH`);
        console.log(`  Expected USDC out: ${ethers.formatUnits(quoteOut, usdcDecimals)}`);
        // Update final balances for dry run (simulate the swap)
        finalBalance0 = isToken0Weth ? finalBalance0 - amountIn : finalBalance0 + quoteOut;
        finalBalance1 = isToken1Weth ? finalBalance1 - amountIn : finalBalance1 + quoteOut;
      }
    } else if (wethToSwap < minSwapAmount) {
      console.log(
        `\nSkipping swap: amount too small (${ethers.formatUnits(wethToSwap, wethDecimals)} WETH < ${ethers.formatUnits(minSwapAmount, wethDecimals)} WETH minimum)`
      );
      console.log(`  USDC shortfall: ${ethers.formatUnits(usdcShortfall, usdcDecimals)}`);
      console.log(`  Will use available USDC: ${ethers.formatUnits(usdcAvailable, usdcDecimals)}`);
    } else {
      console.log(
        `\nInsufficient WETH to swap: need ${ethers.formatUnits(wethToSwap, wethDecimals)}, have ${ethers.formatUnits(wethAvailable, wethDecimals)}`
      );
    }
  } else {
    console.log(`\nToken amounts are sufficient for LP position.`);
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
      token0Contract,
      token1Contract,
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
      const usdcContract = new ethers.Contract(ARBITRUM_MAINNET.usdc, ERC20_ABI, signer);
      const usdcAllowance = await usdcContract.allowance(
        account,
        ARBITRUM_MAINNET.gmxExchangeRouter
      );
      if (usdcAllowance < collateralAmount) {
        console.log(`  Approving USDC for GMX...`);
        const approval = await usdcContract.approve(
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
        usdcContract as any,
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
    console.log("\nTo execute, run with EXECUTE=true");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
