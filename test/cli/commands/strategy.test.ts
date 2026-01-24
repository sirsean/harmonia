import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerStrategyCommands } from "../../../src/cli/commands/strategy";

// Mock hardhat and modules
vi.mock("hardhat", () => ({
  ethers: {
    provider: {},
    getSigners: vi.fn(() => [
      {
        getAddress: vi.fn(() => Promise.resolve("0x1234567890123456789012345678901234567890")),
      },
    ]),
    parseUnits: vi.fn((val, decimals) => BigInt(val)),
  },
}));

vi.mock("../../../src/strategy/monitor", () => ({
  DeltaNeutralMonitor: vi.fn(() => ({
    check: vi.fn(() =>
      Promise.resolve({
        status: "healthy",
        recommendation: {
          action: "NONE",
          reason: null,
        },
      })
    ),
  })),
}));

vi.mock("../../../src/config/strategy", () => ({
  loadStrategyConfig: vi.fn((config) => config),
}));

describe("Strategy Commands", () => {
  it("should register strategy commands", () => {
    const program = new Command();
    registerStrategyCommands(program);

    // Find the strategy command
    const strategyCommand = program.commands.find((cmd) => cmd.name() === "strategy");
    expect(strategyCommand).toBeDefined();

    // Check that subcommands are registered
    const subcommands = strategyCommand?.commands.map((cmd) => cmd.name()) || [];
    expect(subcommands).toContain("monitor");
    expect(subcommands).toContain("rebalance");
    expect(subcommands).toContain("adjust-range");
  });
});
