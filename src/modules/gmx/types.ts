export interface GMXPositionAddresses {
  account: string;
  market: string;
  collateralToken: string;
}

export interface GMXPositionNumbers {
  sizeInUsd: bigint;
  sizeInTokens: bigint;
  collateralAmount: bigint;
  borrowingFactor: bigint;
  fundingFeeAmountPerSize: bigint;
  longTokenClaimableFundingAmountPerSize: bigint;
  shortTokenClaimableFundingAmountPerSize: bigint;
  increasedAtBlock: bigint;
  decreasedAtBlock: bigint;
  increasedAtTime: bigint;
  decreasedAtTime: bigint;
}

export interface GMXPositionFlags {
  isLong: boolean;
}

export interface GMXPosition {
  addresses: GMXPositionAddresses;
  numbers: GMXPositionNumbers;
  flags: GMXPositionFlags;
}

export interface GMXReader {
  getAccountPositions(
    dataStore: string,
    account: string,
    start: number,
    end: number
  ): Promise<GMXPosition[]>;
}

export enum GMXOrderType {
  MarketIncrease = 2,
  MarketDecrease = 4,
}

export enum GMXDecreasePositionSwapType {
  NoSwap = 0,
}

export interface GMXOrderAddresses {
  receiver: string;
  cancellationReceiver: string;
  callbackContract: string;
  uiFeeReceiver: string;
  market: string;
  initialCollateralToken: string;
  swapPath: string[];
}

export interface GMXOrderNumbers {
  sizeDeltaUsd: bigint;
  initialCollateralDeltaAmount: bigint;
  triggerPrice: bigint;
  acceptablePrice: bigint;
  executionFee: bigint;
  callbackGasLimit: bigint;
  minOutputAmount: bigint;
  validFromTime: bigint;
}

export type GMXOrderParams = [
  GMXOrderAddresses,
  GMXOrderNumbers,
  GMXOrderType,
  GMXDecreasePositionSwapType,
  boolean,
  boolean,
  boolean,
  string,
  string[],
];

export interface GMXRouter {
  interface: {
    encodeFunctionData(name: string, values: unknown[]): string;
  };
  multicall(
    data: string[],
    overrides: { value: bigint; gasLimit?: number; nonce?: number }
  ): Promise<{ hash: string; wait: () => Promise<unknown> }>;
  multicall?: {
    staticCall?: (data: string[], overrides: { value: bigint }) => Promise<unknown>;
  };
}

export interface IERC20 {
  allowance(owner: string, spender: string): Promise<bigint>;
  approve(spender: string, amount: bigint): Promise<{ wait: () => Promise<unknown> }>;
}

export interface GMXIncreaseOrderRequest {
  account: string;
  market: string;
  collateralToken: string;
  sizeDeltaUsd: bigint;
  collateralAmount: bigint;
  acceptablePrice: bigint;
  executionFee: bigint;
  orderType?: GMXOrderType;
  swapPath?: string[];
  callbackContract?: string;
  uiFeeReceiver?: string;
  shouldUnwrapNativeToken?: boolean;
  autoCancel?: boolean;
  referralCode?: string;
  dataList?: string[];
  isLong?: boolean;
}

export interface GMXDecreaseOrderRequest {
  account: string;
  market: string;
  collateralToken: string;
  sizeDeltaUsd: bigint;
  acceptablePrice: bigint;
  executionFee: bigint;
  orderType?: GMXOrderType;
  swapPath?: string[];
  callbackContract?: string;
  uiFeeReceiver?: string;
  shouldUnwrapNativeToken?: boolean;
  autoCancel?: boolean;
  referralCode?: string;
  dataList?: string[];
  isLong?: boolean;
}

export interface GMXOrderExecutionConfig {
  orderVault: string;
  routerAddress?: string;
  gasLimit?: number;
  nonce?: number;
  performStaticCall?: boolean;
}

export interface GMXOrderExecutionResult {
  orderParams: GMXOrderParams;
  multicallData: string[];
  txHash: string;
}
