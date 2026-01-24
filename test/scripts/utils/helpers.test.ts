import { describe, it, expect } from "vitest";
import { toBigInt } from "../../../scripts/utils/helpers";

describe("Script Helpers", () => {
  describe("toBigInt", () => {
    it("should convert bigint to bigint", () => {
      expect(toBigInt(123n)).toBe(123n);
      expect(toBigInt(BigInt("999999999999999999"))).toBe(999999999999999999n);
    });

    it("should convert number to bigint", () => {
      expect(toBigInt(123)).toBe(123n);
      expect(toBigInt(0)).toBe(0n);
      expect(toBigInt(-100)).toBe(-100n);
    });

    it("should convert string to bigint", () => {
      expect(toBigInt("123")).toBe(123n);
      expect(toBigInt("0x123")).toBe(291n); // hex string
      expect(toBigInt("999999999999999999")).toBe(999999999999999999n);
    });

    it("should convert array (takes first element)", () => {
      expect(toBigInt([123n, 456n])).toBe(123n);
      expect(toBigInt([456])).toBe(456n);
      expect(toBigInt(["789"])).toBe(789n);
    });

    it("should convert object with amountOut property", () => {
      expect(toBigInt({ amountOut: 123n })).toBe(123n);
      expect(toBigInt({ amountOut: "456" })).toBe(456n);
      expect(toBigInt({ amountOut: 789 })).toBe(789n);
    });

    it("should convert object with value property", () => {
      expect(toBigInt({ value: 123n })).toBe(123n);
      expect(toBigInt({ value: "456" })).toBe(456n);
    });

    it("should convert object with result array property", () => {
      expect(toBigInt({ result: [123n, 456n] })).toBe(123n);
      expect(toBigInt({ result: ["789"] })).toBe(789n);
    });

    it("should convert object with toArray() method", () => {
      const obj = {
        toArray: () => [123n, 456n],
      };
      expect(toBigInt(obj)).toBe(123n);
    });

    it("should convert iterable object", () => {
      const obj = {
        [Symbol.iterator]: function* () {
          yield 123n;
          yield 456n;
        },
      };
      expect(toBigInt(obj)).toBe(123n);
    });

    it("should convert object with _hex property", () => {
      expect(toBigInt({ _hex: "0x7b" })).toBe(123n);
      expect(toBigInt({ hex: "0x1c8" })).toBe(456n);
    });

    it("should convert object with toHexString() method", () => {
      const obj = {
        toHexString: () => "0x7b",
      };
      expect(toBigInt(obj)).toBe(123n);
    });

    it("should convert array-like object", () => {
      expect(toBigInt({ length: 2, 0: 123n, 1: 456n })).toBe(123n);
      expect(toBigInt({ length: 1, 0: "789" })).toBe(789n);
    });

    it("should convert object with toString() method", () => {
      const obj = {
        toString: () => "123",
      };
      expect(toBigInt(obj)).toBe(123n);
    });

    it("should handle edge cases", () => {
      expect(toBigInt(0)).toBe(0n);
      expect(toBigInt("0")).toBe(0n);
      expect(toBigInt([0])).toBe(0n);
      expect(toBigInt({ value: 0 })).toBe(0n);
    });

    it("should handle empty array", () => {
      // Empty array falls through to toString() which returns ""
      // BigInt("") returns 0n (empty string converts to 0)
      expect(toBigInt([])).toBe(0n);
    });

    it("should handle null and undefined", () => {
      // These should fail but not crash
      expect(() => toBigInt(null as unknown)).toThrow();
      expect(() => toBigInt(undefined as unknown)).toThrow();
    });

    it("should handle complex nested structures", () => {
      const complex = {
        data: {
          result: {
            amountOut: 123n,
          },
        },
      };
      // Should fall through to toString() and fail, but not crash
      expect(() => toBigInt(complex)).toThrow();
    });

    it("should prioritize amountOut over other properties", () => {
      const obj = {
        amountOut: 123n,
        value: 456n,
        result: [789n],
      };
      expect(toBigInt(obj)).toBe(123n);
    });

    it("should handle BigNumber-like objects from ethers", () => {
      // Simulate ethers BigNumber structure
      const bigNumberLike = {
        _hex: "0x7b",
        _isBigNumber: true,
        toString: () => "123",
      };
      expect(toBigInt(bigNumberLike)).toBe(123n);
    });
  });
});
