import { describe, it, expect, vi, beforeEach } from "vitest";
import { RebalanceManager } from "../../src/strategy/rebalance";
import * as gmxOrders from "../../src/modules/gmx/orders";
import { ethers } from "ethers";
import { RebalanceData } from "../../src/strategy/types";
import { DEFAULT_STRATEGY_CONFIG } from "../../src/config/strategy";

// Mock gmx orders
vi.mock("../../src/modules/gmx/orders");

describe("RebalanceManager", () => {
  let manager: RebalanceManager;
  const mockRouter = {} as gmxOrders.GMXRouter;
  const mockToken = {} as gmxOrders.IERC20;
  
  const config = {
    ...DEFAULT_STRATEGY_CONFIG,
    defaultExecutionFee: 100000000000000n, // 0.0001 ETH
  };
  
  const context = {
    account: "0xAccount",
    market: "0xMarket",
    collateralTokenAddress: "0xCollat",
    orderVault: "0xVault",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    manager = new RebalanceManager(mockRouter, mockToken, config, context);
    
    // Default mocks
    vi.mocked(gmxOrders.createIncreaseOrder).mockResolvedValue({
      orderParams: [] as any, multicallData: [], txHash: "0xHashIncrease"
    });
    vi.mocked(gmxOrders.createDecreaseOrder).mockResolvedValue({
      orderParams: [] as any, multicallData: [], txHash: "0xHashDecrease"
    });
  });

  it("increases short when adjustment is positive", async () => {
    const data: RebalanceData = {
      targetDelta: 0n,
      currentHedge: 0n,
      adjustmentNeeded: 0n,
      targetSizeUsd: 0n,
      adjustmentNeededUsd: ethers.parseUnits("100", 30), // $100 adjustment (Increase short)
    };
    
    const collateralPrice = 1.0; // $1.0
    const collateralDecimals = 6;
    const indexPrice = ethers.parseUnits("3000", 30); // $3000

    const txHash = await manager.executeRebalance(data, collateralPrice, collateralDecimals, indexPrice);
    
    expect(txHash).toBe("0xHashIncrease");
    
    expect(gmxOrders.createIncreaseOrder).toHaveBeenCalledWith(
      mockRouter,
      mockToken,
      expect.objectContaining({
        sizeDeltaUsd: data.adjustmentNeededUsd,
        // Collateral: Size / Leverage = 100 / 3 = 33.333... USD
        // Price = 1.0. Decimals = 6.
        // Amount = 33.333 * 1e6 = 33333333
        // We can check rough range
      }),
      expect.anything()
    );
    
    const callArgs = vi.mocked(gmxOrders.createIncreaseOrder).mock.calls[0][2];
    expect(callArgs.collateralAmount).toBeGreaterThan(33300000n);
    expect(callArgs.collateralAmount).toBeLessThan(33400000n);
    
    // Acceptable Price (Sell): Lower bound. Price * 0.995
    // 3000 * 0.995 = 2985
    expect(callArgs.acceptablePrice).toBe(ethers.parseUnits("2985", 12));
  });

  it("decreases short when adjustment is negative", async () => {
    const data: RebalanceData = {
      targetDelta: 0n,
      currentHedge: 0n,
      adjustmentNeeded: 0n,
      targetSizeUsd: 0n,
      adjustmentNeededUsd: ethers.parseUnits("-50", 30), // -$50 adjustment (Decrease short)
    };
    
    const collateralPrice = 1.0;
    const collateralDecimals = 6;
    const indexPrice = ethers.parseUnits("3000", 30); 

    const txHash = await manager.executeRebalance(data, collateralPrice, collateralDecimals, indexPrice);
    
    expect(txHash).toBe("0xHashDecrease");
    
    expect(gmxOrders.createDecreaseOrder).toHaveBeenCalledWith(
      mockRouter,
      expect.objectContaining({
        sizeDeltaUsd: ethers.parseUnits("50", 30), // Absolute value
      }),
      expect.anything()
    );
    
    const callArgs = vi.mocked(gmxOrders.createDecreaseOrder).mock.calls[0][1];
    // Acceptable Price (Buy): Upper bound. Price * 1.005
    // 3000 * 1.005 = 3015
    expect(callArgs.acceptablePrice).toBe(ethers.parseUnits("3015", 12));
  });

  it("does nothing when adjustment is zero", async () => {
    const data: RebalanceData = {
      targetDelta: 0n,
      currentHedge: 0n,
      adjustmentNeeded: 0n,
      targetSizeUsd: 0n,
      adjustmentNeededUsd: 0n,
    };
    
    const txHash = await manager.executeRebalance(data, 1.0, 6, 0n);
    
    expect(txHash).toBe("");
    expect(gmxOrders.createIncreaseOrder).not.toHaveBeenCalled();
    expect(gmxOrders.createDecreaseOrder).not.toHaveBeenCalled();
  });
});
