import { describe, expect, it, vi } from "vitest";
import {
  buildDecreaseOrderParams,
  buildIncreaseOrderParams,
  buildMulticallData,
  createDecreaseOrder,
  createIncreaseOrder,
  ensureAllowance,
} from "../../src/modules/gmx/orders";
import { GMXOrderType, GMXRouter, IERC20 } from "../../src/modules/gmx/types";

const baseRequest = {
  account: "0xAccount",
  market: "0xMarket",
  collateralToken: "0xCollateral",
  sizeDeltaUsd: 100n,
  collateralAmount: 10n,
  acceptablePrice: 200n,
  executionFee: 5n,
};

describe("gmx orders", () => {
  it("builds increase order params with defaults", () => {
    const params = buildIncreaseOrderParams(baseRequest);
    expect(params[0].receiver).toBe("0xAccount");
    expect(params[1].sizeDeltaUsd).toBe(100n);
    expect(params[2]).toBe(GMXOrderType.MarketIncrease);
    expect(params[4]).toBe(false);
  });

  it("builds decrease order params with defaults", () => {
    const params = buildDecreaseOrderParams({
      account: "0xAccount",
      market: "0xMarket",
      collateralToken: "0xCollateral",
      sizeDeltaUsd: 50n,
      acceptablePrice: 123n,
      executionFee: 7n,
    });

    expect(params[1].initialCollateralDeltaAmount).toBe(0n);
    expect(params[2]).toBe(GMXOrderType.MarketDecrease);
  });

  it("builds multicall data with collateral transfer", () => {
    const params = buildIncreaseOrderParams(baseRequest);
    const routerInterface = {
      encodeFunctionData: (name: string) => name,
    };

    const data = buildMulticallData(routerInterface, {
      orderVault: "0xVault",
      orderParams: params,
      collateralToken: "0xCollateral",
      collateralAmount: 10n,
      executionFee: 5n,
    });

    expect(data).toEqual(["sendWnt", "sendTokens", "createOrder"]);
  });

  it("ensures allowance only when required", async () => {
    const token: IERC20 = {
      allowance: vi.fn().mockResolvedValue(100n),
      approve: vi.fn().mockResolvedValue({ wait: vi.fn() }),
    };

    const didApprove = await ensureAllowance(token, "0xOwner", "0xSpender", 50n);
    expect(didApprove).toBe(false);
    expect(token.approve).not.toHaveBeenCalled();
  });

  it("creates increase order and runs staticCall", async () => {
    const multicall = vi.fn().mockResolvedValue({ hash: "0xabc", wait: vi.fn() });
    (multicall as unknown as { staticCall?: () => void }).staticCall = vi
      .fn()
      .mockResolvedValue([]);

    const router: GMXRouter = {
      interface: {
        encodeFunctionData: (name: string) => name,
      },
      multicall,
    };

    const token: IERC20 = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue({ wait: vi.fn() }),
    };

    const result = await createIncreaseOrder(
      router,
      token,
      baseRequest,
      {
        orderVault: "0xVault",
        routerAddress: "0xRouter",
        performStaticCall: true,
      }
    );

    expect(result.txHash).toBe("0xabc");
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("creates decrease order without collateral transfer", async () => {
    const multicall = vi.fn().mockResolvedValue({ hash: "0xdef", wait: vi.fn() });
    (multicall as unknown as { staticCall?: () => void }).staticCall = vi
      .fn()
      .mockResolvedValue([]);

    const router: GMXRouter = {
      interface: {
        encodeFunctionData: (name: string) => name,
      },
      multicall,
    };

    const result = await createDecreaseOrder(
      router,
      {
        account: "0xAccount",
        market: "0xMarket",
        collateralToken: "0xCollateral",
        sizeDeltaUsd: 50n,
        acceptablePrice: 123n,
        executionFee: 7n,
      },
      {
        orderVault: "0xVault",
        performStaticCall: true,
      }
    );

    expect(result.multicallData).toEqual(["sendWnt", "createOrder"]);
    expect(result.txHash).toBe("0xdef");
  });
});
