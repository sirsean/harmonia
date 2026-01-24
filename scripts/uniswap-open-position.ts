import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";
import { RANGE_CONFIG, getDefaultRangeBounds } from "./config/range";
import { createPool, getPoolState } from "../src/modules/uniswap/reader";
import { createPositionManager, mintPosition } from "../src/modules/uniswap/liquidity";
import {
  priceToTickWithDecimals,
  roundTickDown,
  roundTickUp,
  tickToPriceWithDecimals,
} from "../src/modules/math/ticks";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
];
const POOL_TOKEN_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
];

function toBigInt(value: unknown): bigint {
  try {
    return ethers.getBigInt(value as ethers.BigNumberish);
  } catch {
    // continue
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (typeof value === "string") {
    return BigInt(value);
  }
  if (Array.isArray(value) && value.length > 0) {
    return toBigInt(value[0]);
  }
  if (value && typeof value === "object") {
    const maybeAmountOut = (value as { amountOut?: unknown }).amountOut;
    if (maybeAmountOut !== undefined) {
      return toBigInt(maybeAmountOut);
    }
    const maybeValue = (value as { value?: unknown }).value;
    if (maybeValue !== undefined) {
      return toBigInt(maybeValue);
    }
    const maybeResult = (value as { result?: unknown }).result;
    if (Array.isArray(maybeResult) && maybeResult.length > 0) {
      return toBigInt(maybeResult[0]);
    }
    const maybeToArray = (value as { toArray?: () => unknown[] }).toArray;
    if (typeof maybeToArray === "function") {
      const arr = maybeToArray();
      if (arr.length > 0) {
        return toBigInt(arr[0]);
      }
    }
    const maybeIterator = (value as { [Symbol.iterator]?: () => Iterator<unknown> })[
      Symbol.iterator
    ];
    if (typeof maybeIterator === "function") {
      const iterator = maybeIterator.call(value);
      const first = iterator.next();
      if (!first.done) {
        return toBigInt(first.value);
      }
    }
    const maybeHex =
      (value as { _hex?: string; hex?: string })._hex ?? (value as { hex?: string }).hex;
    if (maybeHex) {
      return BigInt(maybeHex);
    }
    const maybeHexString = (value as { toHexString?: () => string }).toHexString;
    if (typeof maybeHexString === "function") {
      return BigInt(maybeHexString());
    }
    const maybeArrayLike = value as { length?: number; 0?: unknown };
    if (typeof maybeArrayLike.length === "number" && maybeArrayLike.length > 0) {
      return toBigInt(maybeArrayLike[0]);
    }
  }
  return BigInt((value as { toString: () => string }).toString());
}

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("UNISWAP V3 OPEN POSITION");
  console.log("=".repeat(60) + "\n");

  const [signer] = await ethers.getSigners();
  const account = await signer.getAddress();

  const poolAddress = process.env.POOL || ARBITRUM_MAINNET.uniswapV3EthUsdcPool;
  const fee = Number(process.env.FEE || "500");
  const tickSpacing = Number(process.env.TICK_SPACING || "10");
  const slippageBps = BigInt(process.env.SLIPPAGE_BPS || "50");

  const manualTicks = process.env.TICK_LOWER && process.env.TICK_UPPER;
  const amount0DesiredRaw = process.env.AMOUNT0_DESIRED;
  const amount1DesiredRaw = process.env.AMOUNT1_DESIRED;

  const pool = createPool(poolAddress, ethers.provider);
  const poolTokens = new ethers.Contract(poolAddress, POOL_TOKEN_ABI, ethers.provider);
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

  // Use range config for default bounds, but allow override via env vars
  const rangeWidth = Number(process.env.RANGE_WIDTH || RANGE_CONFIG.DEFAULT_RANGE_WIDTH);
  const defaultBounds = getDefaultRangeBounds(priceUsdcPerWeth, rangeWidth);
  const lowerPrice = Number(process.env.PRICE_LOWER || defaultBounds.lower.toFixed(6));
  const upperPrice = Number(process.env.PRICE_UPPER || defaultBounds.upper.toFixed(6));

  const priceLowerForTicks = isToken0Weth ? lowerPrice : 1 / lowerPrice;
  const priceUpperForTicks = isToken0Weth ? upperPrice : 1 / upperPrice;

  const tickLower = manualTicks
    ? Number(process.env.TICK_LOWER)
    : roundTickDown(
        priceToTickWithDecimals(priceLowerForTicks, token0Decimals, token1Decimals),
        tickSpacing
      );
  const tickUpper = manualTicks
    ? Number(process.env.TICK_UPPER)
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

    const mintResult = await mintPosition(
      manager,
      token0Contract,
      token1Contract,
      {
        token0,
        token1,
        fee,
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

  const usdcAmount = Number(process.env.USDC_AMOUNT || "100");
  const usdcAmountUnits = ethers.parseUnits(usdcAmount.toString(), 6);
  const usdcToken = isToken0Usdc ? token0 : token1;
  const wethToken = isToken0Weth ? token0 : token1;

  const router = new ethers.Contract(ARBITRUM_MAINNET.uniswapV3SwapRouter, ROUTER_ABI, signer);
  const quoter = new ethers.Contract(ARBITRUM_MAINNET.uniswapV3Quoter, QUOTER_ABI, signer);
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

  let nonce = await signer.getNonce("pending");

  const allowance = await usdcContract.allowance(account, ARBITRUM_MAINNET.uniswapV3SwapRouter);
  if (allowance < amountIn) {
    const approval = await usdcContract.approve(ARBITRUM_MAINNET.uniswapV3SwapRouter, amountIn, {
      nonce,
    });
    await approval.wait();
    nonce += 1;
  }

  const swapTx = await router.exactInputSingle(
    {
      tokenIn: usdcToken,
      tokenOut: wethToken,
      fee,
      recipient: account,
      deadline,
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0,
    },
    { nonce }
  );
  console.log("Swap Tx Hash:", swapTx.hash);
  await swapTx.wait();
  nonce += 1;

  const [usdcBalanceAfter, wethBalanceAfter] = await Promise.all([
    usdcContract.balanceOf(account),
    wethContract.balanceOf(account),
  ]);

  const wethDelta = wethBalanceAfter - wethBalanceBefore;
  const usdcRemaining = usdcAmountUnits - amountIn;

  if (wethDelta <= 0n) {
    throw new Error("Swap produced no WETH.");
  }

  const amount0Desired = isToken0Weth ? wethDelta : usdcRemaining;
  const amount1Desired = isToken1Weth ? wethDelta : usdcRemaining;

  console.log("Minting with auto-balanced amounts...");
  console.log(
    `Amount0 Desired: ${ethers.formatUnits(amount0Desired, token0Decimals)} ${token0Symbol}`
  );
  console.log(
    `Amount1 Desired: ${ethers.formatUnits(amount1Desired, token1Decimals)} ${token1Symbol}`
  );

  const positionManager = ARBITRUM_MAINNET.uniswapV3PositionManager;
  const [allowance0, allowance1] = await Promise.all([
    token0Contract.allowance(account, positionManager),
    token1Contract.allowance(account, positionManager),
  ]);

  if (allowance0 < amount0Desired) {
    const approval = await token0Contract.approve(positionManager, amount0Desired, { nonce });
    await approval.wait();
    nonce += 1;
  }
  if (allowance1 < amount1Desired) {
    const approval = await token1Contract.approve(positionManager, amount1Desired, { nonce });
    await approval.wait();
    nonce += 1;
  }

  const mintResult = await mintPosition(
    manager,
    token0Contract,
    token1Contract,
    {
      token0,
      token1,
      fee,
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
    console.log("Mint Tx Hash:", mintResult.txHash);
  }
  console.log("\nMint transaction submitted (auto mode). ");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
