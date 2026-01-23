const Q96 = 2n ** 96n;
const PRECISION = 10n ** 18n;

export interface DeltaResult {
  delta: bigint;
  deltaRatio: bigint;
  zone: "below" | "in" | "above";
}

function normalizeBounds(sqrtPaX96: bigint, sqrtPbX96: bigint): [bigint, bigint] {
  if (sqrtPaX96 <= sqrtPbX96) {
    return [sqrtPaX96, sqrtPbX96];
  }
  return [sqrtPbX96, sqrtPaX96];
}

export function calculateMaxDelta(sqrtPaX96: bigint, sqrtPbX96: bigint, liquidity: bigint): bigint {
  const [lower, upper] = normalizeBounds(sqrtPaX96, sqrtPbX96);
  if (lower === 0n || upper === 0n || liquidity === 0n) {
    return 0n;
  }
  return (liquidity * Q96 * (upper - lower)) / (lower * upper);
}

export function calculateDelta(
  sqrtPriceX96: bigint,
  sqrtPaX96: bigint,
  sqrtPbX96: bigint,
  liquidity: bigint
): DeltaResult {
  const [lower, upper] = normalizeBounds(sqrtPaX96, sqrtPbX96);
  const maxDelta = calculateMaxDelta(lower, upper, liquidity);

  if (liquidity === 0n || upper === 0n || lower === 0n) {
    return { delta: 0n, deltaRatio: 0n, zone: "above" };
  }

  if (sqrtPriceX96 <= lower) {
    return { delta: maxDelta, deltaRatio: PRECISION, zone: "below" };
  }

  if (sqrtPriceX96 >= upper) {
    return { delta: 0n, deltaRatio: 0n, zone: "above" };
  }

  const delta = (liquidity * Q96 * (upper - sqrtPriceX96)) / (sqrtPriceX96 * upper);
  const deltaRatio = maxDelta === 0n ? 0n : (delta * PRECISION) / maxDelta;

  return { delta, deltaRatio, zone: "in" };
}

export function calculateGamma(
  sqrtPriceX96: bigint,
  sqrtPaX96: bigint,
  sqrtPbX96: bigint,
  liquidity: bigint
): bigint {
  const [lower, upper] = normalizeBounds(sqrtPaX96, sqrtPbX96);
  if (sqrtPriceX96 <= lower || sqrtPriceX96 >= upper || liquidity === 0n) {
    return 0n;
  }

  const numerator = liquidity * Q96 * Q96 * Q96 * PRECISION;
  const denominator = 2n * sqrtPriceX96 * sqrtPriceX96 * sqrtPriceX96;
  if (denominator === 0n) {
    return 0n;
  }

  return -(numerator / denominator);
}

export { PRECISION, Q96 };
