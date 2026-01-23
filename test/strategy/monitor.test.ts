// Mock ethers Contract
import { vi } from "vitest";

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  
  const MockContract = vi.fn().mockImplementation((address: string, abi: any, provider: any) => {
    console.log("MockContract implementation called for address:", address);
    return {
      decimals: vi.fn().mockImplementation(async () => {
        if (address === "0xT0" || address === "0xCollat") return 6n;
        if (address === "0xT1" || address === "0xRisk") return 18n;
        return 18n;
      }),
      balanceOf: vi.fn(), 
      tokenOfOwnerByIndex: vi.fn(),
    };
  });

  // ethers v6 exports an 'ethers' object which contains Contract
  const mockedEthers = {
    ...actual.ethers,
    Contract: MockContract,
    // Add Provider if needed, but we pass mockProvider
  };

  return {
    ...actual,
    ethers: mockedEthers,
    Contract: MockContract,
  };
});

import { describe, it, expect, beforeEach } from "vitest";
import { DeltaNeutralMonitor } from "../../src/strategy/monitor";
import * as gmxReader from "../../src/modules/gmx/reader";
import * as uniswapReader from "../../src/modules/uniswap/reader";
import { ethers } from "ethers"; // Import after mock
import { StrategyAction } from "../../src/strategy/types";
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
      tokenIds: [123n],
    },
    gmx: {
      reader: "0xGMXReader",
      dataStore: "0xDataStore",
      account: "0xAccount",
      market: "0xMarket",
      collateralToken: "0xCollat", // Matches "0xCollat"
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    
    // Explicitly set implementation for ethers.Contract mock
    (ethers.Contract as any).mockImplementation((address: string, abi: any, provider: any) => {
      // console.log("MockContract implementation called for address:", address);
      return {
        decimals: vi.fn().mockImplementation(async () => {
          if (address === "0xT0" || address === "0xCollat") return 6n;
          if (address === "0xT1" || address === "0xRisk") return 18n;
          return 18n;
        }),
        balanceOf: vi.fn(), 
        tokenOfOwnerByIndex: vi.fn(),
        token0: vi.fn(), // Just in case
        token1: vi.fn(),
      };
    });
    
    // Setup mocks
    const mockPoolContract = {
      token0: vi.fn().mockResolvedValue("0xCollat"), // USDC
      token1: vi.fn().mockResolvedValue("0xRisk"),   // ETH
      slot0: vi.fn(),
      liquidity: vi.fn(),
    };
    
    vi.mocked(uniswapReader.createPool).mockReturnValue(mockPoolContract as any);
    vi.mocked(uniswapReader.createPositionManager).mockReturnValue({} as any);
    vi.mocked(gmxReader.createReader).mockReturnValue({} as any);
    
    monitor = new DeltaNeutralMonitor(mockProvider, config, context);
  });

  it("should return NONE when strategy is healthy (neutral delta)", async () => {
    // Setup Uniswap Position (Center range)
    const tickLower = -887220; 
    const tickUpper = 887220;  
    
    const centerTick = 69080;
    const tickSpacing = 60;
    const lower = centerTick - tickSpacing * 10;
    const upper = centerTick + tickSpacing * 10;
    const sqrtPriceX96 = getSqrtRatioAtTick(centerTick);
    
    const liquidity = 1000000000000000000n; 
    
    const mockPoolState: UniswapPoolState = {
      sqrtPriceX96,
      tick: centerTick,
      liquidity: liquidity,
    };
    
    const mockUniswapPosition: UniswapPosition = {
      nonce: 0n,
      operator: "0xOp",
      token0: "0xCollat", // Matches pool tokens
      token1: "0xRisk",
      fee: 3000,
      tickLower: lower,
      tickUpper: upper,
      liquidity: liquidity,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    };

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
    const lpDelta = result.status.totalLpDelta;
    
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
     const lower = centerTick + tickSpacing; 
     const upper = centerTick + tickSpacing * 2;
     
     const mockPoolState: UniswapPoolState = {
       sqrtPriceX96: getSqrtRatioAtTick(0),
       tick: 0,
       liquidity: 100n,
     };
     
     const mockUniswapPosition: UniswapPosition = {
       nonce: 0n, operator: "", 
       token0: "0xCollat", 
       token1: "0xRisk", 
       fee: 0,
       tickLower: lower,
       tickUpper: upper,
       liquidity: 100n,
       feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n, tokensOwed0: 0n, tokensOwed1: 0n
     };
 
     vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
     vi.mocked(uniswapReader.getPosition).mockResolvedValue(mockUniswapPosition);
     vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined); // No hedge yet
     
     const result = await monitor.check();
     
     expect(result.status.uniswap[0].delta.zone).not.toBe("in");
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
      nonce: 0n, operator: "", 
      token0: "0xCollat", 
      token1: "0xRisk", 
      fee: 0,
      tickLower: lower,
      tickUpper: upper,
      liquidity: liquidity,
      feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n,
      tokensOwed0: 200n, // Above threshold 100n
      tokensOwed1: 0n
    };

    vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
    vi.mocked(uniswapReader.getPosition).mockResolvedValue(mockUniswapPosition);
    
    // Run once to get delta
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
        addresses: {} as any,
        numbers: { sizeInTokens: 0n } as any,
        flags: { isLong: false }
    });
    const run1 = await monitor.check();
    const lpDelta = run1.status.totalLpDelta;
    
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