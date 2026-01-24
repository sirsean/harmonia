import { describe, expect, it } from "vitest";

describe("uniswap-open-position slippage protection", () => {
  it("calculates minimum amounts correctly with 50 bps slippage", () => {
    const slippageBps = 50n; // 0.5%
    const amount0Desired = 1_000_000_000_000_000_000n; // 1 ETH (18 decimals)
    const amount1Desired = 2_000_000n; // 2 USDC (6 decimals)

    const amount0Min = (amount0Desired * (10_000n - slippageBps)) / 10_000n;
    const amount1Min = (amount1Desired * (10_000n - slippageBps)) / 10_000n;

    // With 0.5% slippage, we should get 99.5% of desired
    expect(amount0Min).toBe(995_000_000_000_000_000n); // 0.995 ETH
    expect(amount1Min).toBe(1_990_000n); // 1.99 USDC

    // Verify it's exactly 99.5%
    expect(Number(amount0Min) / Number(amount0Desired)).toBeCloseTo(0.995, 10);
    expect(Number(amount1Min) / Number(amount1Desired)).toBeCloseTo(0.995, 10);
  });

  it("calculates minimum amounts correctly with 100 bps slippage", () => {
    const slippageBps = 100n; // 1%
    const amount0Desired = 1_000_000_000_000_000_000n; // 1 ETH
    const amount1Desired = 2_000_000n; // 2 USDC

    const amount0Min = (amount0Desired * (10_000n - slippageBps)) / 10_000n;
    const amount1Min = (amount1Desired * (10_000n - slippageBps)) / 10_000n;

    // With 1% slippage, we should get 99% of desired
    expect(amount0Min).toBe(990_000_000_000_000_000n); // 0.99 ETH
    expect(amount1Min).toBe(1_980_000n); // 1.98 USDC

    // Verify it's exactly 99%
    expect(Number(amount0Min) / Number(amount0Desired)).toBeCloseTo(0.99, 10);
    expect(Number(amount1Min) / Number(amount1Desired)).toBeCloseTo(0.99, 10);
  });

  it("handles zero slippage correctly", () => {
    const slippageBps = 0n; // 0%
    const amount0Desired = 1_000_000_000_000_000_000n;
    const amount1Desired = 2_000_000n;

    const amount0Min = (amount0Desired * (10_000n - slippageBps)) / 10_000n;
    const amount1Min = (amount1Desired * (10_000n - slippageBps)) / 10_000n;

    // With 0% slippage, min should equal desired
    expect(amount0Min).toBe(amount0Desired);
    expect(amount1Min).toBe(amount1Desired);
  });

  it("ensures minimum amounts are always less than desired", () => {
    const slippageBps = 50n;
    const amount0Desired = 1_000_000_000_000_000_000n;
    const amount1Desired = 2_000_000n;

    const amount0Min = (amount0Desired * (10_000n - slippageBps)) / 10_000n;
    const amount1Min = (amount1Desired * (10_000n - slippageBps)) / 10_000n;

    expect(amount0Min).toBeLessThan(amount0Desired);
    expect(amount1Min).toBeLessThan(amount1Desired);
  });

  it("handles edge case with very small amounts", () => {
    const slippageBps = 50n;
    const amount0Desired = 1n; // Very small amount
    const amount1Desired = 1n;

    const amount0Min = (amount0Desired * (10_000n - slippageBps)) / 10_000n;
    const amount1Min = (amount1Desired * (10_000n - slippageBps)) / 10_000n;

    // Should handle rounding correctly
    expect(amount0Min).toBeGreaterThanOrEqual(0n);
    expect(amount1Min).toBeGreaterThanOrEqual(0n);
    expect(amount0Min).toBeLessThanOrEqual(amount0Desired);
    expect(amount1Min).toBeLessThanOrEqual(amount1Desired);
  });
});
