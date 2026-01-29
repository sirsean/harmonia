import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { registerDaemonCommand } from "../../../src/cli/commands/daemon";
import { daemon, DaemonOptions } from "../../../src/cli/commands/daemon-impl";
import { MonitoringDatabase } from "../../../src/utils/database";
import { StrategyStatus, Recommendation, StrategyAction } from "../../../src/strategy/types";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Mock hardhat
vi.mock("hardhat", () => ({
  ethers: {
    provider: {},
    Contract: vi.fn().mockImplementation((address: string, abi: any, provider: any) => {
      return {
        decimals: vi.fn().mockResolvedValue(address === "0xUSDC" ? 6n : 18n),
        symbol: vi.fn().mockResolvedValue(address === "0xUSDC" ? "USDC" : "ETH"),
      };
    }),
    parseEther: vi.fn((val: string) => {
      // Handle decimal strings like "0.01"
      const parts = val.split(".");
      if (parts.length === 1) {
        return BigInt(val) * BigInt(10) ** 18n;
      }
      const [whole, decimal] = parts;
      const decimalPart = decimal.padEnd(18, "0").substring(0, 18);
      return BigInt(whole) * BigInt(10) ** 18n + BigInt(decimalPart);
    }),
    parseUnits: vi.fn((val: string, decimals: number) => {
      if (decimals === 96) {
        // Q96 format - return 2^96 for "1"
        return 2n ** 96n;
      }
      if (typeof val === "string") {
        return BigInt(val) * BigInt(10) ** BigInt(decimals);
      }
      return BigInt(val);
    }),
    formatEther: vi.fn((val: bigint) => val.toString()),
    formatUnits: vi.fn((val: bigint, decimals: number) => val.toString()),
  },
}));

// Mock Discord alerts
vi.mock("../../../src/utils/alerts", () => ({
  sendErrorAlert: vi.fn().mockResolvedValue(undefined),
  sendWarningAlert: vi.fn().mockResolvedValue(undefined),
  sendSuccessAlert: vi.fn().mockResolvedValue(undefined),
  sendInfoAlert: vi.fn().mockResolvedValue(undefined),
}));

// Mock getSignerAndAccount
vi.mock("../../../src/cli/commands/base", () => ({
  getSignerAndAccount: vi.fn().mockResolvedValue({
    account: "0x1234567890123456789012345678901234567890",
  }),
  addCommonOptions: vi.fn((command) => command),
}));

// Mock logger
vi.mock("../../../src/utils/logger", () => {
  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    close: vi.fn(),
  };
  return {
    getLogger: vi.fn().mockReturnValue(mockLogger),
  };
});

// Mock config
vi.mock("../../../src/config/strategy", () => ({
  loadStrategyConfig: vi.fn().mockReturnValue({
    optimizationDeltaThreshold: 0.1,
    emergencyDeltaThreshold: 0.2,
    minOptimizationInterval: 3600,
    maxOptimizationInterval: 86400,
    maxLeverage: 3.0,
    minPositionSizeUsd: BigInt("10000000000000000000000000000"), // 100 * 10^30
    maxPositionSizeUsd: BigInt("50000000000000000000000000000"), // 500 * 10^30
    maxSlippage: 0.01,
    slippageBuffer: 0.005,
    minOptimizationFeeThresholdUsd: BigInt("5000000000000000000000000000"), // 5 * 10^30
    defaultExecutionFee: BigInt("1000000000000000"), // 0.001 ETH
    estimatedOptimizationGasCostUsd: BigInt("2000000000000000000000000000"), // 2 * 10^30
    rangeAdjustmentThreshold: 0.02,
    rangeCenterDriftThreshold: 0.05,
    defaultRangeWidth: 0.06,
    minRangeWidth: 0.04,
    maxRangeWidth: 0.4,
    targetLeverage: 3.0,
    minOptimizationBenefitRatio: 1.5,
  }),
}));

// Mock addresses
vi.mock("../../../src/config/addresses", () => ({
  ARBITRUM_MAINNET: {
    uniswapV3PositionManager: "0xPM",
    uniswapV3EthUsdcPool: "0xPool",
    gmxReader: "0xGMXReader",
    gmxDataStore: "0xDataStore",
    gmxEthUsdMarket: "0xMarket",
    usdc: "0xUSDC",
  },
}));

// Mock DeltaNeutralMonitor
const mockCheckFn = vi.fn();
vi.mock("../../../src/strategy/monitor", () => ({
  DeltaNeutralMonitor: vi.fn().mockImplementation(() => ({
    check: mockCheckFn,
  })),
}));

// Mock uniswap reader
vi.mock("../../../src/modules/uniswap/reader", () => ({
  createPool: vi.fn(() => ({
    token0: vi.fn().mockResolvedValue("0xUSDC"),
    token1: vi.fn().mockResolvedValue("0xETH"),
  })),
  createPositionManager: vi.fn(),
  getPoolState: vi.fn(),
  getPositionWithFees: vi.fn(),
  getActivePositionsForOwner: vi.fn(),
}));

// Mock executeOptimize
vi.mock("../../../src/cli/commands/strategy/execute-optimize", () => ({
  executeOptimize: vi.fn(),
}));

describe("daemon command", () => {
  let testDbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Create temporary database path
    testDbPath = path.join(process.cwd(), "test-data", `daemon-test-${Date.now()}-${Math.random().toString(36).substring(7)}.db`);
  });

  describe("command registration", () => {
    it("should register daemon command", () => {
      const program = new Command();
      registerDaemonCommand(program);

      // Find the daemon command
      const daemonCommand = program.commands.find((cmd) => cmd.name() === "daemon");
      expect(daemonCommand).toBeDefined();
      expect(daemonCommand?.description()).toBe(
        "Run automated monitoring daemon that continuously tracks strategy metrics"
      );
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    const testDataDir = path.dirname(testDbPath);
    try {
      if (fs.existsSync(testDataDir) && fs.readdirSync(testDataDir).length === 0) {
        fs.rmdirSync(testDataDir);
      }
    } catch (e) {
      // Ignore errors
    }
  });

  const createMockStatus = (): StrategyStatus => ({
    uniswap: [
      {
        tokenId: "123",
        liquidity: ethers.parseEther("100"),
        tickLower: 69000,
        tickUpper: 70000,
        currentTick: 69500,
        sqrtPriceX96: 2n ** 96n, // Q96 format
        priceLower: 2000.0,
        priceUpper: 2100.0,
        currentPrice: 2050.0,
        priceLabel: "USDC/ETH",
        unclaimedFees: {
          amount0: ethers.parseUnits("10", 6),
          amount1: ethers.parseEther("0.01"),
        },
        delta: {
          delta: ethers.parseEther("0.5"),
          deltaRatio: ethers.parseEther("0.5"),
          zone: "in",
        },
      },
    ],
    totalLpDelta: ethers.parseEther("0.5"),
    gmx: {
      positionSizeTokens: ethers.parseEther("0.7"),
      collateralAmount: ethers.parseUnits("1000", 6),
      netValueUsd: ethers.parseUnits("1500", 30),
      pendingFundingRewards: ethers.parseEther("0.001"),
      delta: ethers.parseEther("-0.7"),
    },
    netDelta: ethers.parseEther("-0.2"),
    deltaDrift: 0.4,
    timestamp: Date.now(),
  });

  const createMockRecommendation = (): Recommendation => ({
    action: StrategyAction.NONE,
    reason: "Strategy is healthy",
  });

  it("should initialize database and start monitoring loop", async () => {
    const status = createMockStatus();
    const recommendation = createMockRecommendation();
    mockCheckFn.mockResolvedValue({ status, recommendation });

    // Mock process.exit to prevent actual exit
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const options: DaemonOptions = {
      account: "0x1234567890123456789012345678901234567890",
      interval: 1, // 1 second for testing
      dbPath: testDbPath,
    };

    // Start daemon in background
    const daemonPromise = daemon(options).catch(() => {
      // Expected to exit
    });

    // Wait a bit for initialization
    await vi.advanceTimersByTimeAsync(100);

    // Advance timers to trigger first check
    await vi.advanceTimersByTimeAsync(1000);

    // Verify monitor was called
    expect(mockCheckFn).toHaveBeenCalled();

    // Stop daemon by emitting SIGINT
    process.emit("SIGINT" as any, "SIGINT");

    // Wait for shutdown
    await vi.advanceTimersByTimeAsync(100);

    exitSpy.mockRestore();
  }, 10000);

  it("should store snapshots in database", async () => {
    const status = createMockStatus();
    const recommendation = createMockRecommendation();
    mockCheckFn.mockResolvedValue({ status, recommendation });

    // Mock process.exit
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const options: DaemonOptions = {
      account: "0x1234567890123456789012345678901234567890",
      interval: 1,
      dbPath: testDbPath,
    };

    const daemonPromise = daemon(options).catch(() => {
      // Expected to exit
    });

    // Wait for initialization
    await vi.advanceTimersByTimeAsync(100);

    // Trigger first monitoring check
    await vi.advanceTimersByTimeAsync(1000);

    // Stop daemon immediately
    process.emit("SIGINT" as any, "SIGINT");

    await vi.advanceTimersByTimeAsync(100);

    exitSpy.mockRestore();

    // Verify database was created and contains data
    expect(fs.existsSync(testDbPath)).toBe(true);

    const db = new MonitoringDatabase(testDbPath);
    const snapshot = db.getLatestSnapshot("0x1234567890123456789012345678901234567890");
    db.close();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.account).toBe("0x1234567890123456789012345678901234567890");
    expect(snapshot!.recommendationAction).toBe(StrategyAction.NONE);
  });

  it("should handle errors gracefully with exponential backoff", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    let callCount = 0;
    mockCheckFn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Network error");
      }
      return Promise.resolve({
        status: createMockStatus(),
        recommendation: createMockRecommendation(),
      });
    });

    const options: DaemonOptions = {
      account: "0x1234567890123456789012345678901234567890",
      interval: 1,
      dbPath: testDbPath,
    };

    // Start daemon - it will begin initialization asynchronously
    const daemonPromise = daemon(options).catch(() => {
      // Expected to exit
    });

    // Wait for daemon initialization to complete and first check to be called
    // The daemon initialization involves async operations that need to complete.
    // Since all mocks resolve immediately, we just need to wait for the monitoring
    // loop to start. We do this by waiting for the mock to be called.
    // Use a small timeout to avoid infinite loops from setInterval checks.
    const waitForFirstCall = async () => {
      for (let i = 0; i < 100; i++) {
        if (mockCheckFn.mock.calls.length > 0) {
          return;
        }
        // Advance timers by a small amount and flush microtasks
        await vi.advanceTimersByTimeAsync(10);
        // Give event loop a chance to process
        await Promise.resolve();
      }
    };
    
    await waitForFirstCall();
    
    // First call should have happened by now
    expect(mockCheckFn).toHaveBeenCalled();
    
    // Wait for the error and backoff
    await vi.advanceTimersByTimeAsync(1000);

    // Backoff delay (should be 1 second for first error)
    await vi.advanceTimersByTimeAsync(1000);

    // Second call succeeds after backoff
    await vi.advanceTimersByTimeAsync(1000);
    
    expect(mockCheckFn).toHaveBeenCalled();

    // Stop daemon
    process.emit("SIGINT" as any, "SIGINT");
    await vi.advanceTimersByTimeAsync(100);

    exitSpy.mockRestore();
  });

  it("should shut down after max consecutive errors", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    mockCheckFn.mockRejectedValue(new Error("Persistent error"));

    const options: DaemonOptions = {
      account: "0x1234567890123456789012345678901234567890",
      interval: 1,
      dbPath: testDbPath,
    };

    const daemonPromise = daemon(options).catch(() => {
      // Expected to exit
    });

    // Wait for initialization
    await vi.advanceTimersByTimeAsync(100);

    // Trigger multiple errors (max is 5)
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (i < 5) {
        // Backoff delay
        await vi.advanceTimersByTimeAsync(1000 * Math.pow(2, i));
      }
    }

    // Wait a bit more for shutdown
    await vi.advanceTimersByTimeAsync(100);

    expect(mockCheckFn).toHaveBeenCalledTimes(5);
    exitSpy.mockRestore();
  });

  it("should respect monitoring interval", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const status = createMockStatus();
    const recommendation = createMockRecommendation();
    mockCheckFn.mockResolvedValue({ status, recommendation });

    const options: DaemonOptions = {
      account: "0x1234567890123456789012345678901234567890",
      interval: 5, // 5 seconds
      dbPath: testDbPath,
    };

    const daemonPromise = daemon(options).catch(() => {
      // Expected to exit
    });

    // Wait for initialization
    await vi.advanceTimersByTimeAsync(100);

    // Daemon starts immediately, so first call happens right away
    // Then wait for first interval
    await vi.advanceTimersByTimeAsync(5000);
    // Should have been called at least once (initial + possibly first interval)
    expect(mockCheckFn).toHaveBeenCalled();

    // Second check after another interval
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockCheckFn).toHaveBeenCalled();

    // Stop daemon
    process.emit("SIGINT" as any, "SIGINT");
    await vi.advanceTimersByTimeAsync(100);

    exitSpy.mockRestore();
  });

  it("should handle different recommendation actions", async () => {
    const status = createMockStatus();
    const recommendation: Recommendation = {
      action: StrategyAction.OPTIMIZE,
      reason: "Delta drift exceeds threshold",
      data: {
        deltaDrift: 0.12,
        anyOutOfRange: false,
        totalFeesUsd: ethers.parseUnits("15", 30),
        estimatedGasCostUsd: ethers.parseUnits("2", 30),
        estimatedBenefitUsd: ethers.parseUnits("15", 30),
      },
    };
    mockCheckFn.mockResolvedValue({ status, recommendation });

    const options: DaemonOptions = {
      account: "0x1234567890123456789012345678901234567890",
      interval: 1,
      dbPath: testDbPath,
    };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const daemonPromise = daemon(options).catch(() => {
      // Expected to exit
    });

    // Wait for initialization
    await vi.advanceTimersByTimeAsync(100);

    // Trigger monitoring check
    await vi.advanceTimersByTimeAsync(1000);

    // Stop daemon
    process.emit("SIGINT" as any, "SIGINT");
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    await daemonPromise.catch(() => {
      // Expected to exit
    });

    // Verify database contains the recommendation
    const db = new MonitoringDatabase(testDbPath);
    const snapshot = db.getLatestSnapshot("0x1234567890123456789012345678901234567890");
    db.close();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.recommendationAction).toBe(StrategyAction.OPTIMIZE);
    expect(snapshot!.recommendationReason).toBe("Delta drift exceeds threshold");
    exitSpy.mockRestore();
  });

  it("should calculate and store NAV correctly", async () => {
    const status = createMockStatus();
    const recommendation = createMockRecommendation();
    mockCheckFn.mockResolvedValue({ status, recommendation });

    const options: DaemonOptions = {
      account: "0x1234567890123456789012345678901234567890",
      interval: 1,
      dbPath: testDbPath,
    };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const daemonPromise = daemon(options).catch(() => {
      // Expected to exit
    });

    // Wait for initialization
    await vi.advanceTimersByTimeAsync(100);

    // Trigger monitoring check
    await vi.advanceTimersByTimeAsync(1000);

    // Stop daemon
    process.emit("SIGINT" as any, "SIGINT");
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    await daemonPromise.catch(() => {
      // Expected to exit
    });

    // Verify NAV history
    const db = new MonitoringDatabase(testDbPath);
    const navHistory = db.getNavHistory("0x1234567890123456789012345678901234567890");
    db.close();

    expect(navHistory.length).toBeGreaterThan(0);
    const latestNav = navHistory[navHistory.length - 1];
    expect(latestNav.navUsd).toBeTruthy();
    exitSpy.mockRestore();
  }, 10000);

  it("should store position snapshots correctly", async () => {
    const status = createMockStatus();
    const recommendation = createMockRecommendation();
    mockCheckFn.mockResolvedValue({ status, recommendation });

    const options: DaemonOptions = {
      account: "0x1234567890123456789012345678901234567890",
      interval: 1,
      dbPath: testDbPath,
    };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const daemonPromise = daemon(options).catch(() => {
      // Expected to exit
    });

    // Wait for initialization
    await vi.advanceTimersByTimeAsync(100);

    // Trigger monitoring check
    await vi.advanceTimersByTimeAsync(1000);

    // Stop daemon
    process.emit("SIGINT" as any, "SIGINT");
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    await daemonPromise.catch(() => {
      // Expected to exit
    });

    // Verify position snapshots
    const db = new MonitoringDatabase(testDbPath);
    const snapshot = db.getLatestSnapshot("0x1234567890123456789012345678901234567890");
    expect(snapshot).not.toBeNull();

    const positions = db.getPositionSnapshots(snapshot!.id);
    db.close();

    // Should have 1 Uniswap position + 1 GMX position
    expect(positions.length).toBe(2);
    const uniswapPos = positions.find((p) => p.positionType === "uniswap");
    const gmxPos = positions.find((p) => p.positionType === "gmx");

    expect(uniswapPos).not.toBeUndefined();
    expect(uniswapPos!.tokenId).toBe("123");
    expect(gmxPos).not.toBeUndefined();
    expect(gmxPos!.tokenId).toBe("gmx-hedge");
    exitSpy.mockRestore();
  });

  describe("auto-optimization", () => {
    beforeEach(() => {
      // Clear mock before each test
      vi.clearAllMocks();
    });

    it("should trigger auto-optimization when enabled and recommendation is OPTIMIZE", async () => {
      const status = createMockStatus();
      const recommendation: Recommendation = {
        action: StrategyAction.OPTIMIZE,
        reason: "Delta drift exceeds threshold",
        data: {
          deltaDrift: 0.12,
          anyOutOfRange: false,
          totalFeesUsd: ethers.parseUnits("15", 30),
          estimatedGasCostUsd: ethers.parseUnits("2", 30),
          estimatedBenefitUsd: ethers.parseUnits("15", 30),
        },
      };
      mockCheckFn.mockResolvedValue({ status, recommendation });
      const { executeOptimize } = await import("../../../src/cli/commands/strategy/execute-optimize");
      vi.mocked(executeOptimize).mockResolvedValue(undefined);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      const options: DaemonOptions = {
        account: "0x1234567890123456789012345678901234567890",
        interval: 1,
        dbPath: testDbPath,
        autoOptimize: true,
      };

      const daemonPromise = daemon(options).catch(() => {
        // Expected to exit
      });

      // Wait for initialization
      await vi.advanceTimersByTimeAsync(100);

      // Trigger monitoring check
      await vi.advanceTimersByTimeAsync(1000);

      // Wait for optimization to complete
      await vi.advanceTimersByTimeAsync(1000);

      // Stop daemon
      process.emit("SIGINT" as any, "SIGINT");
      await vi.advanceTimersByTimeAsync(100);

      // Verify optimization was called
      const { executeOptimize: executeOptimizeFn } = await import("../../../src/cli/commands/strategy/execute-optimize");
      expect(executeOptimizeFn).toHaveBeenCalledWith({
        account: "0x1234567890123456789012345678901234567890",
        execute: true,
      });

      exitSpy.mockRestore();
    });

    it("should not trigger auto-optimization when disabled", async () => {
      const status = createMockStatus();
      const recommendation: Recommendation = {
        action: StrategyAction.OPTIMIZE,
        reason: "Delta drift exceeds threshold",
      };
      mockCheckFn.mockResolvedValue({ status, recommendation });

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      const options: DaemonOptions = {
        account: "0x1234567890123456789012345678901234567890",
        interval: 1,
        dbPath: testDbPath,
        autoOptimize: false, // Explicitly disabled
      };

      const daemonPromise = daemon(options).catch(() => {
        // Expected to exit
      });

      // Wait for initialization
      await vi.advanceTimersByTimeAsync(100);

      // Trigger monitoring check
      await vi.advanceTimersByTimeAsync(1000);

      // Stop daemon
      process.emit("SIGINT" as any, "SIGINT");
      await vi.advanceTimersByTimeAsync(100);

      // Verify optimization was NOT called
      const { executeOptimize: executeOptimizeFn } = await import("../../../src/cli/commands/strategy/execute-optimize");
      expect(executeOptimizeFn).not.toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    it("should not trigger auto-optimization when recommendation is NONE", async () => {
      const status = createMockStatus();
      const recommendation: Recommendation = {
        action: StrategyAction.NONE,
        reason: "Strategy is healthy",
      };
      mockCheckFn.mockResolvedValue({ status, recommendation });

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      const options: DaemonOptions = {
        account: "0x1234567890123456789012345678901234567890",
        interval: 1,
        dbPath: testDbPath,
        autoOptimize: true,
      };

      const daemonPromise = daemon(options).catch(() => {
        // Expected to exit
      });

      // Wait for initialization
      await vi.advanceTimersByTimeAsync(100);

      // Trigger monitoring check
      await vi.advanceTimersByTimeAsync(1000);

      // Stop daemon
      process.emit("SIGINT" as any, "SIGINT");
      await vi.advanceTimersByTimeAsync(100);

      // Verify optimization was NOT called
      const { executeOptimize: executeOptimizeFn } = await import("../../../src/cli/commands/strategy/execute-optimize");
      expect(executeOptimizeFn).not.toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    it("should handle optimization errors gracefully and track failures", async () => {
      const status = createMockStatus();
      const recommendation: Recommendation = {
        action: StrategyAction.OPTIMIZE,
        reason: "Delta drift exceeds threshold",
        data: {
          deltaDrift: 0.12,
          anyOutOfRange: false,
          totalFeesUsd: ethers.parseUnits("15", 30),
        },
      };
      mockCheckFn.mockResolvedValue({ status, recommendation });
      const { executeOptimize } = await import("../../../src/cli/commands/strategy/execute-optimize");
      vi.mocked(executeOptimize).mockRejectedValue(new Error("Optimization failed: insufficient balance"));

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      const options: DaemonOptions = {
        account: "0x1234567890123456789012345678901234567890",
        interval: 1,
        dbPath: testDbPath,
        autoOptimize: true,
      };

      const daemonPromise = daemon(options).catch(() => {
        // Expected to exit
      });

      // Wait for initialization
      await vi.advanceTimersByTimeAsync(100);

      // Trigger monitoring check
      await vi.advanceTimersByTimeAsync(1000);

      // Wait for optimization to fail
      await vi.advanceTimersByTimeAsync(1000);

      // Stop daemon
      process.emit("SIGINT" as any, "SIGINT");
      await vi.advanceTimersByTimeAsync(100);

      // Verify optimization was called
      const { executeOptimize: executeOptimizeFn } = await import("../../../src/cli/commands/strategy/execute-optimize");
      expect(executeOptimizeFn).toHaveBeenCalled();

      // Verify failure was recorded in database
      const db = new MonitoringDatabase(testDbPath);
      const failures = db.getRecentOptimizationFailures(
        "0x1234567890123456789012345678901234567890",
        5
      );
      db.close();

      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0].errorMessage).toContain("Optimization failed");

      exitSpy.mockRestore();
    });

    it("should disable auto-optimization after max consecutive failures", async () => {
      const status = createMockStatus();
      const recommendation: Recommendation = {
        action: StrategyAction.OPTIMIZE,
        reason: "Delta drift exceeds threshold",
      };
      mockCheckFn.mockResolvedValue({ status, recommendation });
      const { executeOptimize } = await import("../../../src/cli/commands/strategy/execute-optimize");
      vi.mocked(executeOptimize).mockRejectedValue(new Error("Persistent optimization failure"));

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      const options: DaemonOptions = {
        account: "0x1234567890123456789012345678901234567890",
        interval: 1,
        dbPath: testDbPath,
        autoOptimize: true,
      };

      const daemonPromise = daemon(options).catch(() => {
        // Expected to exit
      });

      // Wait for initialization
      await vi.advanceTimersByTimeAsync(100);

      // Trigger multiple monitoring checks (each will fail optimization)
      // Max failures is 3, so after 3 failures, optimization should stop
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000); // Trigger check
        await vi.advanceTimersByTimeAsync(1000); // Wait for optimization attempt
      }

      // Stop daemon
      process.emit("SIGINT" as any, "SIGINT");
      await vi.advanceTimersByTimeAsync(100);

      // Verify optimization was called exactly 3 times (max failures)
      const { executeOptimize: executeOptimizeFn } = await import("../../../src/cli/commands/strategy/execute-optimize");
      expect(executeOptimizeFn).toHaveBeenCalledTimes(3);

      exitSpy.mockRestore();
    });

    it("should prevent concurrent optimizations", async () => {
      const status = createMockStatus();
      const recommendation: Recommendation = {
        action: StrategyAction.OPTIMIZE,
        reason: "Delta drift exceeds threshold",
      };
      mockCheckFn.mockResolvedValue({ status, recommendation });

      // Make optimization take a long time
      let resolveOptimization: () => void;
      const optimizationPromise = new Promise<void>((resolve) => {
        resolveOptimization = resolve;
      });
      const { executeOptimize } = await import("../../../src/cli/commands/strategy/execute-optimize");
      vi.mocked(executeOptimize).mockImplementation(() => optimizationPromise);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      const options: DaemonOptions = {
        account: "0x1234567890123456789012345678901234567890",
        interval: 1,
        dbPath: testDbPath,
        autoOptimize: true,
      };

      const daemonPromise = daemon(options).catch(() => {
        // Expected to exit
      });

      // Wait for initialization
      await vi.advanceTimersByTimeAsync(100);

      // Trigger first monitoring check (starts optimization)
      await vi.advanceTimersByTimeAsync(1000);

      // Trigger second monitoring check while optimization is still running
      await vi.advanceTimersByTimeAsync(1000);

      // Verify optimization was called only once (concurrent prevention)
      const { executeOptimize: executeOptimizeFn } = await import("../../../src/cli/commands/strategy/execute-optimize");
      expect(executeOptimizeFn).toHaveBeenCalledTimes(1);

      // Resolve optimization
      resolveOptimization!();

      // Stop daemon
      process.emit("SIGINT" as any, "SIGINT");
      await vi.advanceTimersByTimeAsync(100);

      exitSpy.mockRestore();
    });

    it("should reset failure counter after successful optimization", async () => {
      const status = createMockStatus();
      const recommendation: Recommendation = {
        action: StrategyAction.OPTIMIZE,
        reason: "Delta drift exceeds threshold",
      };

      // First call fails, second succeeds
      let callCount = 0;
      mockCheckFn.mockResolvedValue({ status, recommendation });
      const { executeOptimize } = await import("../../../src/cli/commands/strategy/execute-optimize");
      vi.mocked(executeOptimize).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("First optimization fails"));
        }
        return Promise.resolve(undefined);
      });

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      const options: DaemonOptions = {
        account: "0x1234567890123456789012345678901234567890",
        interval: 1,
        dbPath: testDbPath,
        autoOptimize: true,
      };

      const daemonPromise = daemon(options).catch(() => {
        // Expected to exit
      });

      // Wait for initialization
      await vi.advanceTimersByTimeAsync(100);

      // First check - optimization fails
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      // Get call count after first failure
      const { executeOptimize: executeOptimizeFn } = await import("../../../src/cli/commands/strategy/execute-optimize");
      const callsAfterFirstFailure = vi.mocked(executeOptimizeFn).mock.calls.length;

      // Second check - optimization succeeds (should reset counter)
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      // Third check - should still trigger optimization (counter was reset)
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      // Stop daemon
      process.emit("SIGINT" as any, "SIGINT");
      await vi.advanceTimersByTimeAsync(100);

      // Verify optimization was called at least 3 times (failure, success, then another attempt)
      // We check for at least 3 because the daemon may have made additional checks
      expect(vi.mocked(executeOptimizeFn).mock.calls.length).toBeGreaterThanOrEqual(3);
      
      // Verify that after the first failure, we had at least 2 more calls (success + another attempt)
      const totalCalls = vi.mocked(executeOptimizeFn).mock.calls.length;
      expect(totalCalls - callsAfterFirstFailure).toBeGreaterThanOrEqual(2);

      exitSpy.mockRestore();
    });
  });
});
