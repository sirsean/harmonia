import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { createPositionManager, getPosition } from "../../../modules/uniswap/reader";
import { collectFees, decreaseLiquidity } from "../../../modules/uniswap/fees";
import { createPositionManager as createPositionManagerWriter } from "../../../modules/uniswap/liquidity";
import { getSignerAndAccount } from "../base";

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

  console.log("\n✅ Position closed and tokens collected successfully!");
}
