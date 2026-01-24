import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerUtilityCommands } from "../../../src/cli/commands/utility";

// Mock hardhat
vi.mock("hardhat", () => ({
  ethers: {
    provider: {
      getBalance: vi.fn(() => Promise.resolve(BigInt("1000000000000000000"))),
    },
    getSigners: vi.fn(() => [
      {
        getAddress: vi.fn(() => Promise.resolve("0x1234567890123456789012345678901234567890")),
      },
    ]),
    Contract: vi.fn(() => ({
      balanceOf: vi.fn(() => Promise.resolve(BigInt("1000000"))),
    })),
    formatEther: vi.fn((val) => "1.0"),
    formatUnits: vi.fn((val, decimals) => "1.0"),
  },
}));

describe("Utility Commands", () => {
  it("should register utility commands", () => {
    const program = new Command();
    registerUtilityCommands(program);

    // Find the util command
    const utilCommand = program.commands.find((cmd) => cmd.name() === "util");
    expect(utilCommand).toBeDefined();

    // Check that subcommands are registered
    const subcommands = utilCommand?.commands.map((cmd) => cmd.name()) || [];
    expect(subcommands).toContain("balance");
    expect(subcommands).toContain("usdc");
  });
});
