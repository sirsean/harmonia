import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerUniswapCommands } from "../../../src/cli/commands/uniswap";

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
    formatUnits: vi.fn((val) => val.toString()),
  },
}));

vi.mock("../../../src/modules/uniswap/reader", () => ({
  createPool: vi.fn(),
  createPositionManager: vi.fn(),
  getPoolState: vi.fn(),
  getPosition: vi.fn(),
  getPositionWithFees: vi.fn(),
  getTokenIdsForOwner: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../../src/modules/math/ticks", () => ({
  getAmountsForLiquidity: vi.fn(),
  getSqrtRatioAtTick: vi.fn(),
  tickToPriceWithDecimals: vi.fn(),
}));

describe("Uniswap Commands", () => {
  it("should register Uniswap commands", () => {
    const program = new Command();
    registerUniswapCommands(program);

    // Find the uniswap command
    const uniswapCommand = program.commands.find((cmd) => cmd.name() === "uniswap");
    expect(uniswapCommand).toBeDefined();

    // Check that subcommands are registered
    const subcommands = uniswapCommand?.commands.map((cmd) => cmd.name()) || [];
    expect(subcommands).toContain("read-position");
    expect(subcommands).toContain("check-pool");
  });
});
