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
vi.mock("../../src/utils/multicall");

const mockProvider = {} as ethers.Provider;

describe("DeltaNeutralMonitor Recovery Scenarios", () => {
  let monitor: DeltaNeutralMonitor;
  
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
    
    vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
    
    monitor = new DeltaNeutralMonitor(mockProvider, config, context);
  });

  it("should recommend OPTIMIZE when NO positions exist (Recovery Mode)", async () => {
    // Mock no active Uniswap positions
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue({
        ...mockUniswapPosition,
        liquidity: 0n
    });
    vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([]);

    // Mock no active GMX position
    vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);

    const result = await monitor.check();

    expect(result.recommendation.action).toBe(StrategyAction.OPTIMIZE);
    expect(result.recommendation.reason).toContain("No active positions found");
  });

  it("should recommend OPTIMIZE when GMX short exists but NO active LP positions", async () => {
    // Mock no active Uniswap positions
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue({
        ...mockUniswapPosition,
        liquidity: 0n
    });
    vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([]);

    // Mock active GMX position
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
        addresses: {} as any,
        numbers: { 
          sizeInTokens: 1000000000000000000n, // 1 ETH short
          collateralAmount: 2000000000n,
          sizeInUsd: 3000n * 10n**30n,
          shortTokenClaimableFundingAmountPerSize: 0n,
        } as any,
        flags: { isLong: false }
    });

    const result = await monitor.check();

    expect(result.recommendation.action).toBe(StrategyAction.OPTIMIZE);
    // Explicit reason is preferred, but fallback to drift check is also acceptable if strict
    // But we are testing for the NEW explicit check
    expect(result.recommendation.reason).toContain("GMX short exists without active LP positions");
  });

  it("should recommend OPTIMIZE when Active LP positions exist but NO GMX hedge", async () => {
    // Mock active Uniswap position
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(mockUniswapPosition);
    vi.mocked(uniswapReader.getActivePositionsForOwner).mockResolvedValue([{
        tokenId: 123n,
        position: mockUniswapPosition
    }]);

    // Mock no GMX position
    vi.mocked(gmxReader.getPosition).mockResolvedValue(undefined);

    const result = await monitor.check();

    expect(result.recommendation.action).toBe(StrategyAction.OPTIMIZE);
    expect(result.recommendation.reason).toContain("Active LP positions exist without GMX hedge");
  });

});
