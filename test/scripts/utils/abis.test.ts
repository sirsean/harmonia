import { describe, it, expect } from "vitest";
import {
  ERC20_ABI,
  ERC20_MINIMAL_ABI,
  POOL_TOKEN_ABI,
  ROUTER_ABI,
  QUOTER_ABI,
} from "../../../scripts/utils/abis";

describe("Script ABIs", () => {
  describe("ERC20_ABI", () => {
    it("should contain all standard ERC20 functions", () => {
      expect(ERC20_ABI).toContain("function decimals() view returns (uint8)");
      expect(ERC20_ABI).toContain("function symbol() view returns (string)");
      expect(ERC20_ABI).toContain("function balanceOf(address account) view returns (uint256)");
      expect(ERC20_ABI).toContain(
        "function allowance(address owner, address spender) view returns (uint256)"
      );
      expect(ERC20_ABI).toContain(
        "function approve(address spender, uint256 amount) returns (bool)"
      );
    });

    it("should be a readonly array", () => {
      expect(Array.isArray(ERC20_ABI)).toBe(true);
      expect(ERC20_ABI.length).toBe(5);
    });
  });

  describe("ERC20_MINIMAL_ABI", () => {
    it("should contain only decimals function", () => {
      expect(ERC20_MINIMAL_ABI).toContain("function decimals() view returns (uint8)");
      expect(ERC20_MINIMAL_ABI.length).toBe(1);
    });
  });

  describe("POOL_TOKEN_ABI", () => {
    it("should contain token0 and token1 functions", () => {
      expect(POOL_TOKEN_ABI).toContain("function token0() view returns (address)");
      expect(POOL_TOKEN_ABI).toContain("function token1() view returns (address)");
      expect(POOL_TOKEN_ABI.length).toBe(2);
    });
  });

  describe("ROUTER_ABI", () => {
    it("should contain exactInputSingle function", () => {
      expect(ROUTER_ABI.length).toBe(1);
      expect(ROUTER_ABI[0]).toContain("exactInputSingle");
      expect(ROUTER_ABI[0]).toContain("returns (uint256 amountOut)");
    });
  });

  describe("QUOTER_ABI", () => {
    it("should contain quoteExactInputSingle function", () => {
      expect(QUOTER_ABI.length).toBe(1);
      expect(QUOTER_ABI[0]).toContain("quoteExactInputSingle");
      expect(QUOTER_ABI[0]).toContain("returns (uint256 amountOut)");
    });
  });

  describe("ABI consistency", () => {
    it("should have all ABIs as readonly arrays", () => {
      const abis = [ERC20_ABI, ERC20_MINIMAL_ABI, POOL_TOKEN_ABI, ROUTER_ABI, QUOTER_ABI];
      for (const abi of abis) {
        expect(Array.isArray(abi)).toBe(true);
        expect(abi.length).toBeGreaterThan(0);
      }
    });

    it("should have valid function signatures", () => {
      const allAbis = [
        ...ERC20_ABI,
        ...ERC20_MINIMAL_ABI,
        ...POOL_TOKEN_ABI,
        ...ROUTER_ABI,
        ...QUOTER_ABI,
      ];

      for (const funcSig of allAbis) {
        expect(typeof funcSig).toBe("string");
        expect(funcSig).toContain("function");
      }
    });
  });
});
