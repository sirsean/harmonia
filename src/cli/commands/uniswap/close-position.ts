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
}

export async function uniswapClosePosition(options: UniswapClosePositionOptions): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);

  console.log("\n" + "=".repeat(60));
  console.log("UNISWAP V3 CLOSE POSITION");
  console.log("=".repeat(60) + "\n");

  const tokenId = BigInt(options.tokenId);

  const reader = createPositionManager(ARBITRUM_MAINNET.uniswapV3PositionManager, ethers.provider);
  const manager = createPositionManagerWriter(ARBITRUM_MAINNET.uniswapV3PositionManager, signer);
  const position = await getPosition(reader, tokenId);

  if (position.liquidity === 0n) {
    console.log("Position has no liquidity; collecting fees only.");
  } else {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    await decreaseLiquidity(manager, {
      tokenId,
      liquidity: position.liquidity,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline,
    });
  }

  await collectFees(manager, {
    tokenId,
    recipient: account,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  });

  console.log("\nClose + collect submitted.");
}
