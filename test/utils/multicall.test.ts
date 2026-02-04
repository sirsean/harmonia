import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();

  const MockContract = vi.fn();

  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: MockContract,
    },
    Contract: MockContract,
  };
});

import { multicallRead, MulticallRequest } from "../../src/utils/multicall";

const ERC20_IFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

const POOL_IFACE = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);

describe("multicallRead", () => {
  let mockAggregate3: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();

    mockAggregate3 = vi.fn();

    (ethers.Contract as any).mockImplementation(() => ({
      aggregate3: mockAggregate3,
    }));
  });

  it("returns empty array for empty requests", async () => {
    const result = await multicallRead({} as ethers.Provider, "0xMulticall", []);
    expect(result).toEqual([]);
    expect(ethers.Contract).not.toHaveBeenCalled();
  });

  it("encodes calls and decodes results correctly", async () => {
    const decimalsEncoded = ERC20_IFACE.encodeFunctionResult("decimals", [18]);
    const symbolEncoded = ERC20_IFACE.encodeFunctionResult("symbol", ["WETH"]);

    mockAggregate3.mockResolvedValue([
      { success: true, returnData: decimalsEncoded },
      { success: true, returnData: symbolEncoded },
    ]);

    const requests: MulticallRequest[] = [
      {
        target: "0xToken",
        iface: ERC20_IFACE,
        functionName: "decimals",
        args: [],
      },
      {
        target: "0xToken",
        iface: ERC20_IFACE,
        functionName: "symbol",
        args: [],
      },
    ];

    const results = await multicallRead({} as ethers.Provider, "0xMulticall", requests);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[0].data[0]).toBe(18n);
    expect(results[1].success).toBe(true);
    expect(results[1].data[0]).toBe("WETH");

    // Verify the aggregate3 call was made with encoded calldata
    expect(mockAggregate3).toHaveBeenCalledTimes(1);
    const calls = mockAggregate3.mock.calls[0][0];
    expect(calls).toHaveLength(2);
    expect(calls[0].target).toBe("0xToken");
    expect(calls[0].allowFailure).toBe(false);
    expect(calls[1].target).toBe("0xToken");
  });

  it("passes function arguments correctly", async () => {
    const ownerAddr = "0x" + "a".repeat(40);
    const balanceEncoded = ERC20_IFACE.encodeFunctionResult("balanceOf", [1000000n]);

    mockAggregate3.mockResolvedValue([{ success: true, returnData: balanceEncoded }]);

    const requests: MulticallRequest[] = [
      {
        target: "0xToken",
        iface: ERC20_IFACE,
        functionName: "balanceOf",
        args: [ownerAddr],
      },
    ];

    const results = await multicallRead({} as ethers.Provider, "0xMulticall", requests);

    expect(results[0].data[0]).toBe(1000000n);

    // Verify the calldata includes the address argument
    const calls = mockAggregate3.mock.calls[0][0];
    const expectedCalldata = ERC20_IFACE.encodeFunctionData("balanceOf", [ownerAddr]);
    expect(calls[0].callData).toBe(expectedCalldata);
  });

  it("handles mixed interfaces in a single batch", async () => {
    const decimalsEncoded = ERC20_IFACE.encodeFunctionResult("decimals", [6]);
    const liquidityEncoded = POOL_IFACE.encodeFunctionResult("liquidity", [500000n]);

    mockAggregate3.mockResolvedValue([
      { success: true, returnData: decimalsEncoded },
      { success: true, returnData: liquidityEncoded },
    ]);

    const requests: MulticallRequest[] = [
      {
        target: "0xUSDC",
        iface: ERC20_IFACE,
        functionName: "decimals",
        args: [],
      },
      {
        target: "0xPool",
        iface: POOL_IFACE,
        functionName: "liquidity",
        args: [],
      },
    ];

    const results = await multicallRead({} as ethers.Provider, "0xMulticall", requests);

    expect(results[0].data[0]).toBe(6n);
    expect(results[1].data[0]).toBe(500000n);
  });

  it("throws when a required call fails", async () => {
    mockAggregate3.mockResolvedValue([
      { success: false, returnData: "0x" },
    ]);

    const requests: MulticallRequest[] = [
      {
        target: "0xToken",
        iface: ERC20_IFACE,
        functionName: "decimals",
        args: [],
        allowFailure: false,
      },
    ];

    await expect(
      multicallRead({} as ethers.Provider, "0xMulticall", requests),
    ).rejects.toThrow("Multicall: call 0 to 0xToken.decimals failed");
  });

  it("returns failure result when allowFailure is true", async () => {
    const symbolEncoded = ERC20_IFACE.encodeFunctionResult("symbol", ["ETH"]);

    mockAggregate3.mockResolvedValue([
      { success: false, returnData: "0x" },
      { success: true, returnData: symbolEncoded },
    ]);

    const requests: MulticallRequest[] = [
      {
        target: "0xBadToken",
        iface: ERC20_IFACE,
        functionName: "decimals",
        args: [],
        allowFailure: true,
      },
      {
        target: "0xGoodToken",
        iface: ERC20_IFACE,
        functionName: "symbol",
        args: [],
      },
    ];

    const results = await multicallRead({} as ethers.Provider, "0xMulticall", requests);

    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
    expect(results[1].data[0]).toBe("ETH");
  });

  it("defaults allowFailure to false", async () => {
    mockAggregate3.mockResolvedValue([
      { success: false, returnData: "0x" },
    ]);

    const requests: MulticallRequest[] = [
      {
        target: "0xToken",
        iface: ERC20_IFACE,
        functionName: "decimals",
        args: [],
        // no allowFailure specified — should default to false
      },
    ];

    await expect(
      multicallRead({} as ethers.Provider, "0xMulticall", requests),
    ).rejects.toThrow("Multicall: call 0");
  });

  it("creates Multicall3 contract with correct address and ABI", async () => {
    const decimalsEncoded = ERC20_IFACE.encodeFunctionResult("decimals", [18]);
    mockAggregate3.mockResolvedValue([{ success: true, returnData: decimalsEncoded }]);

    const mockProvider = {} as ethers.Provider;

    await multicallRead(mockProvider, "0xCA11bde05977b3631167028862bE2a173976CA11", [
      {
        target: "0xToken",
        iface: ERC20_IFACE,
        functionName: "decimals",
        args: [],
      },
    ]);

    expect(ethers.Contract).toHaveBeenCalledWith(
      "0xCA11bde05977b3631167028862bE2a173976CA11",
      expect.any(Array),
      mockProvider,
    );
  });

  it("decodes multi-value return types correctly", async () => {
    // slot0 returns multiple values
    const slot0Encoded = POOL_IFACE.encodeFunctionResult("slot0", [
      79228162514264337593543950336n, // sqrtPriceX96
      69080,                          // tick
      100,                            // observationIndex
      500,                            // observationCardinality
      500,                            // observationCardinalityNext
      0,                              // feeProtocol
      true,                           // unlocked
    ]);

    mockAggregate3.mockResolvedValue([{ success: true, returnData: slot0Encoded }]);

    const results = await multicallRead({} as ethers.Provider, "0xMulticall", [
      {
        target: "0xPool",
        iface: POOL_IFACE,
        functionName: "slot0",
        args: [],
      },
    ]);

    expect(results[0].success).toBe(true);
    expect(results[0].data[0]).toBe(79228162514264337593543950336n);
    expect(results[0].data[1]).toBe(69080n);
  });
});
