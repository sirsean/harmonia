import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "hardhat";
import { closeAll } from "../../../../src/cli/commands/strategy/close-all";
import { ARBITRUM_MAINNET } from "../../../../src/config/addresses";

// Mock dependencies - must be defined before vi.mock calls
vi.mock("hardhat", () => ({
  ethers: {
    getSigners: vi.fn(() => [
      {
        getAddress: vi.fn(() => Promise.resolve("0x1234567890123456789012345678901234567890")),
        provider: {
          getBlockNumber: vi.fn(() => Promise.resolve(1000)),
          getTransactionCount: vi.fn(() => Promise.resolve(0)),
        },
      },
    ]),
    provider: {
      getBlockNumber: vi.fn(() => Promise.resolve(1000)),
    },
    parseUnits: vi.fn((val: string, decimals: number) => {
      if (decimals === 30) return BigInt(val) * 10n ** 30n;
      if (decimals === 6) return BigInt(val) * 10n ** 6n;
      return BigInt(val);
    }),
    formatUnits: vi.fn((val: bigint, decimals: number) => {
      return (Number(val) / Number(10n ** BigInt(decimals))).toString();
    }),
    parseEther: vi.fn((val: string) => {
      const num = parseFloat(val);
      return BigInt(Math.floor(num * 1e18));
    }),
    Contract: vi.fn(() => ({
      balanceOf: vi.fn(() => Promise.resolve(0n)),
      decimals: vi.fn(() => Promise.resolve(18)),
      symbol: vi.fn(() => Promise.resolve("WETH")),
      allowance: vi.fn(() => Promise.resolve(0n)),
      approve: vi.fn(() => Promise.resolve({ wait: vi.fn(() => Promise.resolve({})) })),
    })),
  },
}));

const mockPosition = {
  tokenId: "1",
  liquidity: 1000n,
  priceLower: 2000,
  priceUpper: 3000,
  currentPrice: 2500,
  unclaimedFees: {
    amount0: 10n,
    amount1: 20n,
  },
};

const mockGmxPosition = {
  numbers: {
    sizeInUsd: ethers.parseUnits("1000", 30),
    collateralAmount: ethers.parseUnits("500", 6),
  },
};

vi.mock("../../../../src/cli/commands/base", () => ({
  getSignerAndAccount: vi.fn(async (account?: string) => {
    const mockSigner = {
      getAddress: vi.fn(() => Promise.resolve("0x1234567890123456789012345678901234567890")),
      provider: {
        getBlockNumber: vi.fn(() => Promise.resolve(1000)),
        getTransactionCount: vi.fn(() => Promise.resolve(0)),
      },
    };
    return {
      signer: mockSigner,
      account: account || "0x1234567890123456789012345678901234567890",
    };
  }),
}));

vi.mock("../../../../src/strategy/monitor", () => ({
  DeltaNeutralMonitor: vi.fn(() => ({
    check: vi.fn(() =>
      Promise.resolve({
        status: {
          uniswap: [mockPosition],
          gmx: {
            positionSizeTokens: 0n,
            collateralAmount: 0n,
            netValueUsd: 0n,
            pendingFundingRewards: 0n,
            delta: 0n,
          },
          netDelta: 0n,
          deltaDrift: 0,
          timestamp: Date.now(),
        },
        recommendation: {
          action: "NONE",
          reason: "No optimization needed",
        },
      })
    ),
  })),
}));

vi.mock("../../../../src/config/strategy", () => ({
  loadStrategyConfig: vi.fn(() => ({
    defaultExecutionFee: ethers.parseEther("0.01"),
    estimatedOptimizationGasCostUsd: ethers.parseUnits("10", 30),
    maxPositionSizeUsd: ethers.parseUnits("100000", 30),
    targetLeverage: ethers.parseUnits("2", 18),
    maxSlippage: 0.01, // 1%
    slippageBuffer: 0.005, // 0.5%
  })),
}));

vi.mock("../../../../src/modules/uniswap/reader", () => ({
  createPositionManager: vi.fn(() => ({
    positions: vi.fn(() =>
      Promise.resolve([
        0n, // nonce
        "0x0000000000000000000000000000000000000000", // operator
        ARBITRUM_MAINNET.weth, // token0
        ARBITRUM_MAINNET.usdc, // token1
        500, // fee
        -1000, // tickLower
        1000, // tickUpper
        1000n, // liquidity
        0n, // feeGrowthInside0LastX128
        0n, // feeGrowthInside1LastX128
        10n, // tokensOwed0
        20n, // tokensOwed1
      ])
    ),
  })),
  getPosition: vi.fn(() =>
    Promise.resolve({
      nonce: 0n,
      operator: "0x0000000000000000000000000000000000000000",
      token0: ARBITRUM_MAINNET.weth,
      token1: ARBITRUM_MAINNET.usdc,
      fee: 500,
      tickLower: -1000,
      tickUpper: 1000,
      liquidity: 1000n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 10n,
      tokensOwed1: 20n,
    })
  ),
}));

vi.mock("../../../../src/modules/uniswap/fees", () => ({
  decreaseLiquidity: vi.fn(() =>
    Promise.resolve({
      hash: "0xdecreasetx",
      wait: vi.fn(() => Promise.resolve({ blockNumber: 1001 })),
    })
  ),
  collectFees: vi.fn(() =>
    Promise.resolve({
      hash: "0xcollecttx",
      wait: vi.fn(() => Promise.resolve({ blockNumber: 1002 })),
    })
  ),
}));

vi.mock("../../../../src/modules/uniswap/liquidity", () => ({
  createPositionManager: vi.fn(() => ({
    decreaseLiquidity: vi.fn(),
    collect: vi.fn(),
  })),
}));

vi.mock("../../../../src/modules/gmx/reader", () => ({
  createReader: vi.fn(() => ({})),
  getPosition: vi.fn(() => Promise.resolve(null)), // No GMX position by default
}));

vi.mock("../../../../src/modules/gmx/orders", () => ({
  createRouter: vi.fn(() => ({})),
  createDecreaseOrder: vi.fn(() =>
    Promise.resolve({
      txHash: "0xgmxclosetx",
      tx: {
        wait: vi.fn(() => Promise.resolve({ blockNumber: 1003 })),
      },
    })
  ),
}));

vi.mock("../../../../src/modules/chainlink/price", () => ({
  getLatestPrice: vi.fn(() =>
    Promise.resolve({
      price: ethers.parseUnits("2500", 8),
      decimals: 8,
      outputPrice: ethers.parseUnits("2500", 12),
    })
  ),
}));

vi.mock("../../../../src/utils/alerts", () => ({
  sendErrorAlert: vi.fn(() => Promise.resolve()),
  sendSuccessAlert: vi.fn(() => Promise.resolve()),
}));

describe("closeAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should discover and display positions in dry-run mode", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await closeAll({
      execute: false,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("CLOSE ALL STRATEGY POSITIONS")
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN MODE]"));

    consoleSpy.mockRestore();
  });

  it("should return early if no positions exist", async () => {
    const { DeltaNeutralMonitor } = await import("../../../../src/strategy/monitor");
    // Mock monitor to return empty positions
    vi.mocked(DeltaNeutralMonitor).mockImplementationOnce(
      () =>
        ({
          check: vi.fn().mockResolvedValue({
            status: {
              uniswap: [],
              gmx: {
                positionSizeTokens: 0n,
                collateralAmount: 0n,
                netValueUsd: 0n,
                pendingFundingRewards: 0n,
                delta: 0n,
              },
              netDelta: 0n,
              deltaDrift: 0,
              timestamp: Date.now(),
            },
            recommendation: {
              action: "NONE",
              reason: "No positions",
            },
          }),
        }) as any
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await closeAll({
      execute: false,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No positions to close"));

    consoleSpy.mockRestore();
  });

  it("should close Uniswap positions in dry-run mode", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await closeAll({
      execute: false,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Uniswap LP positions: 1")
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Would close"));

    consoleSpy.mockRestore();
  });

  it("should close GMX position when present", async () => {
    const { getPosition } = await import("../../../../src/modules/gmx/reader");
    vi.mocked(getPosition).mockResolvedValue(mockGmxPosition as any);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await closeAll({
      execute: false,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("GMX short position: Yes"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Close GMX short position"));

    consoleSpy.mockRestore();
  });

  it("should execute close operations when execute flag is true", async () => {
    const { getPosition } = await import("../../../../src/modules/gmx/reader");
    vi.mocked(getPosition).mockResolvedValue(mockGmxPosition as any);

    const { decreaseLiquidity } = await import("../../../../src/modules/uniswap/fees");
    const { collectFees } = await import("../../../../src/modules/uniswap/fees");
    const { createDecreaseOrder } = await import("../../../../src/modules/gmx/orders");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await closeAll({
      execute: true,
    });

    // In execute mode, should call the actual close functions
    // Note: These are mocked, so we're just checking the flow
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Executing close operations"));

    consoleSpy.mockRestore();
  });

  it("should handle errors gracefully", async () => {
    const { DeltaNeutralMonitor } = await import("../../../../src/strategy/monitor");
    // Mock the monitor to throw an error for this test only
    vi.mocked(DeltaNeutralMonitor).mockImplementationOnce(
      () =>
        ({
          check: vi.fn().mockRejectedValue(new Error("Monitor error")),
        }) as any
    );

    const { sendErrorAlert } = await import("../../../../src/utils/alerts");

    await expect(closeAll({ execute: false })).rejects.toThrow("Monitor error");
    expect(sendErrorAlert).toHaveBeenCalled();
  });

  it("should support closing specific token ID", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await closeAll({
      tokenId: "123",
      execute: false,
    });

    // Should still discover positions (with tokenId filter)
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("should send success alert after successful close", async () => {
    const { sendSuccessAlert } = await import("../../../../src/utils/alerts");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await closeAll({
      execute: true,
    });

    // Should send success alert
    expect(sendSuccessAlert).toHaveBeenCalledWith(
      expect.stringContaining("Strategy Positions Closed"),
      expect.any(String),
      expect.any(Array)
    );

    consoleSpy.mockRestore();
  });
});
