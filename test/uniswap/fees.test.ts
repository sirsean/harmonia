import { describe, expect, it, vi } from "vitest";
import { buildCollectParams, buildDecreaseLiquidityParams, collectFees, decreaseLiquidity } from "../../src/modules/uniswap/fees";
import { UniswapPositionManager } from "../../src/modules/uniswap/types";

describe("uniswap fees", () => {
  it("builds decrease params", () => {
    const params = buildDecreaseLiquidityParams({
      tokenId: 1n,
      liquidity: 10n,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: 999n,
    });
    expect(params.liquidity).toBe(10n);
  });

  it("builds collect params", () => {
    const params = buildCollectParams({
      tokenId: 1n,
      recipient: "0xRecipient",
      amount0Max: 1n,
      amount1Max: 2n,
    });
    expect(params.recipient).toBe("0xRecipient");
  });

  it("decreases liquidity", async () => {
    const manager: UniswapPositionManager = {
      positions: vi.fn(),
      balanceOf: vi.fn(),
      tokenOfOwnerByIndex: vi.fn(),
      mint: vi.fn().mockResolvedValue({ hash: "0x1", wait: vi.fn() }),
      increaseLiquidity: vi.fn().mockResolvedValue({ hash: "0x2", wait: vi.fn() }),
      decreaseLiquidity: vi.fn().mockResolvedValue({ hash: "0x3", wait: vi.fn() }),
      collect: vi.fn().mockResolvedValue({ hash: "0x4", wait: vi.fn() }),
    };

    await decreaseLiquidity(manager, {
      tokenId: 1n,
      liquidity: 10n,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: 999n,
    });

    expect(manager.decreaseLiquidity).toHaveBeenCalled();
    expect((manager.decreaseLiquidity as ReturnType<typeof vi.fn>).mock.calls[0].length).toBe(1);
  });

  it("collects fees", async () => {
    const manager: UniswapPositionManager = {
      positions: vi.fn(),
      balanceOf: vi.fn(),
      tokenOfOwnerByIndex: vi.fn(),
      mint: vi.fn().mockResolvedValue({ hash: "0x1", wait: vi.fn() }),
      increaseLiquidity: vi.fn().mockResolvedValue({ hash: "0x2", wait: vi.fn() }),
      decreaseLiquidity: vi.fn().mockResolvedValue({ hash: "0x3", wait: vi.fn() }),
      collect: vi.fn().mockResolvedValue({ hash: "0x4", wait: vi.fn() }),
    };

    await collectFees(manager, {
      tokenId: 1n,
      recipient: "0xRecipient",
      amount0Max: 1n,
      amount1Max: 2n,
    });

    expect(manager.collect).toHaveBeenCalled();
    expect((manager.collect as ReturnType<typeof vi.fn>).mock.calls[0].length).toBe(1);
  });

  it("passes overrides when provided", async () => {
    const manager: UniswapPositionManager = {
      positions: vi.fn(),
      balanceOf: vi.fn(),
      tokenOfOwnerByIndex: vi.fn(),
      mint: vi.fn().mockResolvedValue({ hash: "0x1", wait: vi.fn() }),
      increaseLiquidity: vi.fn().mockResolvedValue({ hash: "0x2", wait: vi.fn() }),
      decreaseLiquidity: vi.fn().mockResolvedValue({ hash: "0x3", wait: vi.fn() }),
      collect: vi.fn().mockResolvedValue({ hash: "0x4", wait: vi.fn() }),
    };

    await decreaseLiquidity(
      manager,
      {
        tokenId: 1n,
        liquidity: 10n,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: 999n,
      },
      { nonce: 5 }
    );

    await collectFees(
      manager,
      {
        tokenId: 1n,
        recipient: "0xRecipient",
        amount0Max: 1n,
        amount1Max: 2n,
      },
      { nonce: 6 }
    );

    expect((manager.decreaseLiquidity as ReturnType<typeof vi.fn>).mock.calls[0].length).toBe(2);
    expect((manager.collect as ReturnType<typeof vi.fn>).mock.calls[0].length).toBe(2);
  });
});
