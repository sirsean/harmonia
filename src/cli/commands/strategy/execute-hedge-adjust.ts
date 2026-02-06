import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { loadStrategyConfig } from "../../../config/strategy";
import * as gmxReader from "../../../modules/gmx/reader";
import * as gmxOrders from "../../../modules/gmx/orders";
import { getLatestPrice } from "../../../modules/chainlink/price";
import { getSignerAndAccount } from "../base";
import { MonitoringDatabase } from "../../../utils/database";
import { HedgeAdjustmentData } from "../../../strategy/types";
import { ERC20_ABI } from "../../../utils/abis";
import { sendSuccessAlert } from "../../../utils/alerts";
import { GMXRouter, IERC20 } from "../../../modules/gmx/types";
import { TransactionReceipt } from "ethers";

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

  // Fetch current ETH price from Chainlink for acceptable price calculation
  const priceResult = await getLatestPrice(ARBITRUM_MAINNET.chainlinkEthUsdFeed, ethers.provider, {
    outputDecimals: 12,
    maxStaleSeconds: 3600,
  });
  if (!priceResult.outputPrice) {
    throw new Error("Failed to fetch current ETH price for hedge adjustment");
  }
  const currentPrice12 = priceResult.outputPrice;

  // Verify GMX position exists
  const gmxReaderContract = gmxReader.createReader(ARBITRUM_MAINNET.gmxReader, ethers.provider);
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

  const router = gmxOrders.createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer);
  const executionConfig = { orderVault: ARBITRUM_MAINNET.gmxOrderVault };

  let txHash: string;
  let txReceipt: TransactionReceipt | null = null;

  if (direction === "increase") {
    // Increase short with zero collateral (leverage floats up)
    const slippageBps = BigInt(Math.round(config.maxSlippage * 10000));
    const acceptablePrice = (currentPrice12 * (10000n - slippageBps)) / 10000n;

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
    if (result.tx) {
      txReceipt = (await result.tx.wait()) as TransactionReceipt;
    }
  } else {
    // Decrease short (collateral unchanged, leverage floats down)
    const slippageBps = BigInt(Math.round(config.maxSlippage * 10000));
    const acceptablePrice = (currentPrice12 * (10000n + slippageBps)) / 10000n;

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
    if (result.tx) {
      txReceipt = (await result.tx.wait()) as TransactionReceipt;
    }
  }

  console.log(`\nHedge adjustment tx: ${txHash}`);

  // Wait for transaction confirmation before recording costs and returning.
  // Prefer tx.wait() from the submitted transaction because Hardhat's provider
  // does not implement waitForTransaction().
  const receipt = txReceipt ?? (await signer.provider!.getTransactionReceipt(txHash));
  if (!receipt) {
    throw new Error(`Failed to get transaction receipt for hedge adjustment: ${txHash}`);
  }

  const ethPriceUsd = Number(ethers.formatUnits(currentPrice12, 12));
  const gasPriceWei = (receipt as any).gasPrice ?? (receipt as any).effectiveGasPrice ?? 0n;
  const gasCostWei = receipt.gasUsed * gasPriceWei;
  const gasCostEth = Number(ethers.formatEther(gasCostWei));
  const gasCostUsd = ethers.parseUnits((gasCostEth * ethPriceUsd).toFixed(18), 30);

  // Match optimization accounting: net GMX execution fee cost after refund.
  const gmxExecutionFeeEth = ethers.parseEther("0.00011");
  const gmxExecutionFeeUsd = ethers.parseUnits(
    (Number(ethers.formatEther(gmxExecutionFeeEth)) * ethPriceUsd).toFixed(18),
    30
  );

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
      txHash,
      gasCostUsd,
      gmxExecutionFeeUsd
    );
    db.close();
  } catch (dbError: any) {
    console.warn("Failed to record hedge adjustment in database:", dbError.message);
  }

  // Send alert (unless suppressed)
  if (!options.suppressAlert) {
    try {
      const emoji = direction === "increase" ? "📈" : "📉";
      const title = `Harmonia: ${direction === "increase" ? "Increase" : "Decrease"} Hedge`;
      await sendSuccessAlert(`${emoji} ${title}`, "", [
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
      ]);
    } catch (alertError: any) {
      console.warn("Failed to send hedge adjustment alert:", alertError.message);
    }
  }

  return { txHash, direction, adjustmentSizeUsd: absAdjustmentUsd };
}
