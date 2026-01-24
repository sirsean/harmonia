import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerGmxCommands } from "../../../src/cli/commands/gmx";

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
    parseUnits: vi.fn((val, decimals) => BigInt(val)),
    parseEther: vi.fn((val) => BigInt(val)),
  },
}));

vi.mock("../../../src/modules/gmx/reader", () => ({
  createReader: vi.fn(),
  getAccountPositions: vi.fn(() => Promise.resolve([])),
  getMarket: vi.fn(),
}));

vi.mock("../../../src/modules/gmx/prices", () => ({
  fetchTokenPrices: vi.fn(() => Promise.resolve([])),
  findTokenPrice: vi.fn(),
  averagePrice: vi.fn(),
  price30ToPrice12: vi.fn(),
  scalePriceTo30: vi.fn(),
}));

vi.mock("../../../src/modules/gmx/position", () => ({
  computeCollateralUsd30: vi.fn(),
  computeEntryPrice12: vi.fn(),
  computePnlUsd30FromPrices: vi.fn(),
  computeLiquidationPrice12: vi.fn(),
}));

vi.mock("../../../src/modules/gmx/orders", () => ({
  createIncreaseOrder: vi.fn(),
  createDecreaseOrder: vi.fn(),
  createRouter: vi.fn(),
}));

vi.mock("../../../src/modules/chainlink/price", () => ({
  getLatestPrice: vi.fn(() =>
    Promise.resolve({
      price: BigInt("3000000000000000000"),
      decimals: 18,
      outputPrice: BigInt("3000000000000"),
    })
  ),
}));

describe("GMX Commands", () => {
  it("should register GMX commands", () => {
    const program = new Command();
    registerGmxCommands(program);

    // Find the gmx command
    const gmxCommand = program.commands.find((cmd) => cmd.name() === "gmx");
    expect(gmxCommand).toBeDefined();

    // Check that subcommands are registered
    const subcommands = gmxCommand?.commands.map((cmd) => cmd.name()) || [];
    expect(subcommands).toContain("read-position");
    expect(subcommands).toContain("open-short");
    expect(subcommands).toContain("close-short");
    expect(subcommands).toContain("read-orders");
    expect(subcommands).toContain("read-order");
  });
});
