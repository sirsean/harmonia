import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { getLatestPrice } from "../../../modules/chainlink/price";
import { createDecreaseOrder, createRouter } from "../../../modules/gmx/orders";
import { createReader, getPosition } from "../../../modules/gmx/reader";
import { getSignerAndAccount } from "../base";

export interface GmxCloseShortOptions {
  account?: string;
  market: string;
  sizeDeltaUsd?: string;
  executionFee?: string;
  slippageBps?: number;
}

export async function gmxCloseShort(options: GmxCloseShortOptions): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);

  console.log("\n" + "=".repeat(60));
  console.log("GMX V2 CLOSE SHORT POSITION");
  console.log("=".repeat(60) + "\n");

  const routerAddress = ARBITRUM_MAINNET.gmxExchangeRouter;
  const marketAddress = options.market;
  const usdcAddress = ARBITRUM_MAINNET.usdc;

  const executionFee = options.executionFee
    ? ethers.parseEther(options.executionFee)
    : ethers.parseEther("0.01");
  const slippageBps = options.slippageBps ?? 100;

  const reader = createReader(ARBITRUM_MAINNET.gmxReader, ethers.provider);
  const shortPosition = await getPosition(reader, ARBITRUM_MAINNET.gmxDataStore, account, {
    start: 0,
    end: 10,
    market: marketAddress,
    collateralToken: usdcAddress,
    isLong: false,
  });

  if (!shortPosition) {
    console.log("No short position found for market:", marketAddress);
    return;
  }

  const sizeDeltaUsd = options.sizeDeltaUsd
    ? ethers.parseUnits(options.sizeDeltaUsd, 30)
    : shortPosition.numbers.sizeInUsd;
  console.log("Position Size (USD):", ethers.formatUnits(shortPosition.numbers.sizeInUsd, 30));
  console.log("Closing Size (USD):", ethers.formatUnits(sizeDeltaUsd, 30));

  const priceResult = await getLatestPrice(ARBITRUM_MAINNET.chainlinkEthUsdFeed, ethers.provider, {
    outputDecimals: 12,
    maxStaleSeconds: 3600,
  });

  if (!priceResult.outputPrice) {
    throw new Error("Missing output price for acceptable price calculation.");
  }

  console.log("Current ETH Price:", ethers.formatUnits(priceResult.price, priceResult.decimals));

  const acceptablePrice = (priceResult.outputPrice * BigInt(10000 + slippageBps)) / 10000n;
  console.log("Acceptable Price:", ethers.formatUnits(acceptablePrice, 12), "USD");
  console.log("Slippage:", slippageBps / 100, "%");

  const router = createRouter(routerAddress, signer);

  console.log("Sending Transaction...");
  const nonce = await signer.getNonce("pending");

  const result = await createDecreaseOrder(
    router,
    {
      account,
      market: marketAddress,
      collateralToken: usdcAddress,
      sizeDeltaUsd,
      acceptablePrice,
      executionFee,
      isLong: false,
    },
    {
      orderVault: ARBITRUM_MAINNET.gmxOrderVault,
      gasLimit: 4000000,
      nonce,
      performStaticCall: false,
    }
  );

  console.log("Tx Hash:", result.txHash);
  console.log("\nSUCCESS! Close order created.");
  console.log("Explorer: https://arbiscan.io/tx/" + result.txHash);
}
