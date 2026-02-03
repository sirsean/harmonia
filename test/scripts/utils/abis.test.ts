import { describe, it, expect } from "vitest";
import {
  ERC20_ABI,
  UNISWAP_POOL_ABI,
  UNISWAP_ROUTER_ABI,
  UNISWAP_QUOTER_ABI,
} from "../../../src/utils/abis";

describe("ABI Definitions", () => {
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

  describe("UNISWAP_POOL_ABI", () => {
    it("should contain pool functions including token0 and token1", () => {
      const abiStrings = UNISWAP_POOL_ABI.join(" ");
      expect(abiStrings).toContain("function token0() view returns (address)");
      expect(abiStrings).toContain("function token1() view returns (address)");
      expect(abiStrings).toContain("function slot0()");
      expect(abiStrings).toContain("function liquidity()");
      expect(abiStrings).toContain("function fee()");
      expect(UNISWAP_POOL_ABI.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("UNISWAP_ROUTER_ABI", () => {
    it("should contain exactInputSingle function", () => {
      const abiStrings = UNISWAP_ROUTER_ABI.join(" ");
      expect(UNISWAP_ROUTER_ABI.length).toBe(2);
      expect(abiStrings).toContain("exactInputSingle");
      expect(abiStrings).toContain("returns (uint256 amountOut)");
    });
  });

  describe("UNISWAP_QUOTER_ABI", () => {
    it("should contain quoteExactInputSingle function", () => {
      expect(UNISWAP_QUOTER_ABI.length).toBe(1);
      expect(UNISWAP_QUOTER_ABI[0]).toContain("quoteExactInputSingle");
      expect(UNISWAP_QUOTER_ABI[0]).toContain("returns (uint256 amountOut)");
    });
  });

  describe("ABI consistency", () => {
    it("should have all ABIs as readonly arrays", () => {
      const abis = [ERC20_ABI, UNISWAP_POOL_ABI, UNISWAP_ROUTER_ABI, UNISWAP_QUOTER_ABI];
      for (const abi of abis) {
        expect(Array.isArray(abi)).toBe(true);
        expect(abi.length).toBeGreaterThan(0);
      }
    });

    it("should have valid function signatures", () => {
      const allAbis = [
        ...ERC20_ABI,
        ...UNISWAP_POOL_ABI,
        ...UNISWAP_ROUTER_ABI,
        ...UNISWAP_QUOTER_ABI,
      ];

      for (const funcSig of allAbis) {
        expect(typeof funcSig).toBe("string");
        expect(funcSig).toContain("function");
      }
    });
  });
});
