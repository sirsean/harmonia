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
import { multicallRead } from "../../src/utils/multicall";
import { ethers } from "ethers";
import { StrategyAction } from "../../src/strategy/types";
import { UniswapPoolState, UniswapPosition } from "../../src/modules/uniswap/types";
import { getSqrtRatioAtTick } from "../../src/modules/math/ticks";
import { DEFAULT_STRATEGY_CONFIG } from "../../src/config/strategy";

vi.mock("../../src/modules/gmx/reader");
vi.mock("../../src/modules/uniswap/reader");
vi.mock("../../src/utils/multicall");

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
    // Use default range width (6% = ±3% ≈ ±300 ticks) to avoid range width check
    const healthyPos = {
        ...mockUniswapPosition,
        tickLower: 69080 - 300, // Default range width
        tickUpper: 69080 + 300,
    };
    // First, get the LP delta by checking without GMX position
    vi.mocked(uniswapReader.getPosition).mockResolvedValue(healthyPos);
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(healthyPos);
    vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([{ tokenId: 123n, position: healthyPos }]);
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
    // With perfect hedge (netDelta ≈ 0), low fees, in range, and default range width, should return NONE
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
 
     // Mock a valid GMX position to pass the "missing hedge" check
     vi.mocked(gmxReader.getPosition).mockResolvedValue({
        addresses: {} as any,
        numbers: { 
          sizeInTokens: 100n, // Small hedge
          collateralAmount: 0n,
          sizeInUsd: 0n,
          shortTokenClaimableFundingAmountPerSize: 0n,
        } as any,
        flags: { isLong: false }
     }); 
     
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

  describe("token metadata caching", () => {
    it("should cache token metadata after first check()", async () => {
      const mockPoolContract = {
        token0: vi.fn().mockResolvedValue("0xCollat"),
        token1: vi.fn().mockResolvedValue("0xRisk"),
        slot0: vi.fn(),
        liquidity: vi.fn(),
      };

      vi.mocked(uniswapReader.createPool).mockReturnValue(mockPoolContract as any);
      vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);

      await monitor.check();
      await monitor.check();
      await monitor.check();

      // token0() and token1() should only be called once (cached after first check)
      expect(mockPoolContract.token0).toHaveBeenCalledTimes(1);
      expect(mockPoolContract.token1).toHaveBeenCalledTimes(1);

      // ethers.Contract should only be called twice (once per token, for decimals/symbol)
      // on the first check() only
      expect(ethers.Contract).toHaveBeenCalledTimes(2);
    });

    it("should use cached values on subsequent checks", async () => {
      vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);

      const result1 = await monitor.check();
      const result2 = await monitor.check();

      // Both checks should produce consistent results
      expect(result1.status.uniswap.length).toBe(result2.status.uniswap.length);
    });

    it("should not share cache between monitor instances", async () => {
      const mockPoolContract = {
        token0: vi.fn().mockResolvedValue("0xCollat"),
        token1: vi.fn().mockResolvedValue("0xRisk"),
        slot0: vi.fn(),
        liquidity: vi.fn(),
      };

      vi.mocked(uniswapReader.createPool).mockReturnValue(mockPoolContract as any);
      vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);

      await monitor.check();

      // Create a new monitor instance
      const monitor2 = new DeltaNeutralMonitor(mockProvider, config, context);
      await monitor2.check();

      // Each instance calls token0/token1 independently
      expect(mockPoolContract.token0).toHaveBeenCalledTimes(2);
      expect(mockPoolContract.token1).toHaveBeenCalledTimes(2);
    });
  });

  describe("multicall batched path", () => {
    const multicallContext = {
      ...context,
      multicall3: "0xMulticall3",
    };

    function buildMulticallResults(opts: {
      sqrtPriceX96: bigint;
      tick: number;
      liquidity: bigint;
      positions: UniswapPosition[];
      fees: { amount0: bigint; amount1: bigint }[];
      gmxPositions: any[];
    }) {
      const results: { success: boolean; data: any }[] = [];

      // slot0 result
      results.push({
        success: true,
        data: [opts.sqrtPriceX96, BigInt(opts.tick), 0n, 0n, 0n, 0n, true],
      });

      // liquidity result
      results.push({
        success: true,
        data: [opts.liquidity],
      });

      // Per-position: positions() then collect()
      for (let i = 0; i < opts.positions.length; i++) {
        const p = opts.positions[i];
        results.push({
          success: true,
          data: [
            p.nonce,
            p.operator,
            p.token0,
            p.token1,
            BigInt(p.fee),
            BigInt(p.tickLower),
            BigInt(p.tickUpper),
            p.liquidity,
            p.feeGrowthInside0LastX128,
            p.feeGrowthInside1LastX128,
            p.tokensOwed0,
            p.tokensOwed1,
          ],
        });

        results.push({
          success: true,
          data: [opts.fees[i].amount0, opts.fees[i].amount1],
        });
      }

      // GMX getAccountPositions
      results.push({
        success: true,
        data: [opts.gmxPositions],
      });

      return results;
    }

    it("should use multicall when multicall3 address is provided", async () => {
      const batchedMonitor = new DeltaNeutralMonitor(
        mockProvider,
        config,
        multicallContext,
      );

      vi.mocked(multicallRead).mockResolvedValue(
        buildMulticallResults({
          sqrtPriceX96: mockPoolState.sqrtPriceX96,
          tick: mockPoolState.tick,
          liquidity: mockPoolState.liquidity,
          positions: [mockUniswapPosition],
          fees: [{ amount0: 0n, amount1: 0n }],
          gmxPositions: [],
        }),
      );

      await batchedMonitor.check();

      // multicallRead should be called, not individual readers
      expect(multicallRead).toHaveBeenCalledTimes(1);
      expect(uniswapReader.getPoolState).not.toHaveBeenCalled();
      expect(uniswapReader.getPositionWithFees).not.toHaveBeenCalled();
      expect(gmxReader.getPosition).not.toHaveBeenCalled();
    });

    it("should fall back to individual calls without multicall3", async () => {
      // Default monitor has no multicall3
      vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);

      await monitor.check();

      expect(multicallRead).not.toHaveBeenCalled();
      expect(uniswapReader.getPoolState).toHaveBeenCalled();
      expect(uniswapReader.getPositionWithFees).toHaveBeenCalled();
    });

    it("should produce correct results via multicall path", async () => {
      const batchedMonitor = new DeltaNeutralMonitor(
        mockProvider,
        config,
        multicallContext,
      );

      const pos = {
        ...mockUniswapPosition,
        tickLower: 69080 - 300,
        tickUpper: 69080 + 300,
        tokensOwed0: 1000000n, // 1 USDC
      };

      vi.mocked(multicallRead).mockResolvedValue(
        buildMulticallResults({
          sqrtPriceX96: mockPoolState.sqrtPriceX96,
          tick: mockPoolState.tick,
          liquidity: mockPoolState.liquidity,
          positions: [pos],
          fees: [{ amount0: 1000000n, amount1: 0n }],
          gmxPositions: [],
        }),
      );

      const result = await batchedMonitor.check();

      expect(result.status.uniswap).toHaveLength(1);
      expect(result.status.uniswap[0].tokenId).toBe("123");
      expect(result.status.uniswap[0].unclaimedFees.amount0).toBe(1000000n);
      expect(result.status.totalLpDelta).toBeGreaterThan(0n);
    });

    it("should handle multiple positions in batch", async () => {
      const multiPosContext = {
        ...multicallContext,
        uniswap: {
          ...multicallContext.uniswap,
          tokenIds: [100n, 200n],
        },
      };

      const batchedMonitor = new DeltaNeutralMonitor(
        mockProvider,
        config,
        multiPosContext,
      );

      const pos1 = {
        ...mockUniswapPosition,
        tickLower: 69080 - 300,
        tickUpper: 69080 + 300,
      };

      const pos2 = {
        ...mockUniswapPosition,
        tickLower: 69080 - 500,
        tickUpper: 69080 + 500,
      };

      vi.mocked(multicallRead).mockResolvedValue(
        buildMulticallResults({
          sqrtPriceX96: mockPoolState.sqrtPriceX96,
          tick: mockPoolState.tick,
          liquidity: mockPoolState.liquidity,
          positions: [pos1, pos2],
          fees: [
            { amount0: 100000n, amount1: 0n },
            { amount0: 200000n, amount1: 0n },
          ],
          gmxPositions: [],
        }),
      );

      const result = await batchedMonitor.check();

      expect(result.status.uniswap).toHaveLength(2);
      expect(result.status.uniswap[0].tokenId).toBe("100");
      expect(result.status.uniswap[1].tokenId).toBe("200");
    });

    it("should handle GMX position via multicall", async () => {
      const batchedMonitor = new DeltaNeutralMonitor(
        mockProvider,
        config,
        multicallContext,
      );

      const gmxPos = {
        addresses: {
          account: "0xAccount",
          market: "0xMarket",
          collateralToken: "0xCollat",
        },
        numbers: {
          sizeInTokens: 500000000000000000n,
          collateralAmount: 100000000n,
          sizeInUsd: 1000000000000000000000000000000n,
          shortTokenClaimableFundingAmountPerSize: 0n,
          fundingFeeAmountPerSize: 0n,
        },
        flags: { isLong: false },
      };

      // findPosition is a pure function, not mocked by vi.mock
      // We need to restore it for this test
      vi.mocked(gmxReader.findPosition).mockReturnValue(gmxPos as any);

      vi.mocked(multicallRead).mockResolvedValue(
        buildMulticallResults({
          sqrtPriceX96: mockPoolState.sqrtPriceX96,
          tick: mockPoolState.tick,
          liquidity: mockPoolState.liquidity,
          positions: [mockUniswapPosition],
          fees: [{ amount0: 0n, amount1: 0n }],
          gmxPositions: [gmxPos],
        }),
      );

      const result = await batchedMonitor.check();

      expect(result.status.gmx.positionSizeTokens).toBe(500000000000000000n);
      expect(result.status.gmx.delta).toBe(-500000000000000000n);
    });

    it("should handle fee collection failure gracefully in batch", async () => {
      const batchedMonitor = new DeltaNeutralMonitor(
        mockProvider,
        config,
        multicallContext,
      );

      const results = buildMulticallResults({
        sqrtPriceX96: mockPoolState.sqrtPriceX96,
        tick: mockPoolState.tick,
        liquidity: mockPoolState.liquidity,
        positions: [mockUniswapPosition],
        fees: [{ amount0: 0n, amount1: 0n }],
        gmxPositions: [],
      });

      // Simulate fee collection failure
      results[3] = { success: false, data: [] };

      vi.mocked(multicallRead).mockResolvedValue(results);

      const result = await batchedMonitor.check();

      // Should still work, with fees defaulting to 0
      expect(result.status.uniswap).toHaveLength(1);
      expect(result.status.uniswap[0].unclaimedFees.amount0).toBe(0n);
      expect(result.status.uniswap[0].unclaimedFees.amount1).toBe(0n);
    });

    it("should skip zero-liquidity positions in batch", async () => {
      const batchedMonitor = new DeltaNeutralMonitor(
        mockProvider,
        config,
        multicallContext,
      );

      const zeroLiqPos = { ...mockUniswapPosition, liquidity: 0n };

      vi.mocked(multicallRead).mockResolvedValue(
        buildMulticallResults({
          sqrtPriceX96: mockPoolState.sqrtPriceX96,
          tick: mockPoolState.tick,
          liquidity: mockPoolState.liquidity,
          positions: [zeroLiqPos],
          fees: [{ amount0: 0n, amount1: 0n }],
          gmxPositions: [],
        }),
      );

      const result = await batchedMonitor.check();
      expect(result.status.uniswap).toHaveLength(0);
    });

    it("should send correct number of multicall requests", async () => {
      const twoTokenContext = {
        ...multicallContext,
        uniswap: {
          ...multicallContext.uniswap,
          tokenIds: [100n, 200n, 300n],
        },
      };

      const batchedMonitor = new DeltaNeutralMonitor(
        mockProvider,
        config,
        twoTokenContext,
      );

      vi.mocked(multicallRead).mockResolvedValue(
        buildMulticallResults({
          sqrtPriceX96: mockPoolState.sqrtPriceX96,
          tick: mockPoolState.tick,
          liquidity: mockPoolState.liquidity,
          positions: [mockUniswapPosition, mockUniswapPosition, mockUniswapPosition],
          fees: [
            { amount0: 0n, amount1: 0n },
            { amount0: 0n, amount1: 0n },
            { amount0: 0n, amount1: 0n },
          ],
          gmxPositions: [],
        }),
      );

      await batchedMonitor.check();

      // Verify multicallRead was called with the right number of requests:
      // 2 (slot0 + liquidity) + 3*2 (positions + collect per tokenId) + 1 (GMX) = 9
      const calls = vi.mocked(multicallRead).mock.calls[0];
      expect(calls[2]).toHaveLength(9); // requests array
    });
  });
});
