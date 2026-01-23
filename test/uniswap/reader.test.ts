import { describe, expect, it } from "vitest";
import { getPoolState, getPosition } from "../../src/modules/uniswap/reader";
import { UniswapPositionManager, UniswapV3Pool } from "../../src/modules/uniswap/types";

describe("uniswap reader", () => {
  it("returns pool state", async () => {
    const pool: UniswapV3Pool = {
      slot0: async () => [123n, 42, 1, 2, 3, 4, true],
      liquidity: async () => 999n,
    };

    const state = await getPoolState(pool);
    expect(state.sqrtPriceX96).toBe(123n);
    expect(state.tick).toBe(42);
    expect(state.liquidity).toBe(999n);
  });

  it("returns position data", async () => {
    const manager: UniswapPositionManager = {
      positions: async () => [
        1n,
        "0xOperator",
        "0xToken0",
        "0xToken1",
        500,
        -10,
        10,
        1000n,
        2n,
        3n,
        4n,
        5n,
      ],
      mint: async () => ({ wait: async () => {} }),
      increaseLiquidity: async () => ({ wait: async () => {} }),
      decreaseLiquidity: async () => ({ wait: async () => {} }),
      collect: async () => ({ wait: async () => {} }),
    };

    const position = await getPosition(manager, 1n);
    expect(position.token0).toBe("0xToken0");
    expect(position.fee).toBe(500);
    expect(position.liquidity).toBe(1000n);
  });
});
