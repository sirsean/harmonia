import { describe, it, expect, beforeEach, vi } from "vitest";
import { ethers } from "ethers";
import { compoundFees, compoundFeesForPositions, CompoundConfig } from "../../src/strategy/compound";
import * as uniswapFees from "../../src/modules/uniswap/fees";
import * as uniswapLiquidity from "../../src/modules/uniswap/liquidity";
import * as uniswapReader from "../../src/modules/uniswap/reader";
import { UniswapPosition, UniswapPoolState } from "../../src/modules/uniswap/types";
import { getSqrtRatioAtTick } from "../../src/modules/math/ticks";

vi.mock("../../src/modules/uniswap/fees");
vi.mock("../../src/modules/uniswap/liquidity");
vi.mock("../../src/modules/uniswap/reader");

describe("compoundFees", () => {
  let mockPositionManager: any;
  let mockPool: any;
  let mockToken0: any;
  let mockToken1: any;
  let config: CompoundConfig;

  const mockPosition: UniswapPosition = {
    nonce: 0n,
    operator: "0xOperator",
    token0: "0xToken0",
    token1: "0xToken1",
    fee: 500,
    tickLower: 69000,
    tickUpper: 69100,
    liquidity: 1000000000000000000n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
  };

  const mockPoolState: UniswapPoolState = {
    sqrtPriceX96: getSqrtRatioAtTick(69050),
    tick: 69050,
    liquidity: 1000000000000000000n,
  };

  beforeEach(() => {
    vi.resetAllMocks();

    mockPositionManager = {
      positions: vi.fn(),
    };

    mockPool = {
      slot0: vi.fn(),
      liquidity: vi.fn(),
    };

    mockToken0 = {
      decimals: vi.fn().mockResolvedValue(6n),
      allowance: vi.fn(),
      approve: vi.fn(),
    };

    mockToken1 = {
      decimals: vi.fn().mockResolvedValue(18n),
      allowance: vi.fn(),
      approve: vi.fn(),
    };

    config = {
      positionManager: mockPositionManager,
      pool: mockPool,
      token0: mockToken0,
      token1: mockToken1,
      owner: "0xOwner",
      spender: "0xSpender",
      performApproval: false,
      waitForReceipt: false,
    };

    // Default mocks
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(mockPosition);
    vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: 0n,
      amount1: 0n,
    });
  });

  it("should return early if no fees to collect", async () => {
    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: 0n,
      amount1: 0n,
    });

    const result = await compoundFees(123n, config);

    expect(result.tokenId).toBe(123n);
    expect(result.amount0Collected).toBe(0n);
    expect(result.amount1Collected).toBe(0n);
    expect(result.amount0Added).toBe(0n);
    expect(result.amount1Added).toBe(0n);
    expect(uniswapFees.collectFees).not.toHaveBeenCalled();
    expect(uniswapLiquidity.increaseLiquidity).not.toHaveBeenCalled();
  });

  it("should collect fees and add liquidity back", async () => {
    const amount0Fees = 1000000n; // 1 USDC (6 decimals)
    const amount1Fees = 100000000000000000n; // 0.1 ETH (18 decimals)

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const mockCollectTx = {
      hash: "0xCollectHash",
      wait: vi.fn().mockResolvedValue({ hash: "0xCollectHash" }),
    };
    vi.mocked(uniswapFees.collectFees).mockResolvedValue(mockCollectTx as any);

    const mockIncreaseLiquidityResult = {
      txHash: "0xIncreaseHash",
      params: {} as any,
    };
    vi.mocked(uniswapLiquidity.increaseLiquidity).mockResolvedValue(
      mockIncreaseLiquidityResult as any
    );

    const result = await compoundFees(123n, config);

    expect(result.tokenId).toBe(123n);
    expect(result.amount0Collected).toBe(amount0Fees);
    expect(result.amount1Collected).toBe(amount1Fees);
    expect(result.collectTxHash).toBe("0xCollectHash");
    expect(result.increaseLiquidityTxHash).toBe("0xIncreaseHash");

    // Verify collect was called with correct parameters (no overrides - let ethers manage nonces)
    expect(uniswapFees.collectFees).toHaveBeenCalledWith(
      mockPositionManager,
      {
        tokenId: 123n,
        recipient: "0xOwner",
        amount0Max: amount0Fees,
        amount1Max: amount1Fees,
      }
    );

    // Verify increaseLiquidity was called with correct parameters
    expect(uniswapLiquidity.increaseLiquidity).toHaveBeenCalledWith(
      mockPositionManager,
      mockToken0,
      mockToken1,
      expect.objectContaining({
        tokenId: 123n,
        amount0Desired: amount0Fees,
        amount1Desired: amount1Fees,
        amount0Min: 0n,
        amount1Min: 0n,
        owner: "0xOwner",
        spender: "0xSpender",
      }),
      expect.objectContaining({
        performApproval: false,
        waitForReceipt: false,
      })
    );
  });

  it("should handle fees exceeding MAX_UINT128", async () => {
    const MAX_UINT128 = (1n << 128n) - 1n;
    const amount0Fees = MAX_UINT128 + 1000n; // Exceeds MAX_UINT128
    const amount1Fees = MAX_UINT128 + 2000n; // Exceeds MAX_UINT128

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const mockCollectTx = {
      hash: "0xCollectHash",
      wait: vi.fn().mockResolvedValue({ hash: "0xCollectHash" }),
    };
    vi.mocked(uniswapFees.collectFees).mockResolvedValue(mockCollectTx as any);

    const mockIncreaseLiquidityResult = {
      txHash: "0xIncreaseHash",
      params: {} as any,
    };
    vi.mocked(uniswapLiquidity.increaseLiquidity).mockResolvedValue(
      mockIncreaseLiquidityResult as any
    );

    const result = await compoundFees(123n, config);

    // Should cap at MAX_UINT128 for collect params (no overrides - let ethers manage nonces)
    expect(uniswapFees.collectFees).toHaveBeenCalledWith(
      mockPositionManager,
      expect.objectContaining({
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      })
    );

    // But should use full amounts for increaseLiquidity
    expect(uniswapLiquidity.increaseLiquidity).toHaveBeenCalledWith(
      mockPositionManager,
      mockToken0,
      mockToken1,
      expect.objectContaining({
        amount0Desired: amount0Fees,
        amount1Desired: amount1Fees,
      }),
      expect.anything()
    );
  });

  it("should wait for receipts when waitForReceipt is true", async () => {
    const amount0Fees = 1000000n;
    const amount1Fees = 100000000000000000n;

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const mockCollectTx = {
      hash: "0xCollectHash",
      wait: vi.fn().mockResolvedValue({ hash: "0xCollectHashReceipt" }),
    };
    vi.mocked(uniswapFees.collectFees).mockResolvedValue(mockCollectTx as any);

    const mockIncreaseLiquidityResult = {
      txHash: "0xIncreaseHash",
      params: {} as any,
    };
    vi.mocked(uniswapLiquidity.increaseLiquidity).mockResolvedValue(
      mockIncreaseLiquidityResult as any
    );

    const result = await compoundFees(123n, { ...config, waitForReceipt: true });

    expect(mockCollectTx.wait).toHaveBeenCalled();
    expect(result.collectTxHash).toBe("0xCollectHashReceipt");
  });

  it("should perform approvals when performApproval is true", async () => {
    const amount0Fees = 1000000n;
    const amount1Fees = 100000000000000000n;

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const mockCollectTx = {
      hash: "0xCollectHash",
      wait: vi.fn().mockResolvedValue({ hash: "0xCollectHash" }),
    };
    vi.mocked(uniswapFees.collectFees).mockResolvedValue(mockCollectTx as any);

    const mockIncreaseLiquidityResult = {
      txHash: "0xIncreaseHash",
      params: {} as any,
    };
    vi.mocked(uniswapLiquidity.increaseLiquidity).mockResolvedValue(
      mockIncreaseLiquidityResult as any
    );

    await compoundFees(123n, { ...config, performApproval: true });

    expect(uniswapLiquidity.increaseLiquidity).toHaveBeenCalledWith(
      mockPositionManager,
      mockToken0,
      mockToken1,
      expect.anything(),
      expect.objectContaining({
        performApproval: true,
      })
    );
  });

  it("should not use transaction overrides (let ethers manage nonces)", async () => {
    const amount0Fees = 1000000n;
    const amount1Fees = 100000000000000000n;

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const mockCollectTx = {
      hash: "0xCollectHash",
      wait: vi.fn().mockResolvedValue({ hash: "0xCollectHash" }),
    };
    vi.mocked(uniswapFees.collectFees).mockResolvedValue(mockCollectTx as any);

    const mockIncreaseLiquidityResult = {
      txHash: "0xIncreaseHash",
      params: {} as any,
    };
    vi.mocked(uniswapLiquidity.increaseLiquidity).mockResolvedValue(
      mockIncreaseLiquidityResult as any
    );

    // Note: nonce management removed - let ethers handle it automatically
    // Test that compoundFees works without overrides
    const result = await compoundFees(123n, { ...config });

    // Verify functions were called (exact args don't matter - key is no nonce management)
    expect(uniswapFees.collectFees).toHaveBeenCalled();
    expect(uniswapLiquidity.increaseLiquidity).toHaveBeenCalled();
    
    // Verify result
    expect(result.tokenId).toBe(123n);
    expect(result.collectTxHash).toBe("0xCollectHash");
    expect(result.increaseLiquidityTxHash).toBe("0xIncreaseHash");
  });

  it("should set deadline to 30 minutes from now", async () => {
    const amount0Fees = 1000000n;
    const amount1Fees = 100000000000000000n;

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const mockCollectTx = {
      hash: "0xCollectHash",
      wait: vi.fn().mockResolvedValue({ hash: "0xCollectHash" }),
    };
    vi.mocked(uniswapFees.collectFees).mockResolvedValue(mockCollectTx as any);

    const mockIncreaseLiquidityResult = {
      txHash: "0xIncreaseHash",
      params: {} as any,
    };
    vi.mocked(uniswapLiquidity.increaseLiquidity).mockResolvedValue(
      mockIncreaseLiquidityResult as any
    );

    const now = Math.floor(Date.now() / 1000);
    await compoundFees(123n, config);

    const increaseCall = vi.mocked(uniswapLiquidity.increaseLiquidity).mock.calls[0];
    // increaseLiquidity signature: (manager, token0, token1, params, config)
    // params is at index 3
    const deadline = increaseCall[3].deadline;
    const expectedDeadline = BigInt(now + 1800); // 30 minutes

    // Allow 5 second tolerance for test execution time
    expect(Number(deadline)).toBeGreaterThanOrEqual(Number(expectedDeadline) - 5);
    expect(Number(deadline)).toBeLessThanOrEqual(Number(expectedDeadline) + 5);
  });
});

describe("compoundFeesForPositions", () => {
  let mockPositionManager: any;
  let mockPool: any;
  let mockToken0: any;
  let mockToken1: any;
  let config: CompoundConfig;

  beforeEach(() => {
    vi.resetAllMocks();

    mockPositionManager = {};
    mockPool = {};
    mockToken0 = {
      decimals: vi.fn().mockResolvedValue(6n),
    };
    mockToken1 = {
      decimals: vi.fn().mockResolvedValue(18n),
    };

    config = {
      positionManager: mockPositionManager,
      pool: mockPool,
      token0: mockToken0,
      token1: mockToken1,
      owner: "0xOwner",
      spender: "0xSpender",
    };

    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue({
      nonce: 0n,
      operator: "0xOp",
      token0: "0xT0",
      token1: "0xT1",
      fee: 500,
      tickLower: 69000,
      tickUpper: 69100,
      liquidity: 1000n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    });

    vi.mocked(uniswapReader.getPoolState).mockResolvedValue({
      sqrtPriceX96: getSqrtRatioAtTick(69050),
      tick: 69050,
      liquidity: 1000n,
    });

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: 1000000n,
      amount1: 100000000000000000n,
    });

    const mockCollectTx = {
      hash: "0xCollectHash",
      wait: vi.fn().mockResolvedValue({ hash: "0xCollectHash" }),
    };
    vi.mocked(uniswapFees.collectFees).mockResolvedValue(mockCollectTx as any);

    const mockIncreaseLiquidityResult = {
      txHash: "0xIncreaseHash",
      params: {} as any,
    };
    vi.mocked(uniswapLiquidity.increaseLiquidity).mockResolvedValue(
      mockIncreaseLiquidityResult as any
    );
  });

  it("should compound fees for multiple positions", async () => {
    const tokenIds = [123n, 456n, 789n];

    const results = await compoundFeesForPositions(tokenIds, config);

    expect(results).toHaveLength(3);
    expect(results[0].tokenId).toBe(123n);
    expect(results[1].tokenId).toBe(456n);
    expect(results[2].tokenId).toBe(789n);

    expect(uniswapFees.collectFees).toHaveBeenCalledTimes(3);
    expect(uniswapLiquidity.increaseLiquidity).toHaveBeenCalledTimes(3);
  });

  it("should continue processing other positions if one fails", async () => {
    const tokenIds = [123n, 456n, 789n];

    // Reset mocks to set up per-call behavior
    vi.mocked(uniswapFees.collectFees).mockReset();
    vi.mocked(uniswapFees.getUnclaimedFees).mockReset();
    
    // First position (123) succeeds
    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValueOnce({
      amount0: 1000000n,
      amount1: 100000000000000000n,
    });
    vi.mocked(uniswapFees.collectFees).mockResolvedValueOnce({
      hash: "0xHash1",
      wait: vi.fn().mockResolvedValue({ hash: "0xHash1" }),
    } as any);
    
    // Second position (456) fails - make getUnclaimedFees throw
    vi.mocked(uniswapFees.getUnclaimedFees).mockImplementationOnce(async () => {
      throw new Error("Collection failed");
    });
    
    // Third position (789) succeeds
    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValueOnce({
      amount0: 1000000n,
      amount1: 100000000000000000n,
    });
    vi.mocked(uniswapFees.collectFees).mockResolvedValueOnce({
      hash: "0xHash3",
      wait: vi.fn().mockResolvedValue({ hash: "0xHash3" }),
    } as any);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await compoundFeesForPositions(tokenIds, config);

    expect(results).toHaveLength(2); // Only successful ones
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to compound fees for token 456"),
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });

  it("should return empty array if no token IDs provided", async () => {
    const results = await compoundFeesForPositions([], config);

    expect(results).toHaveLength(0);
    expect(uniswapFees.collectFees).not.toHaveBeenCalled();
    expect(uniswapLiquidity.increaseLiquidity).not.toHaveBeenCalled();
  });

  it("should not enforce maxPositionSizeUsd - allows position to exceed max", async () => {
    // This test verifies that compoundFees does NOT check maxPositionSizeUsd
    // It should compound fees regardless of current position size
    const largeAmount0Fees = ethers.parseUnits("1000", 6); // $1000 USDC
    const largeAmount1Fees = ethers.parseUnits("10", 18); // 10 ETH

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: largeAmount0Fees,
      amount1: largeAmount1Fees,
    });

    const mockCollectTx = {
      hash: "0xCollectHash",
      wait: vi.fn().mockResolvedValue({ hash: "0xCollectHash" }),
    };
    vi.mocked(uniswapFees.collectFees).mockResolvedValue(mockCollectTx as any);

    const mockIncreaseLiquidityResult = {
      txHash: "0xIncreaseHash",
      params: {} as any,
    };
    vi.mocked(uniswapLiquidity.increaseLiquidity).mockResolvedValue(
      mockIncreaseLiquidityResult as any
    );

    // Even with very large fees that would exceed typical maxPositionSizeUsd ($500),
    // compoundFees should still proceed
    const result = await compoundFees(123n, config);

    expect(result.amount0Collected).toBe(largeAmount0Fees);
    expect(result.amount1Collected).toBe(largeAmount1Fees);
    expect(uniswapFees.collectFees).toHaveBeenCalled();
    expect(uniswapLiquidity.increaseLiquidity).toHaveBeenCalledWith(
      mockPositionManager,
      mockToken0,
      mockToken1,
      expect.objectContaining({
        amount0Desired: largeAmount0Fees,
        amount1Desired: largeAmount1Fees,
      }),
      expect.anything()
    );
  });
});
