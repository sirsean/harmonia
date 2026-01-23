const Q96 = 2n ** 96n;

export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

export function priceToTick(price: number): number {
  return Math.log(price) / Math.log(1.0001);
}

export function roundTickDown(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

export function roundTickUp(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

export function tickToPriceWithDecimals(
  tick: number,
  decimals0: number | bigint,
  decimals1: number | bigint
): number {
  const rawPrice = tickToPrice(tick);
  const scale = Math.pow(10, toNumber(decimals0) - toNumber(decimals1));
  return rawPrice * scale;
}

export function priceToTickWithDecimals(
  price: number,
  decimals0: number | bigint,
  decimals1: number | bigint
): number {
  const scale = Math.pow(10, toNumber(decimals1) - toNumber(decimals0));
  return priceToTick(price * scale);
}

export function priceToSqrtPriceX96(
  price: number,
  decimals0: number | bigint,
  decimals1: number | bigint
): bigint {
  const scale = Math.pow(10, toNumber(decimals1) - toNumber(decimals0));
  const sqrtPrice = Math.sqrt(price * scale);
  const value = Math.floor(sqrtPrice * Math.pow(2, 96));
  return BigInt(value);
}

export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number | bigint,
  decimals1: number | bigint
): number {
  const sqrt = Number(sqrtPriceX96) / Math.pow(2, 96);
  const price = sqrt * sqrt;
  const scale = Math.pow(10, toNumber(decimals0) - toNumber(decimals1));
  return price * scale;
}

export function getSqrtRatioAtTick(tick: number): bigint {
  const price = tickToPrice(tick);
  const sqrtPrice = Math.sqrt(price);
  const value = Math.floor(sqrtPrice * Math.pow(2, 96));
  return BigInt(value);
}

export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint
): { amount0: bigint; amount1: bigint } {
  if (sqrtPriceAX96 > sqrtPriceBX96) {
    [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
  }

  if (sqrtPriceX96 <= sqrtPriceAX96) {
    const amount0 =
      (liquidity * (sqrtPriceBX96 - sqrtPriceAX96) * Q96) / (sqrtPriceAX96 * sqrtPriceBX96);
    return { amount0, amount1: 0n };
  }

  if (sqrtPriceX96 < sqrtPriceBX96) {
    const amount0 =
      (liquidity * (sqrtPriceBX96 - sqrtPriceX96) * Q96) / (sqrtPriceX96 * sqrtPriceBX96);
    const amount1 = (liquidity * (sqrtPriceX96 - sqrtPriceAX96)) / Q96;
    return { amount0, amount1 };
  }

  const amount1 = (liquidity * (sqrtPriceBX96 - sqrtPriceAX96)) / Q96;
  return { amount0: 0n, amount1 };
}
