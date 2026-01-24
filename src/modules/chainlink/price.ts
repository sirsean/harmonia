import { ethers } from "ethers";
import {
  ChainlinkFeed,
  ChainlinkPriceOptions,
  ChainlinkPriceResult,
  ChainlinkRoundData,
} from "./types";
import { CHAINLINK_FEED_ABI } from "../../utils/abis";

const FEED_ABI = CHAINLINK_FEED_ABI;

const DEFAULT_MAX_STALE_SECONDS = 60 * 60; // 1 hour
const DEFAULT_ALLOW_FUTURE_SECONDS = 5 * 60; // 5 minutes
const WAD_DECIMALS = 18;

export class ChainlinkPriceError extends Error {
  code: string;
  context?: Record<string, unknown>;

  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.context = context;
  }
}

export function createChainlinkFeed(address: string, provider: ethers.Provider): ChainlinkFeed {
  return new ethers.Contract(address, FEED_ABI, provider) as unknown as ChainlinkFeed;
}

export function scalePrice(price: bigint, priceDecimals: number, outputDecimals: number): bigint {
  if (outputDecimals === priceDecimals) {
    return price;
  }

  if (outputDecimals > priceDecimals) {
    const diff = outputDecimals - priceDecimals;
    return price * 10n ** BigInt(diff);
  }

  const diff = priceDecimals - outputDecimals;
  return price / 10n ** BigInt(diff);
}

export function normalizeRoundData(
  roundData: [bigint, bigint, bigint, bigint, bigint]
): ChainlinkRoundData {
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = roundData;
  return {
    roundId,
    answer,
    startedAt,
    updatedAt,
    answeredInRound,
  };
}

export function validateRoundData(
  data: ChainlinkRoundData,
  options: ChainlinkPriceOptions = {}
): void {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const maxStaleSeconds = options.maxStaleSeconds ?? DEFAULT_MAX_STALE_SECONDS;
  const allowFutureSeconds = options.allowFutureSeconds ?? DEFAULT_ALLOW_FUTURE_SECONDS;
  const requirePositive = options.requirePositive ?? true;

  if (data.updatedAt === 0n) {
    throw new ChainlinkPriceError("NO_UPDATE", "Chainlink feed has no updatedAt timestamp.");
  }

  if (data.answeredInRound < data.roundId) {
    throw new ChainlinkPriceError(
      "STALE_ROUND",
      "Chainlink feed answeredInRound is behind roundId.",
      {
        roundId: data.roundId.toString(),
        answeredInRound: data.answeredInRound.toString(),
      }
    );
  }

  if (requirePositive && data.answer <= 0n) {
    throw new ChainlinkPriceError("NON_POSITIVE", "Chainlink price is non-positive.", {
      answer: data.answer.toString(),
    });
  }

  const updatedAt = Number(data.updatedAt);
  const delta = nowSec - updatedAt;

  if (delta > maxStaleSeconds) {
    throw new ChainlinkPriceError("STALE_PRICE", "Chainlink price is stale.", {
      updatedAt,
      nowSec,
      maxStaleSeconds,
    });
  }

  if (updatedAt - nowSec > allowFutureSeconds) {
    throw new ChainlinkPriceError(
      "FUTURE_TIMESTAMP",
      "Chainlink updatedAt is too far in the future.",
      {
        updatedAt,
        nowSec,
        allowFutureSeconds,
      }
    );
  }
}

export async function getLatestPriceFromFeed(
  feed: ChainlinkFeed,
  options: ChainlinkPriceOptions = {}
): Promise<ChainlinkPriceResult> {
  const roundData = normalizeRoundData(await feed.latestRoundData());
  validateRoundData(roundData, options);

  const decimalsRaw = await feed.decimals();
  const decimals = typeof decimalsRaw === "bigint" ? Number(decimalsRaw) : decimalsRaw;

  const priceWad = scalePrice(roundData.answer, decimals, WAD_DECIMALS);

  const result: ChainlinkPriceResult = {
    roundId: roundData.roundId,
    answeredInRound: roundData.answeredInRound,
    startedAt: Number(roundData.startedAt),
    updatedAt: Number(roundData.updatedAt),
    price: roundData.answer,
    decimals,
    priceWad,
  };

  if (options.outputDecimals !== undefined) {
    result.outputDecimals = options.outputDecimals;
    result.outputPrice = scalePrice(roundData.answer, decimals, options.outputDecimals);
  }

  return result;
}

export async function getLatestPrice(
  address: string,
  provider: ethers.Provider,
  options: ChainlinkPriceOptions = {}
): Promise<ChainlinkPriceResult> {
  const feed = createChainlinkFeed(address, provider);
  return getLatestPriceFromFeed(feed, options);
}
