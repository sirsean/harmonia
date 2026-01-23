import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeltaNeutralMonitor } from "../../src/strategy/monitor";
import * as gmxReader from "../../src/modules/gmx/reader";
import * as uniswapReader from "../../src/modules/uniswap/reader";
import { ethers } from "ethers";
import { StrategyAction } from "../../src/strategy/types";
import { GMXPosition } from "../../src/modules/gmx/types";
import { UniswapPoolState, UniswapPosition } from "../../src/modules/uniswap/types";
import { getSqrtRatioAtTick } from "../../src/modules/math/ticks";

// Mock the readers
vi.mock("../../src/modules/gmx/reader");
vi.mock("../../src/modules/uniswap/reader");

// Mock provider
const mockProvider = {} as ethers.Provider;

describe("DeltaNeutralMonitor", () => {
  let monitor: DeltaNeutralMonitor;
  const config = {
    deltaThreshold: 0.05, // 5%
    minFeeThreshold: 100n,
    minRebalanceInterval: 3600,
  };
  const context = {
    uniswap: {
      positionManager: "0xPM",
      pool: "0xPool",
      tokenId: 123n,
    },
    gmx: {
      reader: "0xGMXReader",
      dataStore: "0xDataStore",
      account: "0xAccount",
      market: "0xMarket",
      collateralToken: "0xCollat",
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    monitor = new DeltaNeutralMonitor(mockProvider, config, context);
    
    // Default mocks
    (uniswapReader.createPool as any).mockReturnValue({});
    (uniswapReader.createPositionManager as any).mockReturnValue({});
    (gmxReader.createReader as any).mockReturnValue({});
  });

  it("should return NONE when strategy is healthy (neutral delta)", async () => {
    // Setup Uniswap Position (Center range)
    const tickLower = -887220; // Min tick approx
    const tickUpper = 887220;  // Max tick approx
    const currentTick = 0;
    
    // If range is massive, delta is basically liquidity.
    // Let's use a tighter range for realistic delta
    // Price = 1000. SqrtPrice = sqrt(1000) * 2^96
    // tick = log(1.0001, 1000) ~= 69080
    const centerTick = 69080;
    const tickSpacing = 60;
    const lower = centerTick - tickSpacing * 10;
    const upper = centerTick + tickSpacing * 10;
    const sqrtPriceX96 = getSqrtRatioAtTick(centerTick);
    
    const liquidity = 1000000000000000000n; // 1 ETH roughly in wei terms if full range, just a number here
    
    const mockPoolState: UniswapPoolState = {
      sqrtPriceX96,
      tick: centerTick,
      liquidity: liquidity,
    };
    
    const mockUniswapPosition: UniswapPosition = {
      nonce: 0n,
      operator: "0xOp",
      token0: "0xT0",
      token1: "0xT1",
      fee: 3000,
      tickLower: lower,
      tickUpper: upper,
      liquidity: liquidity,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    };

    // Calculate approximate delta for this position to match with GMX
    // At center of range, delta is roughly 0.5 * liquidity (if simplified) 
    // or we just let the monitor calculate it and we mock GMX to match it.
    // Instead of calculating exactly in test setup, we can rely on the monitor to calculate LP delta
    // and then providing a GMX position that perfectly hedges it.
    // BUT we need to know the LP delta to set up the mock GMX position.
    
    // Let's run a "pre-calculation" logic or use a fixed scenario where we know the delta.
    // OR, we can mock `calculateDelta` itself if we want to decouple. 
    // Let's stick to real calculation but use values where we know the result roughly?
    // No, better to inspect the result or use a simpler mock for `calculateDelta`.
    // Actually, checking `calculateDelta` is integrated is good.
    
    // Let's first mock GMX with 0 size, run check, see the LP Delta, then update test?
    // No, that's manual.
    
    // Let's Assume LP Delta is X.
    // We can spy on calculateDelta? No it's a direct import.
    
    // Let's construct a scenario.
    // Price = 1.0 (Tick 0). Range -100 to +100.
    // Liquidity = 1000.
    // SqrtPrice = 2^96.
    // Pa = 0.995... Pb = 1.005...
    // Delta should be approx 0.5 * Liquidity (adjusted for decimals).
    
    // Let's try to mock GMX with a size that is likely "wrong" and see REBALANCE, 
    // then "correct" size and see NONE.
    
    vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
    vi.mocked(uniswapReader.getPosition).mockResolvedValue(mockUniswapPosition);
    
    // First pass: GMX size 0. Should be HUGE drift.
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
      addresses: {} as any,
      numbers: {
        sizeInTokens: 0n,
        shortTokenClaimableFundingAmountPerSize: 0n,
      } as any,
      flags: { isLong: false },
    });
    
    let result = await monitor.check();
    expect(result.recommendation.action).toBe(StrategyAction.REBALANCE);
    
    // Now get the calculated LP delta from the result
    const lpDelta = result.status.uniswap.delta.delta;
    
    // Second pass: GMX size matches LP Delta
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
      addresses: {} as any,
      numbers: {
        sizeInTokens: lpDelta, // Perfect hedge
        shortTokenClaimableFundingAmountPerSize: 0n,
      } as any,
      flags: { isLong: false },
    });
    
    result = await monitor.check();
    expect(result.recommendation.action).toBe(StrategyAction.NONE);
    expect(result.status.deltaDrift).toBe(0);
  });

  it("should recommend ADJUST_RANGE when out of range", async () => {
     // Setup Uniswap Position (Out of range)
     const centerTick = 0;
     const tickSpacing = 60;
     const lower = centerTick + tickSpacing; // Above current price
     const upper = centerTick + tickSpacing * 2;
     
     // Current price is at 0, range starts at 60. We are "below" the range (Price < Lower).
     // Wait, if Price < Lower, we are fully in token0 (or token1 depending on definition).
     // If current tick < tickLower, price is below range.
     
     const mockPoolState: UniswapPoolState = {
       sqrtPriceX96: getSqrtRatioAtTick(0),
       tick: 0,
       liquidity: 100n,
     };
     
     const mockUniswapPosition: UniswapPosition = {
       nonce: 0n, operator: "", token0: "", token1: "", fee: 0,
       tickLower: lower,
       tickUpper: upper,
       liquidity: 100n,
       feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n, tokensOwed0: 0n, tokensOwed1: 0n
     };
 
     vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
     vi.mocked(uniswapReader.getPosition).mockResolvedValue(mockUniswapPosition);
     vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined); // No hedge yet
     
     const result = await monitor.check();
     
     expect(result.status.uniswap.delta.zone).not.toBe("in");
     expect(result.recommendation.action).toBe(StrategyAction.ADJUST_RANGE);
  });

  it("should recommend COMPOUND when fees are high", async () => {
    // Healthy delta/range, but high fees
    const centerTick = 69080;
    const lower = centerTick - 1000;
    const upper = centerTick + 1000;
    const liquidity = 1000000n;
    const sqrtPriceX96 = getSqrtRatioAtTick(centerTick);
    
    const mockPoolState: UniswapPoolState = {
      sqrtPriceX96, tick: centerTick, liquidity
    };
    
    const mockUniswapPosition: UniswapPosition = {
      nonce: 0n, operator: "", token0: "", token1: "", fee: 0,
      tickLower: lower,
      tickUpper: upper,
      liquidity,
      feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n,
      tokensOwed0: 200n, // Above threshold 100n
      tokensOwed1: 0n
    };

    vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
    vi.mocked(uniswapReader.getPosition).mockResolvedValue(mockUniswapPosition);
    
    // We need to match delta so we don't trigger REBALANCE (which is checked before COMPOUND in logic?)
    // In my logic: 1. Adjust Range, 2. Rebalance, 3. Compound.
    // So we must be in range and balanced.
    
    // Run once to get delta
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
        addresses: {} as any,
        numbers: { sizeInTokens: 0n } as any,
        flags: { isLong: false }
    });
    const run1 = await monitor.check();
    const lpDelta = run1.status.uniswap.delta.delta;
    
    // Set perfect hedge
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
        addresses: {} as any,
        numbers: { sizeInTokens: lpDelta } as any,
        flags: { isLong: false }
    });
    
    const result = await monitor.check();
    expect(result.recommendation.action).toBe(StrategyAction.COMPOUND);
  });
});
