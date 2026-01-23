import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";
import { createPositionManager, getPosition } from "../src/modules/uniswap/reader";
import { collectFees, decreaseLiquidity } from "../src/modules/uniswap/fees";
import { createPositionManager as createPositionManagerWriter } from "../src/modules/uniswap/liquidity";

const MAX_UINT128 = (1n << 128n) - 1n;

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("UNISWAP V3 CLOSE POSITION");
  console.log("=".repeat(60) + "\n");

  const tokenIdRaw = process.env.TOKEN_ID;
  if (!tokenIdRaw) {
    throw new Error("Set TOKEN_ID env var.");
  }
  const tokenId = BigInt(tokenIdRaw);

  const [signer] = await ethers.getSigners();
  const account = await signer.getAddress();

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
