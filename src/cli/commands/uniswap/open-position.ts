import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { getDefaultRangeBounds } from "../../../config/markets";
import { DEFAULT_STRATEGY_CONFIG } from "../../../config/strategy";
import { createPool, getPoolState } from "../../../modules/uniswap/reader";
import { createPositionManager, mintPosition } from "../../../modules/uniswap/liquidity";
import { IERC20 } from "../../../modules/uniswap/types";
import {
  priceToTickWithDecimals,
  roundTickDown,
  roundTickUp,
  tickToPriceWithDecimals,
} from "../../../modules/math/ticks";
import { getSignerAndAccount } from "../base";
import {
  ERC20_ABI,
  UNISWAP_POOL_ABI,
  UNISWAP_ROUTER_ABI,
  UNISWAP_QUOTER_ABI,
} from "../../../utils/abis";
import { toBigInt, refreshNonce } from "../../../utils/helpers";

export interface UniswapOpenPositionOptions {
  account?: string;
  pool?: string;
  fee?: number;
  tickSpacing?: number;
  slippageBps?: bigint;
  rangeWidth?: number;
  priceLower?: number;
  priceUpper?: number;
  tickLower?: number;
  tickUpper?: number;
  amount0Desired?: string;
  amount1Desired?: string;
  usdcAmount?: string;
  execute?: boolean;
}

export async function uniswapOpenPosition(options: UniswapOpenPositionOptions = {}): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);
  const executeFlag = options.execute ?? false;

  console.log("\n" + "=".repeat(60));
  console.log("UNISWAP V3 OPEN POSITION");
  if (!executeFlag) {
    console.log("[DRY RUN MODE]");
  }
  console.log("=".repeat(60) + "\n");

  const poolAddress = options.pool || ARBITRUM_MAINNET.uniswapV3EthUsdcPool;
  const fee = options.fee ?? 500;
  const tickSpacing = options.tickSpacing ?? 10;
  const slippageBps = options.slippageBps ?? 50n;

  const manualTicks = options.tickLower !== undefined && options.tickUpper !== undefined;
  const amount0DesiredRaw = options.amount0Desired;
  const amount1DesiredRaw = options.amount1Desired;

  const pool = createPool(poolAddress, ethers.provider);
  const poolTokens = new ethers.Contract(poolAddress, UNISWAP_POOL_ABI, ethers.provider);
  const manager = createPositionManager(ARBITRUM_MAINNET.uniswapV3PositionManager, signer);

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

  // Use range config for default bounds, but allow override via options
  const rangeWidth = options.rangeWidth ?? Number(DEFAULT_STRATEGY_CONFIG.defaultRangeWidth);
  const defaultBounds = getDefaultRangeBounds(priceUsdcPerWeth, rangeWidth);
  const lowerPrice = options.priceLower ?? Number(defaultBounds.lower.toFixed(6));
  const upperPrice = options.priceUpper ?? Number(defaultBounds.upper.toFixed(6));

  const priceLowerForTicks = isToken0Weth ? lowerPrice : 1 / lowerPrice;
  const priceUpperForTicks = isToken0Weth ? upperPrice : 1 / upperPrice;

  const tickLower = manualTicks
    ? options.tickLower!
    : roundTickDown(
        priceToTickWithDecimals(priceLowerForTicks, token0Decimals, token1Decimals),
        tickSpacing
      );
  const tickUpper = manualTicks
    ? options.tickUpper!
    : roundTickUp(
        priceToTickWithDecimals(priceUpperForTicks, token0Decimals, token1Decimals),
        tickSpacing
      );

  if (!manualTicks && tickLower >= tickUpper) {
    throw new Error("Computed tickLower >= tickUpper.");
  }

  console.log("Pool:", poolAddress);
  console.log("Tick:", poolState.tick);
  console.log("Token0:", token0Symbol, token0);
  console.log("Token1:", token1Symbol, token1);
  console.log("Price (USDC/WETH):", priceUsdcPerWeth.toFixed(6));
  console.log("Tick Lower:", tickLower);
  console.log("Tick Upper:", tickUpper);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  if (amount0DesiredRaw && amount1DesiredRaw) {
    const amount0Desired = ethers.parseUnits(amount0DesiredRaw, token0Decimals);
    const amount1Desired = ethers.parseUnits(amount1DesiredRaw, token1Decimals);

    // Calculate minimum amounts based on slippage tolerance
    const amount0Min = (amount0Desired * (10_000n - slippageBps)) / 10_000n;
    const amount1Min = (amount1Desired * (10_000n - slippageBps)) / 10_000n;

    console.log("Slippage Protection:");
    console.log(
      `  Amount0 Min: ${ethers.formatUnits(amount0Min, token0Decimals)} ${token0Symbol} (${ethers.formatUnits(amount0Desired, token0Decimals)} desired)`
    );
    console.log(
      `  Amount1 Min: ${ethers.formatUnits(amount1Min, token1Decimals)} ${token1Symbol} (${ethers.formatUnits(amount1Desired, token1Decimals)} desired)`
    );

    if (!executeFlag) {
      console.log("\n[DRY RUN] Would mint position with:");
      console.log(
        `  Token0: ${ethers.formatUnits(amount0Desired, token0Decimals)} ${token0Symbol}`
      );
      console.log(
        `  Token1: ${ethers.formatUnits(amount1Desired, token1Decimals)} ${token1Symbol}`
      );
      console.log(`  Tick Lower: ${tickLower}`);
      console.log(`  Tick Upper: ${tickUpper}`);
      console.log("\nTo execute, run with --execute flag");
      return;
    }

    const mintResult = await mintPosition(
      manager,
      token0Contract as unknown as IERC20,
      token1Contract as unknown as IERC20,
      {
        token0,
        token1,
        fee,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min,
        amount1Min,
        recipient: account,
        deadline,
      },
      {
        owner: account,
        spender: ARBITRUM_MAINNET.uniswapV3PositionManager,
        performApproval: true,
      }
    );

    if (mintResult.txHash) {
      console.log("Mint Tx Hash:", mintResult.txHash);
    }
    console.log("\nMint transaction submitted (manual amounts). ");
    return;
  }

  const usdcAmount = options.usdcAmount ? Number(options.usdcAmount) : 100;
  const usdcAmountUnits = ethers.parseUnits(usdcAmount.toString(), 6);
  const usdcToken = isToken0Usdc ? token0 : token1;
  const wethToken = isToken0Weth ? token0 : token1;

  const router = new ethers.Contract(
    ARBITRUM_MAINNET.uniswapV3SwapRouter,
    UNISWAP_ROUTER_ABI,
    signer
  );
  const quoter = new ethers.Contract(ARBITRUM_MAINNET.uniswapV3Quoter, UNISWAP_QUOTER_ABI, signer);
  const usdcContract = isToken0Usdc ? token0Contract : token1Contract;
  const wethContract = isToken0Weth ? token0Contract : token1Contract;

  const [usdcBalanceBefore, wethBalanceBefore] = await Promise.all([
    usdcContract.balanceOf(account),
    wethContract.balanceOf(account),
  ]);

  const amountIn = usdcAmountUnits / 2n;
  const quoteOutRaw = await quoter.quoteExactInputSingle(usdcToken, wethToken, fee, amountIn, 0);
  const quoteOut = toBigInt(quoteOutRaw);
  const amountOutMin = (quoteOut * (10_000n - slippageBps)) / 10_000n;

  console.log(`Swapping ${ethers.formatUnits(amountIn, 6)} USDC for WETH...`);

  if (!executeFlag) {
    const wethDecimals = isToken0Weth ? token0Decimals : token1Decimals;
    console.log("\n[DRY RUN] Would swap tokens:");
    console.log(`  Amount In: ${ethers.formatUnits(amountIn, 6)} USDC`);
    console.log(`  Expected Out (min): ${ethers.formatUnits(amountOutMin, wethDecimals)} WETH`);
    console.log("\nTo execute, run with --execute flag");
    return;
  }

  // Let ethers manage nonce automatically - no manual nonce management
  const allowance = await usdcContract.allowance(account, ARBITRUM_MAINNET.uniswapV3SwapRouter);
  if (allowance < amountIn) {
    const approval = await usdcContract.approve(
      ARBITRUM_MAINNET.uniswapV3SwapRouter,
      (1n << 256n) - 1n
    );
    // CRITICAL: Wait for approval before proceeding
    await approval.wait();
    await refreshNonce(ethers.provider, account);
  }

  // Let ethers manage nonce automatically
  const swapTx = await router.exactInputSingle({
    tokenIn: usdcToken,
    tokenOut: wethToken,
    fee,
    recipient: account,
    deadline,
    amountIn,
    amountOutMinimum: amountOutMin,
    sqrtPriceLimitX96: 0,
  });
  console.log("Swap Tx Hash:", swapTx.hash);
  // CRITICAL: Wait for swap confirmation before proceeding
  await swapTx.wait();
  await refreshNonce(ethers.provider, account);

  const [usdcBalanceAfter, wethBalanceAfter] = await Promise.all([
    usdcContract.balanceOf(account),
    wethContract.balanceOf(account),
  ]);

  const wethDelta = BigInt(wethBalanceAfter.toString()) - BigInt(wethBalanceBefore.toString());
  const usdcRemaining = usdcAmountUnits - amountIn;

  if (wethDelta <= 0n) {
    throw new Error("Swap produced no WETH.");
  }

  const amount0Desired: bigint = isToken0Weth ? wethDelta : usdcRemaining;
  const amount1Desired: bigint = isToken1Weth ? wethDelta : usdcRemaining;

  // Calculate minimum amounts based on slippage tolerance
  const amount0Min = (amount0Desired * (10_000n - slippageBps)) / 10_000n;
  const amount1Min = (amount1Desired * (10_000n - slippageBps)) / 10_000n;

  console.log("Minting with auto-balanced amounts...");
  console.log(
    `Amount0 Desired: ${ethers.formatUnits(amount0Desired, token0Decimals)} ${token0Symbol}`
  );
  console.log(
    `Amount1 Desired: ${ethers.formatUnits(amount1Desired, token1Decimals)} ${token1Symbol}`
  );
  console.log("Slippage Protection:");
  console.log(
    `  Amount0 Min: ${ethers.formatUnits(amount0Min, token0Decimals)} ${token0Symbol} (${((Number(amount0Min) / Number(amount0Desired)) * 100).toFixed(2)}% of desired)`
  );
  console.log(
    `  Amount1 Min: ${ethers.formatUnits(amount1Min, token1Decimals)} ${token1Symbol} (${((Number(amount1Min) / Number(amount1Desired)) * 100).toFixed(2)}% of desired)`
  );

  const positionManager = ARBITRUM_MAINNET.uniswapV3PositionManager;
  const [allowance0, allowance1] = await Promise.all([
    token0Contract.allowance(account, positionManager),
    token1Contract.allowance(account, positionManager),
  ]);

  if (!executeFlag) {
    console.log("\n[DRY RUN] Would mint position with:");
    console.log(`  Token0: ${ethers.formatUnits(amount0Desired, token0Decimals)} ${token0Symbol}`);
    console.log(`  Token1: ${ethers.formatUnits(amount1Desired, token1Decimals)} ${token1Symbol}`);
    console.log(`  Tick Lower: ${tickLower}`);
    console.log(`  Tick Upper: ${tickUpper}`);
    console.log("\nTo execute, run with --execute flag");
    return;
  }

  // Let ethers manage nonce automatically - sequential approvals
  if (allowance0 < amount0Desired) {
    const approval = await token0Contract.approve(positionManager, (1n << 256n) - 1n);
    // CRITICAL: Wait for approval before proceeding
    await approval.wait();
    await refreshNonce(ethers.provider, account);
  }
  if (allowance1 < amount1Desired) {
    const approval = await token1Contract.approve(positionManager, (1n << 256n) - 1n);
    // CRITICAL: Wait for approval before proceeding
    await approval.wait();
    await refreshNonce(ethers.provider, account);
  }

  // Let ethers manage nonce automatically
  const mintResult = await mintPosition(
    manager,
    token0Contract as unknown as IERC20,
    token1Contract as unknown as IERC20,
    {
      token0,
      token1,
      fee,
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min,
      amount1Min,
      recipient: account,
      deadline,
    },
    {
      owner: account,
      spender: positionManager,
      performApproval: false,
      // Note: Always waits for receipt (no option to disable)
    }
  );

  if (mintResult.txHash) {
    console.log("Mint Tx Hash:", mintResult.txHash);
  }
  console.log("\nMint transaction submitted (auto mode). ");
}
