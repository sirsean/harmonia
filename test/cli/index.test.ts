import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

// Mock hardhat
vi.mock("hardhat", () => ({
  ethers: {
    provider: {
      getBalance: vi.fn(),
    },
    getSigners: vi.fn(() => [
      {
        getAddress: vi.fn(() => Promise.resolve("0x1234567890123456789012345678901234567890")),
      },
    ]),
    Contract: vi.fn(),
    formatEther: vi.fn((val) => val.toString()),
    formatUnits: vi.fn((val, decimals) => val.toString()),
    parseUnits: vi.fn((val, decimals) => BigInt(val)),
    parseEther: vi.fn((val) => BigInt(val)),
  },
}));

describe("CLI", () => {
  it("should be importable", async () => {
    // Just verify the CLI module can be imported without executing
    // The module should not call program.parse() when imported
    const cliModule = await import("../../src/cli/index");
    expect(cliModule).toBeDefined();
  });
});
