import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { getLatestPrice } from "../../../modules/chainlink/price";
import { createIncreaseOrder, createRouter } from "../../../modules/gmx/orders";
import { IERC20 } from "../../../modules/gmx/types";
import { getSignerAndAccount } from "../base";
import { ERC20_ABI } from "../../../utils/abis";

export interface GmxOpenShortOptions {
  account?: string;
  collateralAmount: string;
  sizeDeltaUsd: string;
  executionFee?: string;
  slippageBps?: number;
}

export async function gmxOpenShort(options: GmxOpenShortOptions): Promise<void> {
  const { signer, account } = await getSignerAndAccount(options.account);

  console.log("\n" + "=".repeat(60));
  console.log("GMX V2 CREATE SHORT POSITION");
  console.log("=".repeat(60) + "\n");

  const routerAddress = ARBITRUM_MAINNET.gmxExchangeRouter;
  const orderVaultAddress = ARBITRUM_MAINNET.gmxOrderVault;
  const marketAddress = ARBITRUM_MAINNET.gmxEthUsdMarket;
  const usdcAddress = ARBITRUM_MAINNET.usdc;

  const priceResult = await getLatestPrice(ARBITRUM_MAINNET.chainlinkEthUsdFeed, ethers.provider, {
    outputDecimals: 12,
    maxStaleSeconds: 3600,
  });

  if (!priceResult.outputPrice) {
    throw new Error("Missing output price for acceptable price calculation.");
  }

  console.log("Current ETH Price:", ethers.formatUnits(priceResult.price, priceResult.decimals));

  const collateralAmount = ethers.parseUnits(options.collateralAmount, 6);
  const executionFee = options.executionFee
    ? ethers.parseEther(options.executionFee)
    : ethers.parseEther("0.01");
  const sizeDeltaUsd = ethers.parseUnits(options.sizeDeltaUsd, 30);
  const slippageBps = options.slippageBps ?? 100;

  const acceptablePrice = (priceResult.outputPrice * BigInt(10000 - slippageBps)) / 10000n;

  console.log("Collateral:", ethers.formatUnits(collateralAmount, 6), "USDC");
  console.log("Size:", ethers.formatUnits(sizeDeltaUsd, 30), "USD");
  console.log("Fee:", ethers.formatEther(executionFee), "ETH");
  console.log("Acceptable Price:", ethers.formatUnits(acceptablePrice, 12), "USD");
  console.log("Slippage:", slippageBps / 100, "%");

  const router = createRouter(routerAddress, signer);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer) as unknown as IERC20;

  console.log("Sending Transaction...");
  const nonce = await signer.getNonce("pending");

  const result = await createIncreaseOrder(
    router,
    usdc,
    {
      account,
      market: marketAddress,
      collateralToken: usdcAddress,
      sizeDeltaUsd,
      collateralAmount,
      acceptablePrice,
      executionFee,
      isLong: false,
    },
    {
      orderVault: orderVaultAddress,
      routerAddress,
      gasLimit: 4000000,
      nonce,
      performStaticCall: false,
    }
  );

  console.log("Tx Hash:", result.txHash);
  console.log("\nSUCCESS! Short Order Created.");
  console.log("Explorer: https://arbiscan.io/tx/" + result.txHash);
}
