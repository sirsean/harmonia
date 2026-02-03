import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { loadStrategyConfig } from "../../../config/strategy";
import * as gmxReader from "../../../modules/gmx/reader";
import * as gmxOrders from "../../../modules/gmx/orders";
import { price30ToPrice12 } from "../../../modules/gmx/prices";
import { getSignerAndAccount } from "../base";
import { MonitoringDatabase } from "../../../utils/database";
import { HedgeAdjustmentData } from "../../../strategy/types";
import { ERC20_ABI } from "../../../utils/abis";
import { sendSuccessAlert } from "../../../utils/alerts";
import { GMXRouter, IERC20 } from "../../../modules/gmx/types";

export interface ExecuteHedgeAdjustOptions {
  account?: string;
  hedgeData: HedgeAdjustmentData;
  deltaDriftBefore: number;
  execute?: boolean;
  suppressAlert?: boolean;
  dbPath?: string;
}

export interface ExecuteHedgeAdjustResult {
  txHash: string;
  direction: "increase" | "decrease";
  adjustmentSizeUsd: bigint;
}

/**
 * Execute a lightweight hedge adjustment by modifying only the GMX short position size.
 * This does NOT touch LP positions or collateral - only changes the short size.
 *
 * - Increase short: collateralAmount = 0 (leverage increases)
 * - Decrease short: collateral stays unchanged (leverage decreases)
 */
export async function executeHedgeAdjust(
  options: ExecuteHedgeAdjustOptions
): Promise<ExecuteHedgeAdjustResult> {
  const { signer, account } = await getSignerAndAccount(options.account);
  const config = loadStrategyConfig();
  const { hedgeData, deltaDriftBefore } = options;

  const adjustmentSizeUsd = hedgeData.adjustmentSizeUsd;
  const absAdjustmentUsd = adjustmentSizeUsd < 0n ? -adjustmentSizeUsd : adjustmentSizeUsd;
  const direction: "increase" | "decrease" = adjustmentSizeUsd > 0n ? "increase" : "decrease";

  console.log("\n" + "=".repeat(60));
  console.log("HEDGE ADJUSTMENT");
  console.log("=".repeat(60));
  console.log(`Direction: ${direction} short`);
  console.log(`Adjustment: $${ethers.formatUnits(absAdjustmentUsd, 30)}`);
  console.log(`Delta drift before: ${(deltaDriftBefore * 100).toFixed(2)}%`);
  console.log(`Current leverage: ${hedgeData.currentLeverage.toFixed(2)}x`);
  console.log(`Estimated leverage after: ${hedgeData.estimatedLeverageAfter.toFixed(2)}x`);

  if (!options.execute) {
    console.log("\n[DRY RUN] No transactions executed");
    return { txHash: "", direction, adjustmentSizeUsd: absAdjustmentUsd };
  }

  // Get current ETH price for acceptable price calculation
  const gmxReaderContract = gmxReader.createReader(ARBITRUM_MAINNET.gmxReader, ethers.provider);

  // Fetch current position to verify it exists
  const gmxPosition = await gmxReader.getPosition(
    gmxReaderContract,
    ARBITRUM_MAINNET.gmxDataStore,
    account,
    {
      market: ARBITRUM_MAINNET.gmxEthUsdMarket,
      collateralToken: ARBITRUM_MAINNET.usdc,
      isLong: false,
    }
  );

  if (!gmxPosition || gmxPosition.numbers.sizeInTokens === 0n) {
    throw new Error("No existing GMX short position found - cannot hedge adjust");
  }

  // Calculate index token price from position data
  // price = sizeInUsd / sizeInTokens (both in appropriate decimals)
  const indexTokenPrice30 =
    (gmxPosition.numbers.sizeInUsd * 10n ** 18n) / gmxPosition.numbers.sizeInTokens;

  const router = gmxOrders.createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer);
  const executionConfig = { orderVault: ARBITRUM_MAINNET.gmxOrderVault };

  let txHash: string;

  if (direction === "increase") {
    // Increase short with zero collateral (leverage floats up)
    const slippageFactor = BigInt(Math.round((1 - config.slippageBuffer) * 10000));
    const acceptablePrice30 = (indexTokenPrice30 * slippageFactor) / 10000n;
    const acceptablePrice = price30ToPrice12(acceptablePrice30);

    const usdcContract = new ethers.Contract(
      ARBITRUM_MAINNET.usdc,
      ERC20_ABI,
      signer
    ) as unknown as IERC20;

    console.log(
      `\nCreating increase order: size=$${ethers.formatUnits(absAdjustmentUsd, 30)}, collateral=0`
    );

    const result = await gmxOrders.createIncreaseOrder(
      router as unknown as GMXRouter,
      usdcContract,
      {
        account,
        market: ARBITRUM_MAINNET.gmxEthUsdMarket,
        collateralToken: ARBITRUM_MAINNET.usdc,
        sizeDeltaUsd: absAdjustmentUsd,
        collateralAmount: 0n, // Key: no additional collateral
        acceptablePrice,
        executionFee: config.defaultExecutionFee,
        isLong: false,
      },
      executionConfig
    );

    txHash = result.txHash;
  } else {
    // Decrease short (collateral unchanged, leverage floats down)
    const slippageFactor = BigInt(Math.round((1 + config.slippageBuffer) * 10000));
    const acceptablePrice30 = (indexTokenPrice30 * slippageFactor) / 10000n;
    const acceptablePrice = price30ToPrice12(acceptablePrice30);

    console.log(`\nCreating decrease order: size=$${ethers.formatUnits(absAdjustmentUsd, 30)}`);

    const result = await gmxOrders.createDecreaseOrder(
      router as unknown as GMXRouter,
      {
        account,
        market: ARBITRUM_MAINNET.gmxEthUsdMarket,
        collateralToken: ARBITRUM_MAINNET.usdc,
        sizeDeltaUsd: absAdjustmentUsd,
        acceptablePrice,
        executionFee: config.defaultExecutionFee,
        isLong: false,
      },
      executionConfig
    );

    txHash = result.txHash;
  }

  console.log(`\nHedge adjustment tx: ${txHash}`);

  // Record in database
  try {
    const db = new MonitoringDatabase(options.dbPath);
    db.recordHedgeAdjustment(
      account,
      direction,
      absAdjustmentUsd,
      deltaDriftBefore,
      hedgeData.currentLeverage,
      hedgeData.estimatedLeverageAfter,
      txHash
    );
    db.close();
  } catch (dbError: any) {
    console.warn("Failed to record hedge adjustment in database:", dbError.message);
  }

  // Send alert (unless suppressed)
  if (!options.suppressAlert) {
    try {
      await sendSuccessAlert(
        `🔧 Harmonia : Hedge ${direction === "increase" ? "Increased" : "Decreased"}`,
        "",
        [
          {
            name: "Direction",
            value: direction === "increase" ? "Increase Short" : "Decrease Short",
            inline: true,
          },
          {
            name: "Adjustment",
            value: `$${parseFloat(ethers.formatUnits(absAdjustmentUsd, 30)).toFixed(4)}`,
            inline: true,
          },
          {
            name: "Delta Drift Before",
            value: `${(deltaDriftBefore * 100).toFixed(2)}%`,
            inline: true,
          },
          {
            name: "Leverage",
            value: `${hedgeData.currentLeverage.toFixed(2)}x → ${hedgeData.estimatedLeverageAfter.toFixed(2)}x`,
            inline: true,
          },
          {
            name: "Tx Hash",
            value: txHash,
            inline: false,
          },
        ]
      );
    } catch (alertError: any) {
      console.warn("Failed to send hedge adjustment alert:", alertError.message);
    }
  }

  return { txHash, direction, adjustmentSizeUsd: absAdjustmentUsd };
}
