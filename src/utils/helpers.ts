/**
 * Shared utility functions for the Harmonia project
 *
 * These utilities are used across CLI commands, modules, and scripts.
 */

/**
 * Convert various value types to bigint
 *
 * Handles conversion from:
 * - BigNumberish (ethers types) - requires ethers to be imported by caller
 * - bigint
 * - number
 * - string
 * - Arrays (takes first element)
 * - Objects with amountOut, value, result properties
 * - Objects with toArray() method
 * - Iterable objects
 * - Objects with _hex or hex properties
 * - Objects with toHexString() method
 * - Array-like objects
 * - Any object with toString() method
 *
 * @param value - Value to convert to bigint
 * @returns bigint representation of the value
 * @throws Error if value cannot be converted
 */
export function toBigInt(value: unknown): bigint {
  // Try ethers.getBigInt if ethers is available (scripts/CLI will have it)
  // This is a dynamic check to avoid requiring hardhat in utils
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ethers } = require("hardhat");
    if (ethers && typeof ethers.getBigInt === "function") {
      return ethers.getBigInt(value as unknown);
    }
  } catch {
    // ethers not available, continue to other conversion methods
  }

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(value);
  }

  if (typeof value === "string") {
    return BigInt(value);
  }

  if (Array.isArray(value) && value.length > 0) {
    return toBigInt(value[0]);
  }

  if (value && typeof value === "object") {
    // Check for amountOut property (common in swap results)
    const maybeAmountOut = (value as { amountOut?: unknown }).amountOut;
    if (maybeAmountOut !== undefined) {
      return toBigInt(maybeAmountOut);
    }

    // Check for value property
    const maybeValue = (value as { value?: unknown }).value;
    if (maybeValue !== undefined) {
      return toBigInt(maybeValue);
    }

    // Check for result property (array)
    const maybeResult = (value as { result?: unknown }).result;
    if (Array.isArray(maybeResult) && maybeResult.length > 0) {
      return toBigInt(maybeResult[0]);
    }

    // Check for toArray() method
    const maybeToArray = (value as { toArray?: () => unknown[] }).toArray;
    if (typeof maybeToArray === "function") {
      const arr = maybeToArray();
      if (arr.length > 0) {
        return toBigInt(arr[0]);
      }
    }

    // Check for iterator
    const maybeIterator = (value as { [Symbol.iterator]?: () => Iterator<unknown> })[
      Symbol.iterator
    ];
    if (typeof maybeIterator === "function") {
      const iterator = maybeIterator.call(value);
      const first = iterator.next();
      if (!first.done) {
        return toBigInt(first.value);
      }
    }

    // Check for hex properties
    const maybeHex =
      (value as { _hex?: string; hex?: string })._hex ?? (value as { hex?: string }).hex;
    if (maybeHex) {
      return BigInt(maybeHex);
    }

    // Check for toHexString() method
    const maybeHexString = (value as { toHexString?: () => string }).toHexString;
    if (typeof maybeHexString === "function") {
      return BigInt(maybeHexString());
    }

    // Check for array-like object
    const maybeArrayLike = value as { length?: number; 0?: unknown };
    if (typeof maybeArrayLike.length === "number" && maybeArrayLike.length > 0) {
      return toBigInt(maybeArrayLike[0]);
    }
  }

  // Fallback to toString()
  try {
    return BigInt((value as { toString: () => string }).toString());
  } catch (error) {
    throw new Error(
      `Cannot convert value to bigint: ${JSON.stringify(value)}. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
