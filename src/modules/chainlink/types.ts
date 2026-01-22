export interface ChainlinkRoundData {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

export interface ChainlinkPriceResult {
  roundId: bigint;
  answeredInRound: bigint;
  startedAt: number;
  updatedAt: number;
  price: bigint;
  decimals: number;
  priceWad: bigint;
  outputPrice?: bigint;
  outputDecimals?: number;
}

export interface ChainlinkPriceOptions {
  maxStaleSeconds?: number;
  allowFutureSeconds?: number;
  requirePositive?: boolean;
  nowSec?: number;
  outputDecimals?: number;
}

export interface ChainlinkFeed {
  latestRoundData(): Promise<[bigint, bigint, bigint, bigint, bigint]>;
  decimals(): Promise<bigint | number>;
}
