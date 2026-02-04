import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ChainlinkFeed,
  ChainlinkPriceOptions,
} from "../../src/modules/chainlink/types";
import {
  ChainlinkPriceError,
  getLatestPriceFromFeed,
  resetDecimalsCache,
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
    latestRoundData: async () => [...roundData] as [bigint, bigint, bigint, bigint, bigint],
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
  beforeEach(() => {
    resetDecimalsCache();
  });

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

describe("decimals caching", () => {
  beforeEach(() => {
    resetDecimalsCache();
  });

  it("caches decimals for feeds with a target address", async () => {
    const decimalsSpy = vi.fn().mockResolvedValue(8n);
    const feed = {
      target: "0xFeedAddress",
      latestRoundData: async () =>
        [10n, 2000_00000000n, 1_000_000n, 1_000_050n, 10n] as [bigint, bigint, bigint, bigint, bigint],
      decimals: decimalsSpy,
    } as unknown as ChainlinkFeed;

    await getLatestPriceFromFeed(feed, baseOptions());
    await getLatestPriceFromFeed(feed, baseOptions());
    await getLatestPriceFromFeed(feed, baseOptions());

    expect(decimalsSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache for feeds without a target address", async () => {
    const decimalsSpy = vi.fn().mockResolvedValue(8n);
    const feed = {
      latestRoundData: async () =>
        [10n, 2000_00000000n, 1_000_000n, 1_000_050n, 10n] as [bigint, bigint, bigint, bigint, bigint],
      decimals: decimalsSpy,
    } as unknown as ChainlinkFeed;

    await getLatestPriceFromFeed(feed, baseOptions());
    await getLatestPriceFromFeed(feed, baseOptions());

    expect(decimalsSpy).toHaveBeenCalledTimes(2);
  });

  it("shares cache across feeds with the same address", async () => {
    const decimalsSpy1 = vi.fn().mockResolvedValue(8n);
    const decimalsSpy2 = vi.fn().mockResolvedValue(8n);

    const feed1 = {
      target: "0xSameAddress",
      latestRoundData: async () =>
        [10n, 2000_00000000n, 1_000_000n, 1_000_050n, 10n] as [bigint, bigint, bigint, bigint, bigint],
      decimals: decimalsSpy1,
    } as unknown as ChainlinkFeed;

    const feed2 = {
      target: "0xSameAddress",
      latestRoundData: async () =>
        [11n, 2100_00000000n, 1_000_100n, 1_000_150n, 11n] as [bigint, bigint, bigint, bigint, bigint],
      decimals: decimalsSpy2,
    } as unknown as ChainlinkFeed;

    await getLatestPriceFromFeed(feed1, baseOptions());
    await getLatestPriceFromFeed(feed2, baseOptions({ nowSec: 1_000_200 }));

    expect(decimalsSpy1).toHaveBeenCalledTimes(1);
    expect(decimalsSpy2).toHaveBeenCalledTimes(0);
  });

  it("resetDecimalsCache clears the cache", async () => {
    const decimalsSpy = vi.fn().mockResolvedValue(8n);
    const feed = {
      target: "0xFeedAddress",
      latestRoundData: async () =>
        [10n, 2000_00000000n, 1_000_000n, 1_000_050n, 10n] as [bigint, bigint, bigint, bigint, bigint],
      decimals: decimalsSpy,
    } as unknown as ChainlinkFeed;

    await getLatestPriceFromFeed(feed, baseOptions());
    expect(decimalsSpy).toHaveBeenCalledTimes(1);

    resetDecimalsCache();

    await getLatestPriceFromFeed(feed, baseOptions());
    expect(decimalsSpy).toHaveBeenCalledTimes(2);
  });

  it("handles case-insensitive address matching", async () => {
    const decimalsSpy1 = vi.fn().mockResolvedValue(8n);
    const decimalsSpy2 = vi.fn().mockResolvedValue(8n);

    const feed1 = {
      target: "0xAbCdEf",
      latestRoundData: async () =>
        [10n, 2000_00000000n, 1_000_000n, 1_000_050n, 10n] as [bigint, bigint, bigint, bigint, bigint],
      decimals: decimalsSpy1,
    } as unknown as ChainlinkFeed;

    const feed2 = {
      target: "0xabcdef",
      latestRoundData: async () =>
        [11n, 2100_00000000n, 1_000_100n, 1_000_150n, 11n] as [bigint, bigint, bigint, bigint, bigint],
      decimals: decimalsSpy2,
    } as unknown as ChainlinkFeed;

    await getLatestPriceFromFeed(feed1, baseOptions());
    await getLatestPriceFromFeed(feed2, baseOptions({ nowSec: 1_000_200 }));

    expect(decimalsSpy1).toHaveBeenCalledTimes(1);
    expect(decimalsSpy2).toHaveBeenCalledTimes(0);
  });
});
