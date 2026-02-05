import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "hardhat";

vi.mock("hardhat", () => ({
  ethers: {
    getSigners: vi.fn(() => [
      {
        getAddress: vi.fn(() => Promise.resolve("0xAccount")),
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
      return BigInt(val) * 10n ** BigInt(decimals);
    }),
    formatUnits: vi.fn((val: bigint, decimals: number) => {
      return (Number(val) / Number(10n ** BigInt(decimals))).toString();
    }),
    parseEther: vi.fn((val: string) => {
      const num = parseFloat(val);
      return BigInt(Math.floor(num * 1e18));
    }),
    Contract: vi.fn(() => ({})),
  },
}));

vi.mock("../../../../src/cli/commands/base", () => ({
  getSignerAndAccount: vi.fn(async (account?: string) => ({
    signer: {
      getAddress: vi.fn(() => Promise.resolve("0xAccount")),
      provider: {
        getBlockNumber: vi.fn(() => Promise.resolve(1000)),
        getTransactionCount: vi.fn(() => Promise.resolve(0)),
      },
    },
    account: account || "0xAccount",
  })),
}));

vi.mock("../../../../src/modules/chainlink/price", () => ({
  getLatestPrice: vi.fn(),
}));

vi.mock("../../../../src/modules/gmx/reader", () => ({
  createReader: vi.fn(() => ({})),
  getPosition: vi.fn(),
}));

vi.mock("../../../../src/modules/gmx/orders", () => ({
  createRouter: vi.fn(() => ({})),
  createIncreaseOrder: vi.fn(() =>
    Promise.resolve({ orderParams: [], multicallData: [], txHash: "0xIncreaseHash" })
  ),
  createDecreaseOrder: vi.fn(() =>
    Promise.resolve({ orderParams: [], multicallData: [], txHash: "0xDecreaseHash" })
  ),
}));

vi.mock("../../../../src/config/strategy", () => ({
  loadStrategyConfig: vi.fn(() => ({
    maxSlippage: 0.01,
    slippageBuffer: 0.005,
    defaultExecutionFee: 1000000000000000n,
  })),
}));

vi.mock("../../../../src/utils/database", () => ({
  MonitoringDatabase: vi.fn(() => ({
    recordHedgeAdjustment: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("../../../../src/utils/alerts", () => ({
  sendSuccessAlert: vi.fn(() => Promise.resolve()),
}));

import { executeHedgeAdjust } from "../../../../src/cli/commands/strategy/execute-hedge-adjust";
import { getLatestPrice } from "../../../../src/modules/chainlink/price";
import { getSignerAndAccount } from "../../../../src/cli/commands/base";
import { loadStrategyConfig } from "../../../../src/config/strategy";
import * as gmxReader from "../../../../src/modules/gmx/reader";
import * as gmxOrders from "../../../../src/modules/gmx/orders";
import type { HedgeAdjustmentData } from "../../../../src/strategy/types";

const MOCK_POSITION = {
  addresses: {},
  numbers: {
    sizeInUsd: 3000n * 10n ** 30n,
    sizeInTokens: 1n * 10n ** 18n,
    collateralAmount: 1000n * 10n ** 6n,
  },
  flags: {},
};

function makeHedgeData(adjustmentSizeUsd: bigint): HedgeAdjustmentData {
  return {
    currentShortSizeTokens: 1n * 10n ** 18n,
    targetShortSizeTokens: 2n * 10n ** 18n,
    adjustmentSizeUsd,
    currentLeverage: 3.0,
    estimatedLeverageAfter: 4.0,
  };
}

describe("executeHedgeAdjust", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-apply mocks for modules that need per-test defaults
    vi.mocked(gmxOrders.createRouter).mockReturnValue({} as any);
    vi.mocked(gmxOrders.createIncreaseOrder).mockResolvedValue({
      orderParams: [] as any,
      multicallData: [],
      txHash: "0xIncreaseHash",
    });
    vi.mocked(gmxOrders.createDecreaseOrder).mockResolvedValue({
      orderParams: [] as any,
      multicallData: [],
      txHash: "0xDecreaseHash",
    });

    vi.mocked(gmxReader.createReader).mockReturnValue({} as any);
    vi.mocked(gmxReader.getPosition).mockResolvedValue(MOCK_POSITION as any);

    vi.mocked(getLatestPrice).mockResolvedValue({
      roundId: 1n,
      answeredInRound: 1n,
      startedAt: 1000,
      updatedAt: 1000,
      price: 300000000000n, // 3000 * 1e8 (Chainlink 8 decimals)
      decimals: 8,
      priceWad: 3000n * 10n ** 18n,
      outputDecimals: 12,
      outputPrice: 3000n * 10n ** 12n, // 3000 in 12 decimals
    });
  });

  it("dry run returns without submitting transactions", async () => {
    const result = await executeHedgeAdjust({
      hedgeData: makeHedgeData(100n * 10n ** 30n),
      deltaDriftBefore: 0.06,
      execute: false,
      suppressAlert: true,
    });

    expect(result.txHash).toBe("");
    expect(result.direction).toBe("increase");
    expect(getLatestPrice).not.toHaveBeenCalled();
    expect(gmxOrders.createIncreaseOrder).not.toHaveBeenCalled();
  });

  it("increase short uses Chainlink price with maxSlippage for acceptable price", async () => {
    const result = await executeHedgeAdjust({
      hedgeData: makeHedgeData(100n * 10n ** 30n), // positive = increase
      deltaDriftBefore: 0.06,
      execute: true,
      suppressAlert: true,
    });

    expect(result.txHash).toBe("0xIncreaseHash");
    expect(result.direction).toBe("increase");

    // Verify Chainlink was called (not position entry price)
    expect(getLatestPrice).toHaveBeenCalledOnce();

    // Acceptable price: 3000 * (1 - 0.01) = 2970 in 12 decimals
    const callArgs = vi.mocked(gmxOrders.createIncreaseOrder).mock.calls[0][2];
    expect(callArgs.acceptablePrice).toBe(2970n * 10n ** 12n);
    expect(callArgs.collateralAmount).toBe(0n);
    expect(callArgs.isLong).toBe(false);
  });

  it("decrease short uses Chainlink price with maxSlippage for acceptable price", async () => {
    const result = await executeHedgeAdjust({
      hedgeData: makeHedgeData(-50n * 10n ** 30n), // negative = decrease
      deltaDriftBefore: 0.06,
      execute: true,
      suppressAlert: true,
    });

    expect(result.txHash).toBe("0xDecreaseHash");
    expect(result.direction).toBe("decrease");

    expect(getLatestPrice).toHaveBeenCalledOnce();

    // Acceptable price: 3000 * (1 + 0.01) = 3030 in 12 decimals
    const callArgs = vi.mocked(gmxOrders.createDecreaseOrder).mock.calls[0][1];
    expect(callArgs.acceptablePrice).toBe(3030n * 10n ** 12n);
    expect(callArgs.isLong).toBe(false);
  });

  it("uses current market price, not position entry price", async () => {
    // Position entry price is $3000, but current market price is $2500
    vi.mocked(getLatestPrice).mockResolvedValue({
      roundId: 1n,
      answeredInRound: 1n,
      startedAt: 1000,
      updatedAt: 1000,
      price: 250000000000n,
      decimals: 8,
      priceWad: 2500n * 10n ** 18n,
      outputDecimals: 12,
      outputPrice: 2500n * 10n ** 12n, // $2500 current price
    });

    await executeHedgeAdjust({
      hedgeData: makeHedgeData(100n * 10n ** 30n),
      deltaDriftBefore: 0.06,
      execute: true,
      suppressAlert: true,
    });

    // Acceptable price should be based on $2500 (current), NOT $3000 (entry)
    // 2500 * (1 - 0.01) = 2475
    const callArgs = vi.mocked(gmxOrders.createIncreaseOrder).mock.calls[0][2];
    expect(callArgs.acceptablePrice).toBe(2475n * 10n ** 12n);
  });

  it("throws if Chainlink price is unavailable", async () => {
    vi.mocked(getLatestPrice).mockResolvedValue({
      roundId: 1n,
      answeredInRound: 1n,
      startedAt: 1000,
      updatedAt: 1000,
      price: 0n,
      decimals: 8,
      priceWad: 0n,
    });

    await expect(
      executeHedgeAdjust({
        hedgeData: makeHedgeData(100n * 10n ** 30n),
        deltaDriftBefore: 0.06,
        execute: true,
        suppressAlert: true,
      })
    ).rejects.toThrow("Failed to fetch current ETH price");
  });

  it("throws if no GMX position exists", async () => {
    vi.mocked(gmxReader.getPosition).mockResolvedValue({
      addresses: {},
      numbers: { sizeInUsd: 0n, sizeInTokens: 0n, collateralAmount: 0n },
      flags: {},
    } as any);

    await expect(
      executeHedgeAdjust({
        hedgeData: makeHedgeData(100n * 10n ** 30n),
        deltaDriftBefore: 0.06,
        execute: true,
        suppressAlert: true,
      })
    ).rejects.toThrow("No existing GMX short position found");
  });
});
