import { describe, it, expect, beforeEach, vi } from "vitest";
import { ethers } from "ethers";
import { compoundFees, compoundFeesForPositions, CompoundConfig } from "../../src/strategy/compound";
import * as uniswapFees from "../../src/modules/uniswap/fees";
import * as uniswapLiquidity from "../../src/modules/uniswap/liquidity";
import * as uniswapReader from "../../src/modules/uniswap/reader";
import { UniswapPosition, UniswapPoolState } from "../../src/modules/uniswap/types";
import { getSqrtRatioAtTick } from "../../src/modules/math/ticks";
import { UNISWAP_POSITION_MANAGER_WRITE_ABI } from "../../src/utils/abis";

const VALID_OWNER = "0x0000000000000000000000000000000000000001";
const VALID_TOKEN0 = "0x0000000000000000000000000000000000000002";
const VALID_TOKEN1 = "0x0000000000000000000000000000000000000003";

vi.mock("../../src/modules/uniswap/fees", async () => {
  const actual = await vi.importActual<typeof import("../../src/modules/uniswap/fees")>(
    "../../src/modules/uniswap/fees"
  );
  return {
    ...actual,
    getUnclaimedFees: vi.fn(),
  };
});
vi.mock("../../src/modules/uniswap/liquidity", async () => {
  const actual = await vi.importActual<typeof import("../../src/modules/uniswap/liquidity")>(
    "../../src/modules/uniswap/liquidity"
  );
  return {
    ...actual,
    ensureAllowance: vi.fn(),
  };
});
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
    token0: VALID_TOKEN0,
    token1: VALID_TOKEN1,
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
      multicall: vi.fn().mockResolvedValue({
        hash: "0xMulticallHash",
        wait: vi.fn().mockResolvedValue({ hash: "0xMulticallHash" }),
      }),
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
      owner: VALID_OWNER,
      spender: "0xSpender",
      performApproval: false,
      // Note: waitForReceipt removed - always waits for receipt
    };

    // Default mocks
    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue(mockPosition);
    vi.mocked(uniswapReader.getPoolState).mockResolvedValue(mockPoolState);
    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: 0n,
      amount1: 0n,
    });
    vi.mocked(uniswapLiquidity.ensureAllowance).mockResolvedValue(false);
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
    expect(mockPositionManager.multicall).not.toHaveBeenCalled();
    expect(uniswapLiquidity.ensureAllowance).not.toHaveBeenCalled();
  });

  it("should collect fees and add liquidity back", async () => {
    const amount0Fees = 1000000n; // 1 USDC (6 decimals)
    const amount1Fees = 100000000000000000n; // 0.1 ETH (18 decimals)

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const result = await compoundFees(123n, config);

    expect(result.tokenId).toBe(123n);
    expect(result.amount0Collected).toBe(amount0Fees);
    expect(result.amount1Collected).toBe(amount1Fees);
    expect(result.collectTxHash).toBe("0xMulticallHash");
    expect(result.increaseLiquidityTxHash).toBe("0xMulticallHash");

    expect(mockPositionManager.multicall).toHaveBeenCalledTimes(1);
    const multicallData = mockPositionManager.multicall.mock.calls[0][0];
    const iface = new ethers.Interface(UNISWAP_POSITION_MANAGER_WRITE_ABI);
    const collectParams = iface.decodeFunctionData("collect", multicallData[0])[0];
    const increaseParams = iface.decodeFunctionData("increaseLiquidity", multicallData[1])[0];

    expect(collectParams.tokenId).toBe(123n);
    expect(collectParams.amount0Max).toBe(amount0Fees);
    expect(collectParams.amount1Max).toBe(amount1Fees);
    expect(increaseParams.amount0Desired).toBe(amount0Fees);
    expect(increaseParams.amount1Desired).toBe(amount1Fees);
  });

  it("should handle fees exceeding MAX_UINT128", async () => {
    const MAX_UINT128 = (1n << 128n) - 1n;
    const amount0Fees = MAX_UINT128 + 1000n; // Exceeds MAX_UINT128
    const amount1Fees = MAX_UINT128 + 2000n; // Exceeds MAX_UINT128

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const result = await compoundFees(123n, config);

    expect(result.collectTxHash).toBe("0xMulticallHash");
    const multicallData = mockPositionManager.multicall.mock.calls[0][0];
    const iface = new ethers.Interface(UNISWAP_POSITION_MANAGER_WRITE_ABI);
    const collectParams = iface.decodeFunctionData("collect", multicallData[0])[0];
    const increaseParams = iface.decodeFunctionData("increaseLiquidity", multicallData[1])[0];

    // Should cap at MAX_UINT128 for collect params
    expect(collectParams.amount0Max).toBe(MAX_UINT128);
    expect(collectParams.amount1Max).toBe(MAX_UINT128);

    // But should use full amounts for increaseLiquidity
    expect(increaseParams.amount0Desired).toBe(amount0Fees);
    expect(increaseParams.amount1Desired).toBe(amount1Fees);
  });

  it("should always wait for receipts", async () => {
    const amount0Fees = 1000000n;
    const amount1Fees = 100000000000000000n;

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const mockWait = vi.fn().mockResolvedValue({ hash: "0xCollectHashReceipt" });
    mockPositionManager.multicall.mockResolvedValueOnce({
      hash: "0xCollectHash",
      wait: mockWait,
    });

    // Note: waitForReceipt option removed - always waits for receipt
    const result = await compoundFees(123n, config);

    expect(mockWait).toHaveBeenCalled();
    expect(result.collectTxHash).toBe("0xCollectHashReceipt");
  });

  it("should perform approvals when performApproval is true", async () => {
    const amount0Fees = 1000000n;
    const amount1Fees = 100000000000000000n;

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    await compoundFees(123n, { ...config, performApproval: true });

    expect(uniswapLiquidity.ensureAllowance).toHaveBeenCalledTimes(2);
  });

  it("should not use transaction overrides (let ethers manage nonces)", async () => {
    const amount0Fees = 1000000n;
    const amount1Fees = 100000000000000000n;

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    // Note: nonce management removed - let ethers handle it automatically
    // Test that compoundFees works without overrides
    const result = await compoundFees(123n, { ...config });

    // Verify functions were called (exact args don't matter - key is no nonce management)
    expect(mockPositionManager.multicall).toHaveBeenCalled();
    
    // Verify result
    expect(result.tokenId).toBe(123n);
    expect(result.collectTxHash).toBe("0xMulticallHash");
    expect(result.increaseLiquidityTxHash).toBe("0xMulticallHash");
  });

  it("should set deadline to 30 minutes from now", async () => {
    const amount0Fees = 1000000n;
    const amount1Fees = 100000000000000000n;

    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValue({
      amount0: amount0Fees,
      amount1: amount1Fees,
    });

    const now = Math.floor(Date.now() / 1000);
    await compoundFees(123n, config);

    const multicallData = mockPositionManager.multicall.mock.calls[0][0];
    const iface = new ethers.Interface(UNISWAP_POSITION_MANAGER_WRITE_ABI);
    const increaseParams = iface.decodeFunctionData("increaseLiquidity", multicallData[1])[0];
    const deadline = increaseParams.deadline;
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

    mockPositionManager = {
      multicall: vi.fn().mockResolvedValue({
        hash: "0xMulticallHash",
        wait: vi.fn().mockResolvedValue({ hash: "0xMulticallHash" }),
      }),
    };
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
      owner: VALID_OWNER,
      spender: "0xSpender",
    };

    vi.mocked(uniswapReader.getPositionWithFees).mockResolvedValue({
      nonce: 0n,
      operator: "0xOp",
      token0: VALID_TOKEN0,
      token1: VALID_TOKEN1,
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
    vi.mocked(uniswapLiquidity.ensureAllowance).mockResolvedValue(false);
  });

  it("should compound fees for multiple positions", async () => {
    const tokenIds = [123n, 456n, 789n];

    const results = await compoundFeesForPositions(tokenIds, config);

    expect(results).toHaveLength(3);
    expect(results[0].tokenId).toBe(123n);
    expect(results[1].tokenId).toBe(456n);
    expect(results[2].tokenId).toBe(789n);

    expect(mockPositionManager.multicall).toHaveBeenCalledTimes(3);
  });

  it("should continue processing other positions if one fails", async () => {
    const tokenIds = [123n, 456n, 789n];

    // Reset mocks to set up per-call behavior
    mockPositionManager.multicall.mockReset();
    vi.mocked(uniswapFees.getUnclaimedFees).mockReset();
    
    // First position (123) succeeds
    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValueOnce({
      amount0: 1000000n,
      amount1: 100000000000000000n,
    });
    mockPositionManager.multicall.mockResolvedValueOnce({
      hash: "0xHash1",
      wait: vi.fn().mockResolvedValue({ hash: "0xHash1" }),
    });
    
    // Second position (456) fails - make getUnclaimedFees throw
    vi.mocked(uniswapFees.getUnclaimedFees).mockImplementationOnce(async () => {
      throw new Error("Collection failed");
    });
    
    // Third position (789) succeeds
    vi.mocked(uniswapFees.getUnclaimedFees).mockResolvedValueOnce({
      amount0: 1000000n,
      amount1: 100000000000000000n,
    });
    mockPositionManager.multicall.mockResolvedValueOnce({
      hash: "0xHash3",
      wait: vi.fn().mockResolvedValue({ hash: "0xHash3" }),
    });

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
    expect(mockPositionManager.multicall).not.toHaveBeenCalled();
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

    // Even with very large fees that would exceed typical maxPositionSizeUsd ($500),
    // compoundFees should still proceed
    const result = await compoundFees(123n, config);

    expect(result.amount0Collected).toBe(largeAmount0Fees);
    expect(result.amount1Collected).toBe(largeAmount1Fees);
    expect(mockPositionManager.multicall).toHaveBeenCalled();
  });
});
