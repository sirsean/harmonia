import { describe, it, expect, vi } from "vitest";
import { ethers } from "hardhat";
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
      withdraw: vi.fn(),
    };
    const swapRouter = { exactInputSingle: vi.fn() };
    const quoter = { quoteExactInputSingle: { staticCall: vi.fn() } };
    const provider = {
      getBalance: vi.fn().mockResolvedValue(ethers.parseEther("1.0")),
    };

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
      provider,
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
      withdraw: vi.fn(),
    };
    const swapRouter = {
      exactInputSingle: vi.fn().mockResolvedValue({ hash: "0xswap", wait: swapWait }),
    };
    const quoter = {
      quoteExactInputSingle: {
        staticCall: vi.fn().mockResolvedValue(1000n),
      },
    };
    const receipts: Array<{ gasUsed: bigint; gasPrice: bigint }> = [];
    const refreshNonce = vi.fn().mockResolvedValue(undefined);
    const provider = {
      getBalance: vi.fn().mockResolvedValue(ethers.parseEther("1.0")),
    };

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
      provider,
      transactionReceipts: receipts,
    });

    expect(result).not.toBeNull();
    expect(result?.amountIn).toBe(1000n);
    expect(result?.amountOutMin).toBe(995n);
    expect(result?.unwrappedForEth).toBe(0n);
    expect(wethContract.approve).toHaveBeenCalledWith(
      ARBITRUM_MAINNET.uniswapV3SwapRouter,
      (1n << 256n) - 1n
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
      withdraw: vi.fn(),
    };
    const swapRouter = {
      exactInputSingle: vi.fn().mockResolvedValue({ hash: "0xswap", wait: swapWait }),
    };
    const quoter = {
      quoteExactInputSingle: {
        staticCall: vi.fn().mockResolvedValue(1000n),
      },
    };
    const receipts: Array<{ gasUsed: bigint; gasPrice: bigint }> = [];
    const refreshNonce = vi.fn().mockResolvedValue(undefined);
    const provider = {
      getBalance: vi.fn().mockResolvedValue(ethers.parseEther("1.0")),
    };

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
      provider,
      transactionReceipts: receipts,
    });

    expect(result).not.toBeNull();
    expect(wethContract.approve).not.toHaveBeenCalled();
    expect(swapRouter.exactInputSingle).toHaveBeenCalledTimes(1);
    expect(refreshNonce).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveLength(1);
  });

  it("unwraps WETH to top up ETH reserve before swapping remaining WETH", async () => {
    const withdrawWait = vi.fn().mockResolvedValue({ gasUsed: 5n, gasPrice: 6n });
    const swapWait = vi.fn().mockResolvedValue({ gasUsed: 3n, gasPrice: 4n });

    const wethContract = {
      // First call: initial WETH balance, second call: balance after unwrap
      balanceOf: vi.fn().mockResolvedValueOnce(1000n).mockResolvedValueOnce(900n),
      allowance: vi.fn().mockResolvedValue(2000n),
      approve: vi.fn(),
      withdraw: vi.fn().mockResolvedValue({ hash: "0xunwrap", wait: withdrawWait }),
    };
    const swapRouter = {
      exactInputSingle: vi.fn().mockResolvedValue({ hash: "0xswap", wait: swapWait }),
    };
    const quoter = {
      quoteExactInputSingle: {
        staticCall: vi.fn().mockResolvedValue(900n),
      },
    };
    const receipts: Array<{ gasUsed: bigint; gasPrice: bigint }> = [];
    const refreshNonce = vi.fn().mockResolvedValue(undefined);
    const provider = {
      getBalance: vi.fn().mockResolvedValue(ethers.parseEther("0.0")),
    };

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
      minEthReserveWei: 100n,
      refreshNonce,
      provider,
      transactionReceipts: receipts,
    });

    expect(result).not.toBeNull();
    expect(result?.unwrappedForEth).toBe(100n);
    expect(result?.amountIn).toBe(900n);
    expect(wethContract.withdraw).toHaveBeenCalledWith(100n);
    expect(quoter.quoteExactInputSingle.staticCall).toHaveBeenCalledWith(
      "0xweth",
      "0xusdc",
      500,
      900n,
      0
    );
    expect(swapRouter.exactInputSingle).toHaveBeenCalledTimes(1);
    expect(refreshNonce).toHaveBeenCalledTimes(2);
    expect(receipts).toHaveLength(2);
  });
});
