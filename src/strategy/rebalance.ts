import { ethers } from "ethers";
import * as gmxOrders from "../modules/gmx/orders";
import { price30ToPrice12 } from "../modules/gmx/prices";
import { RebalanceData } from "./types";
import { GMXOrderExecutionConfig, GMXOrderType } from "../modules/gmx/types";

export interface RebalanceConfig {
  targetLeverage: number; // e.g. 3.0
  slippageBuffer: number; // e.g. 0.005 for 0.5%
  executionFee: bigint;
}

export class RebalanceManager {
  constructor(
    private router: gmxOrders.GMXRouter,
    private collateralToken: gmxOrders.IERC20,
    private config: RebalanceConfig,
    private context: {
      account: string;
      market: string;
      collateralTokenAddress: string;
      orderVault: string;
    }
  ) {}

  async executeRebalance(
    data: RebalanceData,
    collateralPrice: number, // USD per Collateral Token (e.g. 1.0 for USDC)
    collateralDecimals: number,
    indexTokenPrice: bigint // 30 decimals
  ): Promise<string> {
    const adjustmentUsd = data.adjustmentNeededUsd;
    if (adjustmentUsd === 0n) {
      console.log("No adjustment needed.");
      return "";
    }

    if (adjustmentUsd > 0n) {
      return this.increaseShort(
        adjustmentUsd,
        collateralPrice,
        collateralDecimals,
        indexTokenPrice
      );
    } else {
      return this.decreaseShort(
        adjustmentUsd * -1n,
        collateralPrice,
        collateralDecimals,
        indexTokenPrice
      );
    }
  }

  public calculateRequiredCollateral(
    sizeDeltaUsd: bigint,
    collateralPrice: number,
    collateralDecimals: number
  ): { amount: bigint; usd: bigint } {
    const leverageScaled = BigInt(Math.floor(this.config.targetLeverage * 10000));
    const collateralDeltaUsd = (sizeDeltaUsd * 10000n) / leverageScaled;

    const priceScaled = BigInt(Math.floor(collateralPrice * 1e8));
    const numerator = collateralDeltaUsd * 10n ** BigInt(collateralDecimals);
    const denominator = priceScaled * 10n ** 22n;
    const collateralAmount = numerator / denominator;

    return { amount: collateralAmount, usd: collateralDeltaUsd };
  }

  private async increaseShort(
    sizeDeltaUsd: bigint,
    collateralPrice: number,
    collateralDecimals: number,
    indexTokenPrice: bigint
  ): Promise<string> {
    console.log(`Increasing short by $${ethers.formatUnits(sizeDeltaUsd, 30)}`);

    const { amount: collateralAmount, usd: collateralDeltaUsd } = this.calculateRequiredCollateral(
      sizeDeltaUsd,
      collateralPrice,
      collateralDecimals
    );

    console.log(
      `Adding collateral: ${ethers.formatUnits(collateralAmount, collateralDecimals)} (${ethers.formatUnits(collateralDeltaUsd, 30)} USD)`
    );

    const executionConfig: GMXOrderExecutionConfig = {
      orderVault: this.context.orderVault,
    };

    // Acceptable Price: Lower bound for selling (Short Increase)
    // indexTokenPrice * (1 - slippage)
    const slippageFactor = BigInt(Math.round((1 - this.config.slippageBuffer) * 10000));
    const acceptablePrice30 = (indexTokenPrice * slippageFactor) / 10000n;
    const acceptablePrice = price30ToPrice12(acceptablePrice30);

    const result = await gmxOrders.createIncreaseOrder(
      this.router,
      this.collateralToken,
      {
        account: this.context.account,
        market: this.context.market,
        collateralToken: this.context.collateralTokenAddress,
        sizeDeltaUsd,
        collateralAmount,
        acceptablePrice,
        executionFee: this.config.executionFee,
        isLong: false,
      },
      executionConfig
    );

    return result.txHash;
  }

  private async decreaseShort(
    sizeDeltaUsd: bigint,
    collateralPrice: number,
    collateralDecimals: number,
    indexTokenPrice: bigint
  ): Promise<string> {
    console.log(`Decreasing short by $${ethers.formatUnits(sizeDeltaUsd, 30)}`);

    const executionConfig: GMXOrderExecutionConfig = {
      orderVault: this.context.orderVault,
    };

    // Acceptable Price: Upper bound for buying (Short Decrease)
    // indexTokenPrice * (1 + slippage)
    const slippageFactor = BigInt(Math.round((1 + this.config.slippageBuffer) * 10000));
    const acceptablePrice30 = (indexTokenPrice * slippageFactor) / 10000n;
    const acceptablePrice = price30ToPrice12(acceptablePrice30);

    const result = await gmxOrders.createDecreaseOrder(
      this.router,
      {
        account: this.context.account,
        market: this.context.market,
        collateralToken: this.context.collateralTokenAddress,
        sizeDeltaUsd,
        acceptablePrice,
        executionFee: this.config.executionFee,
        isLong: false,
      },
      executionConfig
    );

    return result.txHash;
  }
}
