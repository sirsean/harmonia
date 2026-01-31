import { describe, it, expect, vi } from "vitest";
import { ARBITRUM_MAINNET } from "../../../../src/config/addresses";

vi.mock("hardhat", async () => {
  const ethersMod = await import("ethers");
  return { ethers: ethersMod };
});

import { sweepIdleWethToUsdc } from "../../../../src/cli/commands/strategy/execute-optimize";

const mockAccount = "0x123";

describe("sweepIdleWethToUsdc", () => {
  it("returns null when WETH balance is below dust threshold", async () => {
    const wethContract = {
      balanceOf: vi.fn().mockResolvedValue(50n),
      allowance: vi.fn(),
      approve: vi.fn(),
    };
    const swapRouter = { exactInputSingle: vi.fn() };
    const quoter = { quoteExactInputSingle: { staticCall: vi.fn() } };

    const result = await sweepIdleWethToUsdc({
      account: mockAccount,
      wethContract,
      swapRouter,
      quoter,
      wethToken: "0xweth",
      usdcToken: "0xusdc",
      fee: 500,
      slippageBps: 50n,
      dustThreshold: 100n,
      refreshNonce: vi.fn().mockResolvedValue(undefined),
      provider: {},
    });

    expect(result).toBeNull();
    expect(quoter.quoteExactInputSingle.staticCall).not.toHaveBeenCalled();
    expect(swapRouter.exactInputSingle).not.toHaveBeenCalled();
  });

  it("approves and swaps when allowance is insufficient", async () => {
    const approvalWait = vi.fn().mockResolvedValue({ gasUsed: 1n, gasPrice: 2n });
    const swapWait = vi.fn().mockResolvedValue({ gasUsed: 3n, gasPrice: 4n });

    const wethContract = {
      balanceOf: vi.fn().mockResolvedValue(1000n),
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue({ wait: approvalWait }),
    };
    const swapRouter = {
      exactInputSingle: vi.fn().mockResolvedValue({ hash: "0xswap", wait: swapWait }),
    };
    const quoter = {
      quoteExactInputSingle: {
        staticCall: vi.fn().mockResolvedValue(1000n),
      },
    };
    const refreshNonce = vi.fn().mockResolvedValue(undefined);
    const receipts: Array<{ gasUsed: bigint; gasPrice: bigint }> = [];

    const result = await sweepIdleWethToUsdc({
      account: mockAccount,
      wethContract,
      swapRouter,
      quoter,
      wethToken: "0xweth",
      usdcToken: "0xusdc",
      fee: 500,
      slippageBps: 50n,
      dustThreshold: 100n,
      refreshNonce,
      provider: {},
      transactionReceipts: receipts,
    });

    expect(result).not.toBeNull();
    expect(result?.amountIn).toBe(1000n);
    expect(result?.amountOutMin).toBe(995n);
    expect(wethContract.approve).toHaveBeenCalledWith(
      ARBITRUM_MAINNET.uniswapV3SwapRouter,
      1000n
    );
    expect(swapRouter.exactInputSingle).toHaveBeenCalledTimes(1);
    expect(refreshNonce).toHaveBeenCalledTimes(2);
    expect(receipts).toHaveLength(2);
  });

  it("skips approval when allowance is sufficient", async () => {
    const swapWait = vi.fn().mockResolvedValue({ gasUsed: 3n, gasPrice: 4n });

    const wethContract = {
      balanceOf: vi.fn().mockResolvedValue(1000n),
      allowance: vi.fn().mockResolvedValue(2000n),
      approve: vi.fn(),
    };
    const swapRouter = {
      exactInputSingle: vi.fn().mockResolvedValue({ hash: "0xswap", wait: swapWait }),
    };
    const quoter = {
      quoteExactInputSingle: {
        staticCall: vi.fn().mockResolvedValue(1000n),
      },
    };
    const refreshNonce = vi.fn().mockResolvedValue(undefined);
    const receipts: Array<{ gasUsed: bigint; gasPrice: bigint }> = [];

    const result = await sweepIdleWethToUsdc({
      account: mockAccount,
      wethContract,
      swapRouter,
      quoter,
      wethToken: "0xweth",
      usdcToken: "0xusdc",
      fee: 500,
      slippageBps: 50n,
      dustThreshold: 100n,
      refreshNonce,
      provider: {},
      transactionReceipts: receipts,
    });

    expect(result).not.toBeNull();
    expect(wethContract.approve).not.toHaveBeenCalled();
    expect(swapRouter.exactInputSingle).toHaveBeenCalledTimes(1);
    expect(refreshNonce).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveLength(1);
  });
});
