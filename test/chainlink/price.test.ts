import { describe, expect, it } from "vitest";
import {
  ChainlinkFeed,
  ChainlinkPriceOptions,
} from "../../src/modules/chainlink/types";
import {
  ChainlinkPriceError,
  getLatestPriceFromFeed,
  scalePrice,
} from "../../src/modules/chainlink/price";

interface RoundOverrides {
  roundId?: bigint;
  answer?: bigint;
  startedAt?: bigint;
  updatedAt?: bigint;
  answeredInRound?: bigint;
}

const makeFeed = (overrides?: RoundOverrides): ChainlinkFeed => {
  const roundData = buildRoundData(overrides);
  return {
    latestRoundData: async () => roundData,
    decimals: async () => 8n,
  };
};

const buildRoundData = (overrides?: RoundOverrides) => {
  return buildRoundDataBase({
    roundId: 10n,
    answer: 2000_00000000n,
    startedAt: 1_000_000n,
    updatedAt: 1_000_050n,
    answeredInRound: 10n,
    ...overrides,
  });
};

const buildRoundDataBase = (data: {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}) => {
  return [data.roundId, data.answer, data.startedAt, data.updatedAt, data.answeredInRound] as const;
};

const baseOptions = (overrides?: Partial<ChainlinkPriceOptions>): ChainlinkPriceOptions => ({
  nowSec: 1_000_100,
  maxStaleSeconds: 120,
  allowFutureSeconds: 60,
  ...overrides,
});

describe("scalePrice", () => {
  it("scales up when output decimals are higher", () => {
    expect(scalePrice(100n, 8, 18)).toBe(100n * 10n ** 10n);
  });

  it("scales down when output decimals are lower", () => {
    expect(scalePrice(123456789n, 8, 2)).toBe(123n);
  });
});

describe("getLatestPriceFromFeed", () => {
  it("returns a validated price payload", async () => {
    const feed = makeFeed();
    const result = await getLatestPriceFromFeed(feed, baseOptions({ outputDecimals: 12 }));

    expect(result.price).toBe(2000_00000000n);
    expect(result.decimals).toBe(8);
    expect(result.priceWad).toBe(2000_00000000n * 10n ** 10n);
    expect(result.outputPrice).toBe(2000_00000000n * 10n ** 4n);
    expect(result.outputDecimals).toBe(12);
  });

  it("throws for stale prices", async () => {
    const feed = makeFeed({ updatedAt: 999_900n });

    await expect(getLatestPriceFromFeed(feed, baseOptions())).rejects.toMatchObject({
      code: "STALE_PRICE",
    });
  });

  it("throws for future timestamps beyond tolerance", async () => {
    const feed = makeFeed({ updatedAt: 1_000_200n });

    await expect(getLatestPriceFromFeed(feed, baseOptions())).rejects.toMatchObject({
      code: "FUTURE_TIMESTAMP",
    });
  });

  it("throws for non-positive answers", async () => {
    const feed = makeFeed({ answer: 0n });

    await expect(getLatestPriceFromFeed(feed, baseOptions())).rejects.toMatchObject({
      code: "NON_POSITIVE",
    });
  });

  it("throws for answeredInRound lag", async () => {
    const feed = makeFeed({ answeredInRound: 9n });

    await expect(getLatestPriceFromFeed(feed, baseOptions())).rejects.toMatchObject({
      code: "STALE_ROUND",
    });
  });

  it("throws for missing updatedAt", async () => {
    const feed = makeFeed({ updatedAt: 0n });

    await expect(getLatestPriceFromFeed(feed, baseOptions())).rejects.toBeInstanceOf(ChainlinkPriceError);
  });
});
