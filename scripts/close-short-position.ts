import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";
import { getLatestPrice } from "../src/modules/chainlink/price";
import { createDecreaseOrder, createRouter } from "../src/modules/gmx/orders";
import { createReader, getPosition } from "../src/modules/gmx/reader";

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("GMX V2 CLOSE SHORT POSITION");
  console.log("=".repeat(60) + "\n");

  const [signer] = await ethers.getSigners();
  const myAddress = await signer.getAddress();

  const routerAddress = ARBITRUM_MAINNET.gmxExchangeRouter;
  const marketAddress = ARBITRUM_MAINNET.gmxEthUsdMarket;
  const usdcAddress = ARBITRUM_MAINNET.usdc;

  const executionFee = ethers.parseEther("0.01");

  const reader = createReader(ARBITRUM_MAINNET.gmxReader, ethers.provider);
  const shortPosition = await getPosition(reader, ARBITRUM_MAINNET.gmxDataStore, myAddress, {
    start: 0,
    end: 10,
    market: marketAddress,
    collateralToken: usdcAddress,
    isLong: false,
  });

  if (!shortPosition) {
    console.log("No ETH short position found.");
    return;
  }

  const sizeDeltaUsd = shortPosition.numbers.sizeInUsd;
  console.log("Position Size (USD):", ethers.formatUnits(sizeDeltaUsd, 30));

  const priceResult = await getLatestPrice(ARBITRUM_MAINNET.chainlinkEthUsdFeed, ethers.provider, {
    outputDecimals: 12,
    maxStaleSeconds: 3600,
  });

  if (!priceResult.outputPrice) {
    throw new Error("Missing output price for acceptable price calculation.");
  }

  console.log("Current ETH Price:", ethers.formatUnits(priceResult.price, priceResult.decimals));

  const acceptablePrice = (priceResult.outputPrice * 101n) / 100n;
  console.log("Acceptable Price:", ethers.formatUnits(acceptablePrice, 12), "USD");

  const router = createRouter(routerAddress, signer);

  console.log("Sending Transaction...");
  const nonce = await signer.getNonce("pending");

  const result = await createDecreaseOrder(
    router,
    {
      account: myAddress,
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
      performStaticCall: true,
    }
  );

  console.log("Tx Hash:", result.txHash);
  console.log("\nSUCCESS! Close order created.");
  console.log("Explorer: https://arbiscan.io/tx/" + result.txHash);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
