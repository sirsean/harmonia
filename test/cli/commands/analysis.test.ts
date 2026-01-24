import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerAnalysisCommands } from "../../../src/cli/commands/analysis";

// Mock hardhat
vi.mock("hardhat", () => ({
  ethers: {
    getSigners: vi.fn(() => [
      {
        getAddress: vi.fn(() => Promise.resolve("0x1234567890123456789012345678901234567890")),
      },
    ]),
  },
}));

describe("Analysis Commands", () => {
  it("should register analysis commands", () => {
    const program = new Command();
    registerAnalysisCommands(program);

    // Find the analyze command
    const analyzeCommand = program.commands.find((cmd) => cmd.name() === "analyze");
    expect(analyzeCommand).toBeDefined();

    // Check that subcommands are registered
    const subcommands = analyzeCommand?.commands.map((cmd) => cmd.name()) || [];
    expect(subcommands).toContain("loss");
    expect(subcommands).toContain("range-size");
    expect(subcommands).toContain("slippage");
    expect(subcommands).toContain("slippage-report");
  });
});
