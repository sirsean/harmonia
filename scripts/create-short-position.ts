import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";
import { getLatestPrice } from "../src/modules/chainlink/price";
import { createIncreaseOrder, createRouter } from "../src/modules/gmx/orders";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("GMX V2 CREATE SHORT POSITION");
  console.log("=".repeat(60) + "\n");

  const [signer] = await ethers.getSigners();
  const myAddress = await signer.getAddress();

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

  const collateralAmount = ethers.parseUnits("20", 6); // 20 USDC
  const executionFee = ethers.parseEther("0.01");
  const sizeDeltaUsd = ethers.parseUnits("100", 30);

  const acceptablePrice = (priceResult.outputPrice * 99n) / 100n;

  console.log("Collateral:", ethers.formatUnits(collateralAmount, 6), "USDC");
  console.log("Size:", ethers.formatUnits(sizeDeltaUsd, 30), "USD");
  console.log("Fee:", ethers.formatEther(executionFee), "ETH");
  console.log("Acceptable Price:", ethers.formatUnits(acceptablePrice, 12), "USD");

  const router = createRouter(routerAddress, signer);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);

  console.log("Sending Transaction...");
  const nonce = await signer.getNonce("pending");

  const result = await createIncreaseOrder(
    router,
    usdc,
    {
      account: myAddress,
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
      performStaticCall: true,
    }
  );

  console.log("Tx Hash:", result.txHash);
  console.log("\nSUCCESS! Short Order Created.");
  console.log("Explorer: https://arbiscan.io/tx/" + result.txHash);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
