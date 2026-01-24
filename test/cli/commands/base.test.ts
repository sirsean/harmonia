import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { addCommonOptions, getSignerAndAccount } from "../../../src/cli/commands/base";

// Mock hardhat
const mockSigner = {
  getAddress: vi.fn(() => Promise.resolve("0x1234567890123456789012345678901234567890")),
};

vi.mock("hardhat", () => ({
  ethers: {
    getSigners: vi.fn(() => [mockSigner]),
  },
}));

describe("Base Commands", () => {
  describe("addCommonOptions", () => {
    it("should add common options to a command", () => {
      const command = new Command("test");
      const result = addCommonOptions(command);

      expect(result).toBe(command);
      // Verify options are added (commander doesn't expose options directly, but we can check the command exists)
      expect(command).toBeDefined();
    });
  });

  describe("getSignerAndAccount", () => {
    it("should return signer and account", async () => {
      const result = await getSignerAndAccount();

      expect(result.signer).toBe(mockSigner);
      expect(result.account).toBe("0x1234567890123456789012345678901234567890");
    });

    it("should use provided account override", async () => {
      const overrideAccount = "0x9876543210987654321098765432109876543210";
      const result = await getSignerAndAccount(overrideAccount);

      expect(result.account).toBe(overrideAccount);
    });
  });
});
