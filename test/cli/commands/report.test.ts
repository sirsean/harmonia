import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerReportCommand } from "../../../src/cli/commands/report";
import * as fs from "fs";

// Mock hardhat and modules
vi.mock("hardhat", () => ({
  ethers: {
    provider: {},
    getSigners: vi.fn(() => [
      {
        getAddress: vi.fn(() => Promise.resolve("0x1234567890123456789012345678901234567890")),
      },
    ]),
    Contract: vi.fn(),
    parseUnits: vi.fn((val, decimals) => BigInt(val)),
    formatEther: vi.fn((val) => val.toString()),
    formatUnits: vi.fn((val, decimals) => val.toString()),
  },
}));

vi.mock("../../../src/strategy/monitor", () => ({
  DeltaNeutralMonitor: vi.fn(() => ({
    check: vi.fn(() =>
      Promise.resolve({
        status: {
          uniswap: [
            {
              tokenId: "1",
              liquidity: 1000n,
              tickLower: -100,
              tickUpper: 100,
              currentTick: 0,
              sqrtPriceX96: 1000n,
              currentPrice: 2000.0,
              priceLower: 1900.0,
              priceUpper: 2100.0,
              priceLabel: "USDC/ETH",
              unclaimedFees: {
                amount0: 100n,
                amount1: 200n,
              },
              delta: {
                delta: 1n,
                zone: "in",
              },
            },
          ],
          totalLpDelta: 1n,
          gmx: {
            positionSizeTokens: 1n,
            delta: -1n,
            collateralAmount: 1000n,
            netValueUsd: 1000n,
            pendingFundingRewards: 0n,
          },
          netDelta: 0n,
          deltaDrift: 0,
          timestamp: Date.now(),
        },
        recommendation: {
          action: "NONE",
          reason: "No action needed",
          data: null,
        },
      })
    ),
  })),
}));

vi.mock("../../../src/config/strategy", () => ({
  loadStrategyConfig: vi.fn(() => ({
    optimizationDeltaThreshold: 0.05,
    emergencyDeltaThreshold: 0.2,
    minOptimizationInterval: 3600,
    maxOptimizationInterval: 86400,
    estimatedOptimizationGasCostUsd: 10n,
    minOptimizationFeeThresholdUsd: 10n,
    minOptimizationBenefitRatio: 1.5,
    rangeAdjustmentThreshold: 0.02,
    rangeCenterDriftThreshold: 0.05,
  })),
}));

vi.mock("../../../src/modules/uniswap/reader", () => ({
  createPool: vi.fn(() => ({
    token0: vi.fn(() => Promise.resolve("0xToken0")),
    token1: vi.fn(() => Promise.resolve("0xToken1")),
  })),
  createPositionManager: vi.fn(),
  getActivePositionsForOwner: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../../src/utils/reports", () => ({
  generateDailyReport: vi.fn((account, status, recommendation, totalLpValueUsd, totalFeesUsd, aprMetrics, walletBalances, collectedFees24h) => ({
    date: new Date().toISOString().split("T")[0],
    timestamp: Date.now(),
    account,
    summary: {
      totalLpValueUsd: "1000.0",
      totalGmxValueUsd: "1000.0",
      totalNetValueUsd: "2000.0",
      netDelta: "0.0",
      deltaDrift: 0,
      recommendation: "NONE",
      walletBalance0: walletBalances?.balance0,
      walletBalance1: walletBalances?.balance1,
    },
    positions: {
      uniswap: [],
      gmx: {
        positionSizeTokens: "1.0",
        collateralAmount: "1000.0",
        netValueUsd: "1000.0",
        delta: "-1.0",
      },
    },
    metrics: {
      totalLpDelta: "1.0",
      totalFeesUsd: "10.0",
      collectedFees24h: collectedFees24h ? collectedFees24h.toString() : undefined,
      deltaDriftPercent: 0,
      apr1d: aprMetrics?.apr1d,
      apr7d: aprMetrics?.apr7d,
      apr30d: aprMetrics?.apr30d,
    },
  })),
  saveDailyReport: vi.fn((report) => `reports/${report.date}.json`),
  formatReportSummary: vi.fn((report) => `Report for ${report.date}`),
}));

vi.mock("../../../src/utils/logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    close: vi.fn(),
  })),
}));

describe("Report Command", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    vi.clearAllMocks();
  });

  it("should register report command", () => {
    registerReportCommand(program);
    const reportCommand = program.commands.find((cmd) => cmd.name() === "report");
    expect(reportCommand).toBeDefined();
    expect(reportCommand?.description()).toBe("Generate daily position performance and health report");
  });

  it("should have correct options", () => {
    registerReportCommand(program);
    const reportCommand = program.commands.find((cmd) => cmd.name() === "report");
    expect(reportCommand).toBeDefined();
    
    const options = reportCommand?.options || [];
    const hasDateOption = options.some((opt: any) => opt.long === "--date");
    const hasReportsDirOption = options.some((opt: any) => opt.long === "--reports-dir");
    
    expect(hasDateOption).toBe(true);
    expect(hasReportsDirOption).toBe(true);
  });
});

describe("Report Implementation", () => {
  it("should generate Discord summary correctly", async () => {
    const { generateDiscordSummary } = await import("../../../src/cli/commands/report-impl");
    
    const report = {
      date: "2026-01-26",
      timestamp: Date.now(),
      account: "0x1234567890123456789012345678901234567890",
      summary: {
        totalLpValueUsd: "1000.50",
        totalGmxValueUsd: "500.25",
        totalNetValueUsd: "1500.75",
        netDelta: "0.1",
        deltaDrift: 0.03,
        recommendation: "NONE",
        walletBalance0: "1.5 WETH",
        walletBalance1: "2000.0 USDC",
      },
      positions: {
        uniswap: [
          {
            tokenId: "1",
            priceRange: "[1900, 2100]",
            currentPrice: 2000,
            zone: "in",
            delta: "1.0",
            valueUsd: "1000.0",
            unclaimedFees: {
              amount0: "0.1",
              amount1: "100.0",
            },
          },
        ],
        gmx: {
          positionSizeTokens: "1.0",
          collateralAmount: "500.0",
          netValueUsd: "500.25",
          delta: "-1.0",
        },
      },
      metrics: {
        totalLpDelta: "1.0",
        totalFeesUsd: "10.50",
        deltaDriftPercent: 3.0,
        apr1d: 12.5,
        apr7d: 15.2,
        apr30d: 14.8,
      },
    };

    const summary = generateDiscordSummary(report);
    
    expect(summary.title).toBe("📊 Harmonia : 2026-01-26");
    expect(summary.message).toBe("");
    
    // Check fields
    // 1. Total Net Value
    // 2. Delta Drift
    // 3. Unclaimed Fees
    // 4. APR
    // 5. Wallet Balances
    expect(summary.fields).toHaveLength(5);
    
    expect(summary.fields[0].name).toBe("Total Net Value");
    expect(summary.fields[0].value).toBe("$1500.7500");
    
    expect(summary.fields[1].name).toBe("Delta Drift");
    expect(summary.fields[1].value).toBe("3.00%");
    
    expect(summary.fields[2].name).toBe("Unclaimed Fees");
    expect(summary.fields[2].value).toBe("$10.5000");

    expect(summary.fields[3].name).toBe("APR");
    expect(summary.fields[3].value).toContain("1d: 12.50%");
    expect(summary.fields[3].value).toContain("7d: 15.20%");
    expect(summary.fields[3].value).toContain("30d: 14.80%");

    expect(summary.fields[4].name).toBe("Wallet Balances");
    expect(summary.fields[4].value).toContain("1.5 WETH");
    expect(summary.fields[4].value).toContain("2000.0 USDC");
  });

  it("should include collected fees in Discord summary when present", async () => {
    const { generateDiscordSummary } = await import("../../../src/cli/commands/report-impl");
    
    const report = {
      date: "2026-01-26",
      timestamp: Date.now(),
      account: "0x1234567890123456789012345678901234567890",
      summary: {
        totalLpValueUsd: "1000.0",
        totalGmxValueUsd: "500.0",
        totalNetValueUsd: "1500.0",
        netDelta: "0.0",
        deltaDrift: 0,
        recommendation: "NONE",
      },
      positions: {
        uniswap: [],
        gmx: {
          positionSizeTokens: "1.0",
          collateralAmount: "500.0",
          netValueUsd: "500.0",
          delta: "-1.0",
        },
      },
      metrics: {
        totalLpDelta: "0.0",
        totalFeesUsd: "10.0",
        collectedFees24h: "5.50",
        deltaDriftPercent: 0,
      },
    };

    const summary = generateDiscordSummary(report as any);
    
    const collectedFeesField = summary.fields.find(f => f.name === "Collected Fees (24h)");
    expect(collectedFeesField).toBeDefined();
    expect(collectedFeesField?.value).toBe("$5.5000");
  });
});
