import { describe, expect, it } from "vitest";
import { findPosition, getAccountPositions, getPosition } from "../../src/modules/gmx/reader";
import { GMXPosition, GMXReader } from "../../src/modules/gmx/types";

const makePosition = (overrides?: Partial<GMXPosition>): GMXPosition => ({
  addresses: {
    account: "0xAccount",
    market: "0xMarket",
    collateralToken: "0xCollateral",
    ...(overrides?.addresses || {}),
  },
  numbers: {
    sizeInUsd: 100n,
    sizeInTokens: 1n,
    collateralAmount: 2n,
    borrowingFactor: 0n,
    fundingFeeAmountPerSize: 0n,
    longTokenClaimableFundingAmountPerSize: 0n,
    shortTokenClaimableFundingAmountPerSize: 0n,
    increasedAtTime: 0n,
    decreasedAtTime: 0n,
    ...overrides?.numbers,
  },
  flags: {
    isLong: false,
    ...overrides?.flags,
  },
});

describe("gmx reader", () => {
  it("filters positions by market, collateral, and side", () => {
    const positions = [
      makePosition({
        addresses: { account: "0xAccount", market: "0xAAA", collateralToken: "0xCollateral" },
        flags: { isLong: false },
      }),
      makePosition({
        addresses: { account: "0xAccount", market: "0xBBB", collateralToken: "0xCollateral" },
        flags: { isLong: true },
      }),
    ];

    const match = findPosition(positions, {
      market: "0xbbb",
      collateralToken: "0xCollateral",
      isLong: true,
    });

    expect(match?.addresses.market).toBe("0xBBB");
  });

  it("returns undefined when no match", () => {
    const positions = [
      makePosition({
        addresses: { account: "0xAccount", market: "0xAAA", collateralToken: "0xCollateral" },
      }),
    ];
    const match = findPosition(positions, { market: "0xNOPE" });
    expect(match).toBeUndefined();
  });

  it("wraps reader getAccountPositions", async () => {
    const reader: GMXReader = {
      getAccountPositions: async () => [makePosition()],
      getMarket: async () => ({
        marketToken: "0x",
        indexToken: "0x",
        longToken: "0x",
        shortToken: "0x",
      }),
    };

    const positions = await getAccountPositions(reader, "0xDataStore", "0xAccount", 0, 10);
    expect(positions).toHaveLength(1);
  });

  it("getPosition applies defaults", async () => {
    const reader: GMXReader = {
      getAccountPositions: async () => [
        makePosition({
          addresses: { account: "0xAccount", market: "0xAAA", collateralToken: "0xCollateral" },
        }),
      ],
      getMarket: async () => ({
        marketToken: "0x",
        indexToken: "0x",
        longToken: "0x",
        shortToken: "0x",
      }),
    };

    const position = await getPosition(reader, "0xDataStore", "0xAccount", {
      market: "0xaaa",
    });

    expect(position?.addresses.market).toBe("0xAAA");
  });
});
