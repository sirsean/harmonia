import { describe, expect, it, vi } from "vitest";
import {
  buildIncreaseLiquidityParams,
  buildMintParams,
  ensureAllowance,
  increaseLiquidity,
  mintPosition,
} from "../../src/modules/uniswap/liquidity";
import { IERC20, UniswapPositionManager } from "../../src/modules/uniswap/types";

describe("uniswap liquidity", () => {
  it("builds mint params", () => {
    const params = buildMintParams({
      token0: "0x0",
      token1: "0x1",
      fee: 500,
      tickLower: -60,
      tickUpper: 60,
      amount0Desired: 1n,
      amount1Desired: 2n,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: "0xRecipient",
      deadline: 123n,
    });
    expect(params.token0).toBe("0x0");
  });

  it("builds increase params", () => {
    const params = buildIncreaseLiquidityParams({
      tokenId: 1n,
      amount0Desired: 1n,
      amount1Desired: 1n,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: 100n,
    });
    expect(params.tokenId).toBe(1n);
  });

  it("ensures allowance", async () => {
    const token: IERC20 = {
      allowance: vi.fn().mockResolvedValue(5n),
      approve: vi.fn().mockResolvedValue({ wait: vi.fn() }),
    };

    const didApprove = await ensureAllowance(token, "0xOwner", "0xSpender", 10n);
    expect(didApprove).toBe(true);
    expect(token.approve).toHaveBeenCalled();
  });

  it("mints position with approvals", async () => {
    const manager: UniswapPositionManager = {
      positions: vi.fn(),
      balanceOf: vi.fn(),
      tokenOfOwnerByIndex: vi.fn(),
      mint: vi.fn().mockResolvedValue({ hash: "0x1", wait: vi.fn() }),
      increaseLiquidity: vi.fn().mockResolvedValue({ hash: "0x2", wait: vi.fn() }),
      decreaseLiquidity: vi.fn().mockResolvedValue({ hash: "0x3", wait: vi.fn() }),
      collect: vi.fn().mockResolvedValue({ hash: "0x4", wait: vi.fn() }),
    };

    const token: IERC20 = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue({ wait: vi.fn() }),
    };

    await mintPosition(
      manager,
      token,
      token,
      {
        token0: "0x0",
        token1: "0x1",
        fee: 500,
        tickLower: -60,
        tickUpper: 60,
        amount0Desired: 1n,
        amount1Desired: 2n,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: "0xRecipient",
        deadline: 123n,
      },
      { owner: "0xOwner", spender: "0xSpender" }
    );

    expect(manager.mint).toHaveBeenCalled();
    expect(token.approve).toHaveBeenCalledTimes(2);
  });

  it("increases liquidity", async () => {
    const manager: UniswapPositionManager = {
      positions: vi.fn(),
      balanceOf: vi.fn(),
      tokenOfOwnerByIndex: vi.fn(),
      mint: vi.fn().mockResolvedValue({ hash: "0x1", wait: vi.fn() }),
      increaseLiquidity: vi.fn().mockResolvedValue({ hash: "0x2", wait: vi.fn() }),
      decreaseLiquidity: vi.fn().mockResolvedValue({ wait: vi.fn() }),
      collect: vi.fn().mockResolvedValue({ wait: vi.fn() }),
    };

    const token: IERC20 = {
      allowance: vi.fn().mockResolvedValue(100n),
      approve: vi.fn().mockResolvedValue({ wait: vi.fn() }),
    };

    await increaseLiquidity(
      manager,
      token,
      token,
      {
        tokenId: 1n,
        amount0Desired: 1n,
        amount1Desired: 2n,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: 123n,
        owner: "0xOwner",
        spender: "0xSpender",
      },
      { performApproval: true }
    );

    expect(manager.increaseLiquidity).toHaveBeenCalled();
  });
});
