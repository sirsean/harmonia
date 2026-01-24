import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../src/config/addresses";
import { DeltaNeutralMonitor } from "../src/strategy/monitor";
import { StrategyAction } from "../src/strategy/types";
import { loadStrategyConfig, DEFAULT_STRATEGY_CONFIG } from "../src/config/strategy";
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
    console.log(`\n1. Close ${positionsToAdjust.length} position(s):`);
    for (const pos of positionsToAdjust) {
      console.log(`   - Position ${pos.tokenId}: Collect fees and remove liquidity`);
    }
  } else {
    console.log("\nExecuting range adjustment...");
  }

  const reader = createPositionManager(ARBITRUM_MAINNET.uniswapV3PositionManager, ethers.provider);
  const manager = createPositionManagerWriter(ARBITRUM_MAINNET.uniswapV3PositionManager, signer);

  // Close each position and collect tokens
  for (const pos of positionsToAdjust) {
    const tokenId = BigInt(pos.tokenId);
    if (executeFlag) {
      console.log(`\nClosing position ${pos.tokenId}...`);
    }

    const position = await getPosition(reader, tokenId);

    if (position.liquidity > 0n) {
      if (executeFlag) {
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
        console.log(`  Would remove liquidity: ${position.liquidity.toString()}`);
        console.log(`  Would collect fees`);
      }
    }
  }

  // Get current balances (includes tokens from closed positions)
  const [balance0, balance1] = await Promise.all([
    token0Contract.balanceOf(account),
    token1Contract.balanceOf(account),
  ]);

  console.log(`\nAvailable tokens for new position:`);
  console.log(`  ${token0Symbol}: ${ethers.formatUnits(balance0, token0Decimals)}`);
  console.log(`  ${token1Symbol}: ${ethers.formatUnits(balance1, token1Decimals)}`);

  if (balance0 === 0n && balance1 === 0n) {
    console.error("No tokens available to create new position.");
    return;
  }

  // Calculate target ratio for centered LP position
  // For a centered position, we want equal value in both tokens
  // The center price is the geometric mean: sqrt(priceLower * priceUpper)
  const centerPrice = Math.sqrt(lowerPrice * upperPrice);
  console.log(`\nCalculating target ratio for centered LP:`);
  console.log(`  Center price: ${centerPrice.toFixed(6)} USDC/WETH`);

  // Calculate total value in USD
  // If token0 is WETH, its value = balance0 * currentPrice
  // If token1 is WETH, its value = balance1 * currentPrice
  const wethBalance = isToken0Weth ? balance0 : balance1;
  const usdcBalance = isToken0Usdc ? balance0 : balance1;
  const wethDecimals = isToken0Weth ? token0Decimals : token1Decimals;
  const usdcDecimals = isToken0Usdc ? token0Decimals : token1Decimals;

  const wethValueUsd = Number(ethers.formatUnits(wethBalance, wethDecimals)) * priceUsdcPerWeth;
  const usdcValueUsd = Number(ethers.formatUnits(usdcBalance, usdcDecimals));
  const totalValueUsd = wethValueUsd + usdcValueUsd;
  const targetValuePerToken = totalValueUsd / 2;

  console.log(`  Total value: $${totalValueUsd.toFixed(2)}`);
  console.log(`  Target value per token: $${targetValuePerToken.toFixed(2)}`);

  // Determine if we need to swap
  const wethTargetValue = targetValuePerToken;
  const usdcTargetValue = targetValuePerToken;

  const wethNeeded = wethTargetValue / priceUsdcPerWeth;
  const usdcNeeded = usdcTargetValue;

  const currentWeth = Number(ethers.formatUnits(wethBalance, wethDecimals));
  const currentUsdc = Number(ethers.formatUnits(usdcBalance, usdcDecimals));

  const wethDiff = wethNeeded - currentWeth;
  const usdcDiff = usdcNeeded - currentUsdc;

  // Swap tokens if needed to achieve centered position

  const router = new ethers.Contract(ARBITRUM_MAINNET.uniswapV3SwapRouter, ROUTER_ABI, signer);
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
  if (wethDiff > 0.001) {
    // Need more WETH, swap USDC
    const usdcToSwap = Math.min(usdcDiff, currentUsdc);
    if (usdcToSwap > 0.01) {
      const amountIn = ethers.parseUnits(usdcToSwap.toFixed(usdcDecimals), usdcDecimals);
      console.log(`\nSwapping ${ethers.formatUnits(amountIn, usdcDecimals)} USDC for WETH...`);

      const quoteOutRaw = await quoter.quoteExactInputSingle(
        usdcToken,
        wethToken,
        fee,
        amountIn,
        0
      );
      const quoteOut = toBigInt(quoteOutRaw);
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

      if (executeFlag) {
        const swapTx = await router.exactInputSingle(
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
      } else {
        console.log(`  [DRY RUN] Would swap ${ethers.formatUnits(amountIn, usdcDecimals)} USDC`);
        console.log(`  Expected WETH out: ${ethers.formatUnits(quoteOut, wethDecimals)}`);
      }
    }
  }
  // If we need more USDC, swap WETH for USDC
  else if (usdcDiff > 0.01) {
    // Need more USDC, swap WETH
    const wethToSwap = Math.min(-wethDiff, currentWeth);
    if (wethToSwap > 0.0001) {
      const amountIn = ethers.parseUnits(wethToSwap.toFixed(wethDecimals), wethDecimals);
      console.log(`\nSwapping ${ethers.formatUnits(amountIn, wethDecimals)} WETH for USDC...`);

      const quoteOutRaw = await quoter.quoteExactInputSingle(
        wethToken,
        usdcToken,
        fee,
        amountIn,
        0
      );
      const quoteOut = toBigInt(quoteOutRaw);
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

      if (executeFlag) {
        const swapTx = await router.exactInputSingle(
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
      } else {
        console.log(`  [DRY RUN] Would swap ${ethers.formatUnits(amountIn, wethDecimals)} WETH`);
        console.log(`  Expected USDC out: ${ethers.formatUnits(quoteOut, usdcDecimals)}`);
      }
    }
  } else {
    console.log(`\nToken ratio is already balanced for centered position.`);
  }

  // Get final balances after swap
  if (executeFlag) {
    const [newBalance0, newBalance1] = await Promise.all([
      token0Contract.balanceOf(account),
      token1Contract.balanceOf(account),
    ]);
    finalBalance0 = newBalance0;
    finalBalance1 = newBalance1;
  } else {
    // In dry run, estimate final balances (approximate)
    finalBalance0 = balance0;
    finalBalance1 = balance1;
  }

  console.log(`\nFinal token amounts for new position:`);
  console.log(`  ${token0Symbol}: ${ethers.formatUnits(finalBalance0, token0Decimals)}`);
  console.log(`  ${token1Symbol}: ${ethers.formatUnits(finalBalance1, token1Decimals)}`);

  // Open new position with balanced tokens
  if (executeFlag) {
    console.log(`\nOpening new position...`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const amount0Desired = finalBalance0;
    const amount1Desired = finalBalance1;

    const positionManager = ARBITRUM_MAINNET.uniswapV3PositionManager;

    // Check and approve if needed
    const [allowance0, allowance1] = await Promise.all([
      token0Contract.allowance(account, positionManager),
      token1Contract.allowance(account, positionManager),
    ]);

    if (allowance0 < amount0Desired && amount0Desired > 0n) {
      console.log(`  Approving ${token0Symbol}...`);
      const approval = await token0Contract.approve(positionManager, amount0Desired, { nonce });
      await approval.wait();
      nonce += 1;
    }
    if (allowance1 < amount1Desired && amount1Desired > 0n) {
      console.log(`  Approving ${token1Symbol}...`);
      const approval = await token1Contract.approve(positionManager, amount1Desired, { nonce });
      await approval.wait();
      nonce += 1;
    }

    console.log(`  Minting position with:`);
    console.log(`    ${token0Symbol}: ${ethers.formatUnits(amount0Desired, token0Decimals)}`);
    console.log(`    ${token1Symbol}: ${ethers.formatUnits(amount1Desired, token1Decimals)}`);

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
        amount0Desired,
        amount1Desired,
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
      console.log(`\n✅ Range adjustment complete!`);
      console.log(`  New position minted. Tx: ${mintResult.txHash}`);
    } else {
      console.log(`\n✅ Range adjustment complete!`);
      console.log(`  New position minted.`);
    }
  } else {
    console.log(`\n3. Open new centered position:`);
    console.log(`   - Range: ${lowerPrice.toFixed(6)} - ${upperPrice.toFixed(6)}`);
    console.log(`   - Ticks: ${tickLower} - ${tickUpper}`);
    console.log(`   - Would swap tokens to achieve centered ratio`);
    console.log(
      `   - Final amounts: ~${ethers.formatUnits(finalBalance0, token0Decimals)} ${token0Symbol}, ~${ethers.formatUnits(finalBalance1, token1Decimals)} ${token1Symbol}`
    );
    console.log("\nTo execute, run with EXECUTE=true");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
