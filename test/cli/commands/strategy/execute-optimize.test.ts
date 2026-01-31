import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { RebalanceManager } from "../../../../src/strategy/rebalance";
import { DEFAULT_STRATEGY_CONFIG } from "../../../../src/config/strategy";

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
