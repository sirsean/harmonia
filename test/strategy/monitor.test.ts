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
import { DEFAULT_STRATEGY_CONFIG } from "../../src/config/strategy";

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
    ...DEFAULT_STRATEGY_CONFIG,
    minOptimizationFeeThresholdUsd: ethers.parseUnits("5", 30),
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
        symbol: vi.fn().mockImplementation(async () => {
          if (address === "0xCollat") return "USDC";
          if (address === "0xRisk") return "ETH";
          return "TOKEN";
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
    // First, get the LP delta by checking without GMX position
    vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);
    const initialResult = await monitor.check();
    const lpDelta = initialResult.status.totalLpDelta;
    
    // Now set GMX position to perfectly hedge the LP delta
    // GMX delta = -sizeInTokens, so we need sizeInTokens = lpDelta to get netDelta = 0
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
      addresses: {} as any,
      numbers: {
        sizeInTokens: lpDelta, // Perfect hedge: GMX delta = -lpDelta, netDelta = lpDelta + (-lpDelta) = 0
        collateralAmount: 0n,
        sizeInUsd: 0n,
        shortTokenClaimableFundingAmountPerSize: 0n,
      } as any,
      flags: { isLong: false },
    });
    
    const result = await monitor.check();
    // With perfect hedge (netDelta ≈ 0), low fees, and in range, should return NONE
    expect(result.recommendation.action).toBe(StrategyAction.NONE);
  });

  it("should recommend OPTIMIZE when out of range", async () => {
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
     
     // Out of range is critical - should always optimize
     expect(result.recommendation.action).toBe(StrategyAction.OPTIMIZE);
     expect(result.recommendation.reason).toContain("out of range");
  });

  it("should recommend OPTIMIZE when fees are high", async () => {
    // Healthy delta but high fees
    // Use a range width matching default (6% = ±3%) to avoid range width check triggering
    // At tick 69080, ±3% ≈ ±300 ticks for 6% total width
    const highFeesPos = {
        ...mockUniswapPosition,
        tickLower: 69080 - 300, // Tighter range matching default
        tickUpper: 69080 + 300,
        tokensOwed0: 6000000n, // 6 USDC ($6) > $5 threshold
    };

    vi.mocked(uniswapReader.getPosition).mockResolvedValue(highFeesPos);
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(highFeesPos);
    vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([{ tokenId: 123n, position: highFeesPos }]);
    
    // First get LP delta to set perfect hedge
    vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);
    const initialResult = await monitor.check();
    const lpDelta = initialResult.status.totalLpDelta;
    
    // Set perfect hedge to avoid delta drift trigger
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
        addresses: {} as any,
        numbers: { 
          sizeInTokens: lpDelta, // Perfect hedge
          collateralAmount: 0n,
          sizeInUsd: 0n,
          shortTokenClaimableFundingAmountPerSize: 0n,
        } as any,
        flags: { isLong: false }
    });
    
    const result = await monitor.check();
    // High fees should trigger optimization if benefit/cost is favorable
    expect(result.recommendation.action).toBe(StrategyAction.OPTIMIZE);
    expect(result.recommendation.reason).toContain("fees");
  });

  it("should recommend OPTIMIZE when range width exceeds configured default", async () => {
    // Create a position with wider range than default (0.15 = 15%)
    // Default is ±7.5%, so we'll create ±10% (20% total = 0.2)
    // This should trigger optimization since 0.2 > 0.15 * 1.1 (10% tolerance)
    
    // Calculate ticks for a ±10% range (20% total width)
    // For tick 69080, price is approximately 1.0001^69080
    // ±10% means lower = price * 0.9, upper = price * 1.1
    // We need ticks that create a range wider than ±7.5%
    // Using a much wider range to ensure it triggers: ±15% (30% total)
    const centerTick = 69080;
    const wideRangePos = {
        ...mockUniswapPosition,
        tickLower: centerTick - 1500, // Much wider range
        tickUpper: centerTick + 1500,
        liquidity: 100n,
        tokensOwed0: 6000000n, // Add fees to make it worthwhile
    };

    vi.mocked(uniswapReader.getPosition).mockResolvedValue(wideRangePos);
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(wideRangePos);
    vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([{ tokenId: 123n, position: wideRangePos }]);

    // Set GMX position to match LP delta to avoid delta drift trigger
    const lpDelta = 500000000000000000n;
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
        addresses: {} as any,
        numbers: { 
          sizeInTokens: lpDelta,
          collateralAmount: 0n,
          sizeInUsd: 0n,
          shortTokenClaimableFundingAmountPerSize: 0n,
        } as any,
        flags: { isLong: false }
    });
    
    const result = await monitor.check();
    
    // Should recommend optimization due to wide range and fees
    // The check compares (priceUpper - priceLower) / priceCenter to defaultRangeWidth * 1.1
    // With a ±15% range (30% total), this should definitely trigger
    expect(result.recommendation.action).toBe(StrategyAction.OPTIMIZE);
  });
});
