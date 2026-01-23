// Mock ethers Contract
import { vi } from "vitest";

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  
  const MockContract = vi.fn().mockImplementation((address: string, abi: any, provider: any) => {
    return {
      decimals: vi.fn().mockImplementation(async () => {
        if (address === "0xT0" || address === "0xCollat") return 6n;
        if (address === "0xT1" || address === "0xRisk") return 18n;
        return 18n;
      }),
      balanceOf: vi.fn(), 
      tokenOfOwnerByIndex: vi.fn(),
      token0: vi.fn(),
      token1: vi.fn(),
    };
  });

  const mockedEthers = {
    ...actual.ethers,
    Contract: MockContract,
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
import { ethers } from "ethers"; 
import { StrategyAction } from "../../src/strategy/types";
import { UniswapPoolState, UniswapPosition } from "../../src/modules/uniswap/types";
import { getSqrtRatioAtTick } from "../../src/modules/math/ticks";

vi.mock("../../src/modules/gmx/reader");
vi.mock("../../src/modules/uniswap/reader");

const mockProvider = {} as ethers.Provider;

describe("DeltaNeutralMonitor", () => {
  let monitor: DeltaNeutralMonitor;
  
  // Common mocks
  const mockPoolState: UniswapPoolState = {
    sqrtPriceX96: getSqrtRatioAtTick(69080),
    tick: 69080,
    liquidity: 1000000000000000000n,
  };
  
  const mockUniswapPosition: UniswapPosition = {
    nonce: 0n,
    operator: "0xOp",
    token0: "0xCollat", 
    token1: "0xRisk",
    fee: 3000,
    tickLower: 69080 - 600,
    tickUpper: 69080 + 600,
    liquidity: 1000000000000000000n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
  };

  const config = {
    deltaThreshold: 0.05, 
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
      collateralToken: "0xCollat", 
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    
    // Explicitly set implementation for ethers.Contract mock to ensure stability
    (ethers.Contract as any).mockImplementation((address: string, abi: any, provider: any) => {
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
    
    const mockPoolContract = {
      token0: vi.fn().mockResolvedValue("0xCollat"), 
      token1: vi.fn().mockResolvedValue("0xRisk"),   
      slot0: vi.fn(),
      liquidity: vi.fn(),
    };
    
    vi.mocked(uniswapReader.createPool).mockReturnValue(mockPoolContract as any);
    vi.mocked(uniswapReader.createPositionManager).mockReturnValue({} as any);
    vi.mocked(gmxReader.createReader).mockReturnValue({} as any);
    
    // Default mocks for reader functions
    vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
    vi.mocked(uniswapReader.getPosition).mockResolvedValue(mockUniswapPosition);
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(mockUniswapPosition);
    vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([{ tokenId: 123n, position: mockUniswapPosition }]);

    monitor = new DeltaNeutralMonitor(mockProvider, config, context);
  });

  it("should return NONE when strategy is healthy (neutral delta)", async () => {
    // Determine LP delta first to set correct hedge
    // We can assume perfect hedge for this test
    const lpDelta = 500000000000000000n; // Approx
    
    // First pass: GMX size 0. Should be REBALANCE.
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
    
    // Second pass: Perfect hedge
    const targetDelta = result.status.totalLpDelta;
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
      addresses: {} as any,
      numbers: {
        sizeInTokens: targetDelta, 
        shortTokenClaimableFundingAmountPerSize: 0n,
      } as any,
      flags: { isLong: false },
    });
    
    result = await monitor.check();
    expect(result.recommendation.action).toBe(StrategyAction.NONE);
  });

  it("should recommend ADJUST_RANGE when out of range", async () => {
     // Override position to be out of range
     const outOfRangePos = {
         ...mockUniswapPosition,
         tickLower: 0,
         tickUpper: 100,
         liquidity: 100n,
     };
     // Pool is at 69080
     
     vi.mocked(uniswapReader.getPosition).mockResolvedValue(outOfRangePos);
     vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(outOfRangePos);
     vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([{ tokenId: 123n, position: outOfRangePos }]);
 
     vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined); 
     
     const result = await monitor.check();
     
     expect(result.recommendation.action).toBe(StrategyAction.ADJUST_RANGE);
  });

  it("should recommend COMPOUND when fees are high", async () => {
    // Healthy delta but high fees
    const highFeesPos = {
        ...mockUniswapPosition,
        tokensOwed0: 200n, // Above threshold
    };

    vi.mocked(uniswapReader.getPosition).mockResolvedValue(highFeesPos);
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(highFeesPos);
    vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([{ tokenId: 123n, position: highFeesPos }]);
    
    // Run to get delta
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
        addresses: {} as any,
        numbers: { sizeInTokens: 0n } as any,
        flags: { isLong: false }
    });
    const run1 = await monitor.check();
    const targetDelta = run1.status.totalLpDelta;
    
    // Set perfect hedge
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
        addresses: {} as any,
        numbers: { sizeInTokens: targetDelta } as any,
        flags: { isLong: false }
    });
    
    const result = await monitor.check();
    expect(result.recommendation.action).toBe(StrategyAction.COMPOUND);
  });
});
