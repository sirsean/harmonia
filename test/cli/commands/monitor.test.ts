import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerMonitorCommand } from "../../../src/cli/commands/monitor";

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
          uniswap: [],
          totalLpDelta: 0n,
          gmx: {
            positionSizeTokens: 0n,
            delta: 0n,
            collateralAmount: 0n,
            netValueUsd: 0n,
          },
          netDelta: 0n,
          deltaDrift: 0,
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
  loadStrategyConfig: vi.fn((config) => config),
}));

vi.mock("../../../src/modules/uniswap/reader", () => ({
  createPool: vi.fn(() => ({
    token0: vi.fn(() => Promise.resolve("0xtoken0")),
    token1: vi.fn(() => Promise.resolve("0xtoken1")),
  })),
}));

describe("Monitor Command", () => {
  it("should register monitor command", () => {
    const program = new Command();
    registerMonitorCommand(program);

    // Find the monitor command
    const monitorCommand = program.commands.find((cmd) => cmd.name() === "monitor");
    expect(monitorCommand).toBeDefined();
    expect(monitorCommand?.description()).toBe("Monitor delta-neutral position status and health");
  });
});
