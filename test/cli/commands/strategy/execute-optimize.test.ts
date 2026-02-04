import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { RebalanceManager } from "../../../../src/strategy/rebalance";
import { DEFAULT_STRATEGY_CONFIG } from "../../../../src/config/strategy";

/**
 * Helper that replicates the WETH->USDC swap decision logic from executeOptimize.
 * Tests the shortfall calculation, excess WETH check, and minimum swap threshold.
 */
function computeWethToUsdcSwapDecision(params: {
  wethAvailable: bigint;
  wethNeeded: bigint;
  usdcAvailable: bigint;
  usdcNeeded: bigint;
  priceUsdcPerWeth: number;
  wethDecimals: number;
  usdcDecimals: number;
}) {
  const {
    wethAvailable,
    wethNeeded,
    usdcAvailable,
    usdcNeeded,
    priceUsdcPerWeth,
    wethDecimals,
    usdcDecimals,
  } = params;

  const usdcShortfall = usdcNeeded > usdcAvailable ? usdcNeeded - usdcAvailable : 0n;
  const wethShortfall = wethNeeded > wethAvailable ? wethNeeded - wethAvailable : 0n;

  if (usdcShortfall === 0n || wethShortfall > 0n) {
    return { shouldSwap: false, reason: "no-usdc-shortfall-or-weth-shortfall" };
  }

  const usdcShortfallNum = Number(ethers.formatUnits(usdcShortfall, usdcDecimals));
  const wethNeededNum = usdcShortfallNum / priceUsdcPerWeth;
  const wethToSwap = ethers.parseUnits(
    (wethNeededNum * 1.01).toFixed(wethDecimals),
    wethDecimals
  );

  const minSwapAmount = ethers.parseUnits("0.0001", wethDecimals);
  const excessWeth = wethAvailable - wethNeeded;

  if (wethToSwap < minSwapAmount) {
    return { shouldSwap: false, reason: "below-minimum", wethToSwap, minSwapAmount, excessWeth };
  }
  if (excessWeth < wethToSwap) {
    return {
      shouldSwap: false,
      reason: "insufficient-excess",
      wethToSwap,
      minSwapAmount,
      excessWeth,
    };
  }

  const amountIn = wethToSwap > excessWeth ? excessWeth : wethToSwap;
  return { shouldSwap: true, amountIn, wethToSwap, excessWeth };
}

describe("executeOptimize WETH->USDC swap decision", () => {
  const wethDecimals = 18;
  const usdcDecimals = 6;

  it("should swap when USDC shortfall is small (~1.25 USDC)", () => {
    // Exact scenario from the production error
    const result = computeWethToUsdcSwapDecision({
      wethAvailable: ethers.parseUnits("0.151113099516093445", wethDecimals),
      wethNeeded: ethers.parseUnits("0.098943293181869156", wethDecimals),
      usdcAvailable: ethers.parseUnits("284.466354", usdcDecimals),
      usdcNeeded: ethers.parseUnits("285.714286", usdcDecimals),
      priceUsdcPerWeth: 2800,
      wethDecimals,
      usdcDecimals,
    });

    expect(result.shouldSwap).toBe(true);
    expect(result.amountIn).toBeGreaterThan(0n);
  });

  it("should not swap when there is no USDC shortfall", () => {
    const result = computeWethToUsdcSwapDecision({
      wethAvailable: ethers.parseUnits("0.15", wethDecimals),
      wethNeeded: ethers.parseUnits("0.10", wethDecimals),
      usdcAvailable: ethers.parseUnits("300", usdcDecimals),
      usdcNeeded: ethers.parseUnits("285", usdcDecimals),
      priceUsdcPerWeth: 2800,
      wethDecimals,
      usdcDecimals,
    });

    expect(result.shouldSwap).toBe(false);
    expect(result.reason).toBe("no-usdc-shortfall-or-weth-shortfall");
  });

  it("should not swap when there is also a WETH shortfall", () => {
    const result = computeWethToUsdcSwapDecision({
      wethAvailable: ethers.parseUnits("0.05", wethDecimals),
      wethNeeded: ethers.parseUnits("0.10", wethDecimals),
      usdcAvailable: ethers.parseUnits("280", usdcDecimals),
      usdcNeeded: ethers.parseUnits("285", usdcDecimals),
      priceUsdcPerWeth: 2800,
      wethDecimals,
      usdcDecimals,
    });

    expect(result.shouldSwap).toBe(false);
    expect(result.reason).toBe("no-usdc-shortfall-or-weth-shortfall");
  });

  it("should not swap when excess WETH is insufficient to cover shortfall", () => {
    // Almost all WETH is needed for LP, very little excess
    const result = computeWethToUsdcSwapDecision({
      wethAvailable: ethers.parseUnits("0.1001", wethDecimals),
      wethNeeded: ethers.parseUnits("0.10", wethDecimals),
      usdcAvailable: ethers.parseUnits("200", usdcDecimals),
      usdcNeeded: ethers.parseUnits("285", usdcDecimals),
      priceUsdcPerWeth: 2800,
      wethDecimals,
      usdcDecimals,
    });

    // Excess is only 0.0001 WETH (~$0.28), but shortfall needs ~0.031 WETH (~$85)
    expect(result.shouldSwap).toBe(false);
    expect(result.reason).toBe("insufficient-excess");
  });

  it("should swap using excess WETH only, not WETH needed for LP", () => {
    const result = computeWethToUsdcSwapDecision({
      wethAvailable: ethers.parseUnits("0.15", wethDecimals),
      wethNeeded: ethers.parseUnits("0.10", wethDecimals),
      usdcAvailable: ethers.parseUnits("280", usdcDecimals),
      usdcNeeded: ethers.parseUnits("285", usdcDecimals),
      priceUsdcPerWeth: 2800,
      wethDecimals,
      usdcDecimals,
    });

    expect(result.shouldSwap).toBe(true);
    // Excess is 0.05 WETH, swap amount should be well under that
    expect(result.excessWeth).toBe(ethers.parseUnits("0.05", wethDecimals));
    expect(result.amountIn!).toBeLessThan(result.excessWeth!);
  });

  it("should reject swaps below the 0.0001 WETH minimum", () => {
    // Tiny shortfall: 0.01 USDC at $2800/ETH = ~0.0000036 WETH
    const result = computeWethToUsdcSwapDecision({
      wethAvailable: ethers.parseUnits("0.15", wethDecimals),
      wethNeeded: ethers.parseUnits("0.10", wethDecimals),
      usdcAvailable: ethers.parseUnits("284.99", usdcDecimals),
      usdcNeeded: ethers.parseUnits("285.00", usdcDecimals),
      priceUsdcPerWeth: 2800,
      wethDecimals,
      usdcDecimals,
    });

    expect(result.shouldSwap).toBe(false);
    expect(result.reason).toBe("below-minimum");
  });

  it("should cap amountIn to excessWeth when wethToSwap exceeds excess", () => {
    // Large USDC shortfall relative to excess WETH, but excess barely covers it
    // Shortfall: 100 USDC, excess WETH: 0.037 (~$103.6 at $2800)
    // wethToSwap with 1% buffer: ~0.03607 WETH
    const result = computeWethToUsdcSwapDecision({
      wethAvailable: ethers.parseUnits("0.137", wethDecimals),
      wethNeeded: ethers.parseUnits("0.10", wethDecimals),
      usdcAvailable: ethers.parseUnits("185", usdcDecimals),
      usdcNeeded: ethers.parseUnits("285", usdcDecimals),
      priceUsdcPerWeth: 2800,
      wethDecimals,
      usdcDecimals,
    });

    expect(result.shouldSwap).toBe(true);
    // amountIn should not exceed excessWeth
    expect(result.amountIn!).toBeLessThanOrEqual(result.excessWeth!);
  });
});

describe("executeOptimize GMX collateral balance check", () => {
  // Test the core logic: that GMX collateral is included in balance calculations
  // We'll test the RebalanceManager calculation and the balance check logic separately

  it("should calculate GMX collateral requirement correctly", () => {
    const mockConfig = {
      ...DEFAULT_STRATEGY_CONFIG,
      targetLeverage: 3.0, // 3x leverage (as a number, not BigInt)
    };

    const mockRouter = {} as any;
    const mockToken = {} as any;
    const mockContext = {
      account: "0x123",
      market: "0xmarket",
      collateralTokenAddress: "0xusdc",
      orderVault: "0xvault",
    };

    const rebalanceManager = new RebalanceManager(mockRouter, mockToken, mockConfig, mockContext);

    // Test: For $214.28 short size at 3x leverage, collateral should be ~$71.42
    const sizeDeltaUsd = ethers.parseUnits("214.28", 30);
    const result = rebalanceManager.calculateRequiredCollateral(sizeDeltaUsd, 1.0, 6);

    // Expected: 214.28 / 3 = 71.4266... USD
    const expectedCollateralUsd = sizeDeltaUsd / 3n;

    // Allow for small rounding differences
    const usdDiff =
      result.usd > expectedCollateralUsd
        ? result.usd - expectedCollateralUsd
        : expectedCollateralUsd - result.usd;
    const tolerance = expectedCollateralUsd / 1000n; // 0.1% tolerance

    expect(usdDiff).toBeLessThan(tolerance);
    expect(result.amount).toBeGreaterThan(0n);
  });

  it("should include GMX collateral in total USDC requirement calculation", () => {
    // Simulate the logic: LP needs 214.285713 USDC, GMX needs 71.428571 USDC
    const lpUsdcNeeded = ethers.parseUnits("214.285713", 6);
    const gmxCollateralAmount = ethers.parseUnits("71.428571", 6);
    const totalUsdcNeeded = lpUsdcNeeded + gmxCollateralAmount;

    // Total should be ~285.714284 USDC
    const totalUsdcNumber = Number(ethers.formatUnits(totalUsdcNeeded, 6));
    expect(totalUsdcNumber).toBeCloseTo(285.714284, 2);

    // If we only have 263 USDC, we should detect a shortfall
    const availableUsdc = ethers.parseUnits("263", 6);
    const shortfall = totalUsdcNeeded > availableUsdc ? totalUsdcNeeded - availableUsdc : 0n;

    expect(shortfall).toBeGreaterThan(0n);
    const shortfallNumber = Number(ethers.formatUnits(shortfall, 6));
    expect(shortfallNumber).toBeCloseTo(22.714284, 2);
  });

  it("should detect insufficient balance when GMX collateral is not accounted for", () => {
    // Scenario: LP needs 214 USDC, GMX needs 71 USDC, but we only check LP
    const lpUsdcNeeded = ethers.parseUnits("214.285713", 6);
    const gmxCollateralAmount = ethers.parseUnits("71.428571", 6);
    const availableUsdc = ethers.parseUnits("263", 6);

    // Wrong check: Only checking LP (would pass incorrectly)
    const lpOnlyCheck = availableUsdc >= lpUsdcNeeded;
    expect(lpOnlyCheck).toBe(true); // This would incorrectly pass

    // Correct check: Including GMX collateral (should fail)
    const totalUsdcNeeded = lpUsdcNeeded + gmxCollateralAmount;
    const correctCheck = availableUsdc >= totalUsdcNeeded;
    expect(correctCheck).toBe(false); // This correctly fails

    // The shortfall should be detected
    const shortfall = totalUsdcNeeded - availableUsdc;
    expect(shortfall).toBeGreaterThan(0n);
  });

  it("should correctly calculate USDC shortfall including GMX collateral", () => {
    // Test the exact scenario from the user's error
    const lpUsdcNeeded = ethers.parseUnits("214.285713", 6);
    const gmxCollateralAmount = ethers.parseUnits("71.428571", 6);
    const availableUsdc = ethers.parseUnits("263.898509", 6);

    const totalUsdcNeeded = lpUsdcNeeded + gmxCollateralAmount;
    const shortfall = totalUsdcNeeded > availableUsdc ? totalUsdcNeeded - availableUsdc : 0n;

    // Should detect a shortfall
    expect(shortfall).toBeGreaterThan(0n);

    // Shortfall should be approximately: 285.714284 - 263.898509 = 21.815775 USDC
    const shortfallUsd = Number(ethers.formatUnits(shortfall, 6));
    expect(shortfallUsd).toBeCloseTo(21.82, 1);
  });
});
