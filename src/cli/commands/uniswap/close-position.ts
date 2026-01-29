import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { createPositionManager, getPosition } from "../../../modules/uniswap/reader";
import { collectFees, decreaseLiquidity, getUnclaimedFees } from "../../../modules/uniswap/fees";
import { createPositionManager as createPositionManagerWriter } from "../../../modules/uniswap/liquidity";
import { getSignerAndAccount } from "../base";
import { MonitoringDatabase } from "../../../utils/database";
import { getLatestPrice } from "../../../modules/chainlink/price";
import * as uniswapReader from "../../../modules/uniswap/reader";
import { ERC20_ABI } from "../../../utils/abis";

const MAX_UINT128 = (1n << 128n) - 1n;

export interface UniswapClosePositionOptions {
  account?: string;
  tokenId: string;
  execute?: boolean;
}

export async function uniswapClosePosition(options: UniswapClosePositionOptions): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);
  const executeFlag = options.execute ?? false;

  console.log("\n" + "=".repeat(60));
  console.log("UNISWAP V3 CLOSE POSITION");
  if (!executeFlag) {
    console.log("[DRY RUN MODE]");
  }
  console.log("=".repeat(60) + "\n");

  const tokenId = BigInt(options.tokenId);

  const reader = createPositionManager(ARBITRUM_MAINNET.uniswapV3PositionManager, ethers.provider);
  const position = await getPosition(reader, tokenId);

  if (position.liquidity === 0n) {
    console.log("Position has no liquidity; would collect fees only.");
  } else {
    console.log(`Position liquidity: ${position.liquidity.toString()}`);
    console.log(`Would remove liquidity and collect fees.`);
  }

  if (!executeFlag) {
    console.log("\n[DRY RUN] Would close position and collect fees");
    console.log("\nTo execute, run with --execute flag");
    return;
  }

  const manager = createPositionManagerWriter(ARBITRUM_MAINNET.uniswapV3PositionManager, signer);

  // Create database instance for recording fee collections
  const db = new MonitoringDatabase();
  try {
    if (position.liquidity > 0n) {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      console.log("Removing liquidity...");
      const decreaseTx = await decreaseLiquidity(manager, {
        tokenId,
        liquidity: position.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      });
      console.log(`  Transaction submitted: ${decreaseTx.hash}`);
      console.log(`  Waiting for confirmation...`);
      const decreaseReceipt = (await decreaseTx.wait()) as { blockNumber: number };
      console.log(`  ✅ Confirmed in block ${decreaseReceipt.blockNumber}`);
      console.log(`  Explorer: https://arbiscan.io/tx/${decreaseTx.hash}`);

      // CRITICAL: Force ethers.js to refresh nonce by querying transaction count
      // This prevents "nonce too low" errors when immediately sending the next transaction
      if (signer.provider) {
        await signer.provider.getTransactionCount(account, "pending");
      }

      // Small additional delay to ensure state propagation
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Get unclaimed fees before collecting to record them
    let feesAmount0 = 0n;
    let feesAmount1 = 0n;
    let feesCollectedUsd = 0n;

    try {
      const unclaimedFees = await getUnclaimedFees(manager, tokenId, account);
      feesAmount0 = unclaimedFees.amount0;
      feesAmount1 = unclaimedFees.amount1;

      // Calculate USD value of fees
      if (!signer.provider) {
        throw new Error("Provider is required for fee recording");
      }

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

    console.log("\nCollecting fees and tokens...");
    const collectTx = await collectFees(manager, {
      tokenId,
      recipient: account,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    });
    console.log(`  Transaction submitted: ${collectTx.hash}`);
    console.log(`  Waiting for confirmation...`);
    const collectReceipt = (await collectTx.wait()) as { blockNumber: number };
    console.log(`  ✅ Confirmed in block ${collectReceipt.blockNumber}`);
    console.log(`  Explorer: https://arbiscan.io/tx/${collectTx.hash}`);

    // Record fee collection in database
    if (feesCollectedUsd > 0n) {
      try {
        db.recordFeeCollection(
          account,
          options.tokenId,
          feesCollectedUsd,
          feesAmount0,
          feesAmount1
        );
        console.log(`  Recorded fee collection: $${ethers.formatUnits(feesCollectedUsd, 30)}`);
      } catch (error: any) {
        console.warn(`  Warning: Failed to record fee collection: ${error.message}`);
      }
    }

    console.log("\n✅ Position closed and tokens collected successfully!");
  } finally {
    db.close();
  }
}
