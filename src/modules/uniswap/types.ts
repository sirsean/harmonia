export interface UniswapSlot0 {
  sqrtPriceX96: bigint;
  tick: number;
  observationIndex: number;
  observationCardinality: number;
  observationCardinalityNext: number;
  feeProtocol: number;
  unlocked: boolean;
}

export interface UniswapPoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

export interface UniswapV3Pool {
  slot0(): Promise<[bigint, number, number, number, number, number, boolean]>;
  liquidity(): Promise<bigint>;
  token0(): Promise<string>;
  token1(): Promise<string>;
  fee(): Promise<number>;
}

export interface UniswapPosition {
  nonce: bigint;
  operator: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export interface UniswapPositionManager {
  positions(
    tokenId: bigint
  ): Promise<
    [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]
  >;
  balanceOf(owner: string): Promise<bigint>;
  tokenOfOwnerByIndex(owner: string, index: bigint | number): Promise<bigint>;
  mint(
    params: MintParams,
    overrides?: { nonce?: number }
  ): Promise<{ hash: string; wait: () => Promise<unknown> }>;
  increaseLiquidity(
    params: IncreaseLiquidityParams,
    overrides?: { nonce?: number }
  ): Promise<{ hash: string; wait: () => Promise<unknown> }>;
  decreaseLiquidity(
    params: DecreaseLiquidityParams,
    overrides?: { nonce?: number }
  ): Promise<{ hash: string; wait: () => Promise<unknown> }>;
  collect(
    params: CollectParams,
    overrides?: { nonce?: number }
  ): Promise<{ hash: string; wait: () => Promise<unknown> }>;
  multicall(
    data: string[],
    overrides?: { nonce?: number }
  ): Promise<{ hash: string; wait: () => Promise<unknown> }>;
}

export interface IERC20 {
  allowance(owner: string, spender: string): Promise<bigint>;
  approve(spender: string, amount: bigint): Promise<{ wait: () => Promise<unknown> }>;
}

export interface MintParams {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: string;
  deadline: bigint;
}

export interface IncreaseLiquidityParams {
  tokenId: bigint;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  deadline: bigint;
}

export interface DecreaseLiquidityParams {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  deadline: bigint;
}

export interface CollectParams {
  tokenId: bigint;
  recipient: string;
  amount0Max: bigint;
  amount1Max: bigint;
}

export interface UniswapExecutionConfig {
  spender?: string;
  performApproval?: boolean;
  // Note: All transactions always wait for receipt - no option to disable
}

export interface UniswapTransactionResult<TParams> {
  params: TParams;
  txHash?: string;
  tx?: { hash: string; wait: () => Promise<unknown> };
}
