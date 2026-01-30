import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { DeltaNeutralMonitor } from "../../../strategy/monitor";
import { loadStrategyConfig, StrategyConfig } from "../../../config/strategy";
import { createPositionManager, getPosition } from "../../../modules/uniswap/reader";
import { collectFees, decreaseLiquidity } from "../../../modules/uniswap/fees";
import { createPositionManager as createPositionManagerWriter } from "../../../modules/uniswap/liquidity";
import * as gmxReader from "../../../modules/gmx/reader";
import * as gmxOrders from "../../../modules/gmx/orders";
import { getLatestPrice } from "../../../modules/chainlink/price";
import { getSignerAndAccount } from "../base";
import { sendErrorAlert, sendSuccessAlert } from "../../../utils/alerts";
import { MonitoringDatabase } from "../../../utils/database";
import { getUnclaimedFees } from "../../../modules/uniswap/fees";
import * as uniswapReader from "../../../modules/uniswap/reader";
import { ERC20_ABI } from "../../../utils/abis";
import { refreshNonce } from "../../../utils/helpers";

const MAX_UINT128 = (1n << 128n) - 1n;

export interface CloseAllOptions {
  account?: string;
  tokenId?: string;
  execute?: boolean;
}

export interface ClosePositionsResult {
  closedUniswapPositions: number;
  closedGmxPosition: boolean;
  totalFeesCollectedUsd: bigint; // Total fees collected from all closed positions
}

/**
 * Internal function to close positions (used by both closeAll and executeOptimize)
 */
export async function closePositions(
  account: string,
  signer: any,
  positionsToClose: Array<{ tokenId: string; liquidity: bigint }>,
  gmxPosition: { numbers: { sizeInUsd: bigint; collateralAmount: bigint } } | null,
  executeFlag: boolean,
  monitorConfig: StrategyConfig,
  db?: MonitoringDatabase
): Promise<ClosePositionsResult> {
  if (positionsToClose.length === 0 && (!gmxPosition || gmxPosition.numbers.sizeInUsd === 0n)) {
    return { closedUniswapPositions: 0, closedGmxPosition: false, totalFeesCollectedUsd: 0n };
  }

  let totalFeesCollectedUsd = 0n;

  const reader = createPositionManager(ARBITRUM_MAINNET.uniswapV3PositionManager, signer.provider);
  const manager = createPositionManagerWriter(ARBITRUM_MAINNET.uniswapV3PositionManager, signer);

  // Close GMX short position first (if exists)
  if (gmxPosition && gmxPosition.numbers.sizeInUsd > 0n) {
    if (executeFlag) {
      console.log(`\nClosing GMX short position...`);
      console.log(`  Size: $${ethers.formatUnits(gmxPosition.numbers.sizeInUsd, 30)}`);

      const priceResult = await getLatestPrice(
        ARBITRUM_MAINNET.chainlinkEthUsdFeed,
        signer.provider,
        {
          outputDecimals: 12,
          maxStaleSeconds: 3600,
        }
      );

      if (!priceResult.outputPrice) {
        throw new Error("Missing output price for GMX close order");
      }

      // Acceptable price: current price + max slippage (for closing short, we're buying)
      // Use maxSlippage from config (default 1%) for acceptable price tolerance
      const slippageBps = BigInt(Math.round(monitorConfig.maxSlippage * 10000));
      const slippageFactor = 10000n + slippageBps;
      const acceptablePrice = (priceResult.outputPrice * slippageFactor) / 10000n;
      const executionFee = monitorConfig.defaultExecutionFee || ethers.parseEther("0.01");

      const router = gmxOrders.createRouter(ARBITRUM_MAINNET.gmxExchangeRouter, signer);

      const closeResult = await gmxOrders.createDecreaseOrder(
        router,
        {
          account: account,
          market: ARBITRUM_MAINNET.gmxEthUsdMarket,
          collateralToken: ARBITRUM_MAINNET.usdc,
          sizeDeltaUsd: gmxPosition.numbers.sizeInUsd,
          acceptablePrice,
          executionFee,
          isLong: false,
        },
        {
          orderVault: ARBITRUM_MAINNET.gmxOrderVault,
          gasLimit: 4000000,
          performStaticCall: false,
        }
      );

      console.log(`  Close GMX order tx: ${closeResult.txHash}`);
      // Wait for transaction confirmation - CRITICAL: must wait before proceeding
      if (closeResult.tx) {
        const txReceipt = (await closeResult.tx.wait()) as { blockNumber: number };
        console.log(`  Transaction confirmed in block ${txReceipt.blockNumber}`);
      } else {
        throw new Error("GMX close transaction was not returned - cannot proceed safely");
      }
    } else {
      console.log(`\nWould close GMX short position`);
      console.log(`  Size: $${ethers.formatUnits(gmxPosition.numbers.sizeInUsd, 30)}`);
    }
  }

  // Close each LP position and collect tokens
  // CRITICAL: Process positions sequentially to avoid nonce conflicts
  for (const pos of positionsToClose) {
    const tokenId = BigInt(pos.tokenId);
    if (executeFlag) {
      console.log(`\nClosing Uniswap LP position ${pos.tokenId}...`);
    }

    const position = await getPosition(reader, tokenId);

    // Get unclaimed fees BEFORE decreasing liquidity
    // After decreaseLiquidity, collect() will return both fees AND liquidity tokens
    // We only want to record the fees portion
    let feesAmount0 = 0n;
    let feesAmount1 = 0n;
    let feesCollectedUsd = 0n;

    if (db && executeFlag) {
      try {
        // Get fees before decreaseLiquidity - at this point, getUnclaimedFees only returns fees
        const unclaimedFees = await getUnclaimedFees(manager, tokenId, account);
        feesAmount0 = unclaimedFees.amount0;
        feesAmount1 = unclaimedFees.amount1;

        // Calculate USD value of fees
        // Get pool to determine token order
        const poolContract = uniswapReader.createPool(
          ARBITRUM_MAINNET.uniswapV3EthUsdcPool,
          signer.provider
        );
        const token0Address = await poolContract.token0();
        const token1Address = await poolContract.token1();
        const isToken0Weth = token0Address.toLowerCase() === ARBITRUM_MAINNET.weth.toLowerCase();

        // Get token contracts and decimals
        const token0Contract = new ethers.Contract(token0Address, ERC20_ABI, signer.provider);
        const token1Contract = new ethers.Contract(token1Address, ERC20_ABI, signer.provider);
        const [decimals0, decimals1] = await Promise.all([
          token0Contract.decimals(),
          token1Contract.decimals(),
        ]);

        // Get ETH price for USD conversion
        const priceResult = await getLatestPrice(
          ARBITRUM_MAINNET.chainlinkEthUsdFeed,
          signer.provider,
          { outputDecimals: 12, maxStaleSeconds: 3600 }
        );
        const ethPriceUsd = priceResult.outputPrice
          ? Number(ethers.formatUnits(priceResult.outputPrice, 12))
          : 3000;

        // Calculate USD value (30 decimals)
        if (isToken0Weth) {
          // token0 is WETH, token1 is USDC
          const wethValueUsd =
            feesAmount0 > 0n
              ? (feesAmount0 * BigInt(Math.floor(ethPriceUsd * 1e12)) * 10n ** 18n) /
                (10n ** BigInt(decimals0) * 10n ** 12n)
              : 0n;
          const usdcValueUsd =
            feesAmount1 > 0n ? (feesAmount1 * 10n ** 30n) / 10n ** BigInt(decimals1) : 0n;
          feesCollectedUsd = wethValueUsd + usdcValueUsd;
        } else {
          // token0 is USDC, token1 is WETH
          const usdcValueUsd =
            feesAmount0 > 0n ? (feesAmount0 * 10n ** 30n) / 10n ** BigInt(decimals0) : 0n;
          const wethValueUsd =
            feesAmount1 > 0n
              ? (feesAmount1 * BigInt(Math.floor(ethPriceUsd * 1e12)) * 10n ** 18n) /
                (10n ** BigInt(decimals1) * 10n ** 12n)
              : 0n;
          feesCollectedUsd = usdcValueUsd + wethValueUsd;
        }
      } catch (error: any) {
        console.warn(`  Warning: Failed to calculate fee USD value: ${error.message}`);
      }
    }

    let decreaseSucceeded = false;

    // Step 1: Remove liquidity if present
    if (position.liquidity > 0n) {
      if (executeFlag) {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
        console.log(`  Removing liquidity: ${position.liquidity.toString()}`);

        try {
          const decreaseTx = await decreaseLiquidity(manager, {
            tokenId,
            liquidity: position.liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline,
          });
          console.log(`  Decrease liquidity transaction submitted: ${decreaseTx.hash}`);
          // CRITICAL: Wait for confirmation before proceeding to prevent stuck funds
          const decreaseReceipt = (await decreaseTx.wait()) as { blockNumber: number };
          console.log(`  Decrease liquidity confirmed in block ${decreaseReceipt.blockNumber}`);
          decreaseSucceeded = true;

          // CRITICAL: Refresh nonce to prevent "nonce too low" errors
          await refreshNonce(signer.provider, account);
        } catch (error: any) {
          console.error(
            `  ERROR: Failed to decrease liquidity for position ${pos.tokenId}:`,
            error.message
          );
          // Continue to try collecting anyway - there might be tokens/fees to collect
          console.warn(`  Attempting to collect fees/tokens despite decreaseLiquidity failure...`);
        }
      } else {
        console.log(`  Would remove liquidity: ${position.liquidity.toString()}`);
      }
    } else {
      if (executeFlag) {
        console.log(`  Position has no liquidity; collecting fees only.`);
      }
    }

    // Step 2: Always collect fees and tokens (even if liquidity was 0 or decreaseLiquidity failed)
    // Note: decreaseLiquidity stores tokens in the position contract - collect() transfers them to wallet
    // CRITICAL: Must collect after decreaseLiquidity to avoid stuck funds
    // CRITICAL: Must collect even if decreaseLiquidity failed (in case it partially succeeded)
    if (executeFlag) {
      console.log(`  Collecting fees and tokens...`);
      try {
        const collectTx = await collectFees(manager, {
          tokenId,
          recipient: account,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        });
        console.log(`  Collect transaction submitted: ${collectTx.hash}`);
        // CRITICAL: Wait for confirmation before proceeding
        const collectReceipt = await collectTx.wait();
        console.log(
          `  Collect confirmed in block ${collectReceipt.blockNumber} - tokens transferred to wallet`
        );

        // CRITICAL: Refresh nonce after collect before processing next position (if multiple)
        await refreshNonce(signer.provider, account);

        // Record fee collection in database
        if (db && feesCollectedUsd > 0n) {
          try {
            db.recordFeeCollection(
              account,
              pos.tokenId,
              feesCollectedUsd,
              feesAmount0,
              feesAmount1
            );
            totalFeesCollectedUsd += feesCollectedUsd;
            console.log(`  Recorded fee collection: $${ethers.formatUnits(feesCollectedUsd, 30)}`);
          } catch (error: any) {
            console.warn(`  Warning: Failed to record fee collection: ${error.message}`);
          }
        }
      } catch (error: any) {
        console.error(
          `  ERROR: Failed to collect fees/tokens for position ${pos.tokenId}:`,
          error.message
        );
        // If decreaseLiquidity succeeded but collect failed, funds are stuck!
        if (decreaseSucceeded) {
          throw new Error(
            `CRITICAL: Position ${pos.tokenId} liquidity was removed but collection failed. ` +
              `Funds may be stuck in position contract. Manual intervention required. ` +
              `Original error: ${error.message}`
          );
        }
        // If both failed, throw the error
        throw error;
      }
    } else {
      if (position.liquidity > 0n) {
        console.log(`  Would remove liquidity: ${position.liquidity.toString()}`);
      } else {
        console.log(`  Position has no liquidity; would collect fees only.`);
      }
      console.log(`  Would collect fees`);
    }
  }

  return {
    closedUniswapPositions: positionsToClose.length,
    closedGmxPosition: gmxPosition ? gmxPosition.numbers.sizeInUsd > 0n : false,
    totalFeesCollectedUsd,
  };
}

/**
 * Close all strategy positions:
 * 1. Close all Uniswap LP positions (collect fees and remove liquidity)
 * 2. Close GMX short positions
 *
 * This command is useful for:
 * - Exiting the strategy completely
 * - Preparing for a full reset before re-optimization
 * - Emergency position closure
 */
export async function closeAll(options: CloseAllOptions = {}): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);
  const executeFlag = options.execute ?? false;

  console.log("\n" + "=".repeat(60));
  console.log("CLOSE ALL STRATEGY POSITIONS");
  if (!executeFlag) {
    console.log("[DRY RUN MODE]");
  }
  console.log("=".repeat(60) + "\n");

  console.log("Executing account:", account);

  try {
    // 1. Discover all positions using monitor
    const tokenIds = options.tokenId ? [BigInt(options.tokenId)] : undefined;

    const monitorConfig = loadStrategyConfig({
      minOptimizationFeeThresholdUsd: ethers.parseUnits("10", 30),
    });

    const monitorContext = {
      uniswap: {
        positionManager: ARBITRUM_MAINNET.uniswapV3PositionManager,
        pool: ARBITRUM_MAINNET.uniswapV3EthUsdcPool,
        tokenIds: tokenIds,
      },
      gmx: {
        reader: ARBITRUM_MAINNET.gmxReader,
        dataStore: ARBITRUM_MAINNET.gmxDataStore,
        account: account,
        market: ARBITRUM_MAINNET.gmxEthUsdMarket,
        collateralToken: ARBITRUM_MAINNET.usdc,
      },
    };

    const monitor = new DeltaNeutralMonitor(ethers.provider, monitorConfig, monitorContext);

    console.log("Discovering positions...");
    const { status } = await monitor.check();

    // Get positions to close
    const positionsToClose = status.uniswap.filter((pos) => pos.liquidity > 0n);

    // Get GMX position
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

    const hasGmxPosition = gmxPosition && gmxPosition.numbers.sizeInUsd > 0n;

    // Summary
    console.log(`\nFound:`);
    console.log(`  Uniswap LP positions: ${positionsToClose.length}`);
    console.log(`  GMX short position: ${hasGmxPosition ? "Yes" : "No"}`);

    if (positionsToClose.length === 0 && !hasGmxPosition) {
      console.log("\n✅ No positions to close.");
      return;
    }

    // Display positions
    if (positionsToClose.length > 0) {
      console.log(`\nUniswap LP positions to close:`);
      for (const pos of positionsToClose) {
        const currentRangeWidth = ((pos.priceUpper - pos.priceLower) / pos.currentPrice) * 100;
        console.log(
          `  Position ${pos.tokenId}: Range ${pos.priceLower.toFixed(2)} - ${pos.priceUpper.toFixed(2)} (${currentRangeWidth.toFixed(1)}% width)`
        );
        console.log(`    Liquidity: ${pos.liquidity.toString()}`);
        if (pos.unclaimedFees.amount0 > 0n || pos.unclaimedFees.amount1 > 0n) {
          console.log(
            `    Unclaimed fees: ${pos.unclaimedFees.amount0.toString()} / ${pos.unclaimedFees.amount1.toString()}`
          );
        }
      }
    }

    if (hasGmxPosition) {
      console.log(`\nGMX short position to close:`);
      console.log(`  Size: $${ethers.formatUnits(gmxPosition!.numbers.sizeInUsd, 30)}`);
      console.log(`  Collateral: $${ethers.formatUnits(gmxPosition!.numbers.collateralAmount, 6)}`);
    }

    if (!executeFlag) {
      console.log("\n[DRY RUN] Would close all positions:");
      if (positionsToClose.length > 0) {
        console.log(`  - Close ${positionsToClose.length} Uniswap LP position(s)`);
      }
      if (hasGmxPosition) {
        console.log(`  - Close GMX short position`);
      }
      console.log("\nTo execute, run with --execute flag");
      return;
    }

    // Execute: Close positions
    console.log("\nExecuting close operations...");

    await closePositions(
      account,
      signer,
      positionsToClose.map((pos) => ({ tokenId: pos.tokenId, liquidity: pos.liquidity })),
      gmxPosition || null,
      executeFlag,
      monitorConfig,
      undefined // No database in closeAll - fee recording happens in executeOptimize
    );

    console.log(`\n✅ All positions closed successfully!`);

    // Send success alert to Discord
    try {
      const fields: Array<{ name: string; value: string; inline?: boolean }> = [
        {
          name: "Account",
          value: account,
          inline: false,
        },
        {
          name: "Uniswap Positions Closed",
          value: positionsToClose.length.toString(),
          inline: true,
        },
        {
          name: "GMX Position Closed",
          value: hasGmxPosition ? "Yes" : "No",
          inline: true,
        },
      ];

      await sendSuccessAlert(
        "✅ Strategy Positions Closed",
        `Successfully closed all strategy positions.`,
        fields
      );
    } catch (alertError) {
      // Don't fail close command if alert fails
      console.warn("Failed to send Discord alert:", alertError);
    }
  } catch (error: any) {
    console.error("\nError during close operation:");
    console.error(error);

    // Send error alert to Discord
    await sendErrorAlert(
      "❌ Strategy Close Failed",
      `An error occurred while closing strategy positions.`,
      error
    ).catch((alertError) => {
      // Don't fail the close command if alert fails
      console.warn("Failed to send Discord alert:", alertError);
    });

    throw error;
  }
}
