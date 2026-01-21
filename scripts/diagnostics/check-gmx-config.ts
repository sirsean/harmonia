import { ethers } from "hardhat";

async function main() {
  const hmAddr = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
  const hm = await ethers.getContractAt("HedgeManager", hmAddr);

  console.log("=== GMX Configuration Check ===\n");

  // Get configured addresses
  const exchangeRouter = await hm.exchangeRouter();
  const market = await hm.market();
  const collateralToken = await hm.collateralToken();
  const indexToken = await hm.indexToken();
  const orderVault = await hm.orderVault();

  console.log("Exchange Router:", exchangeRouter);
  console.log("Market:", market);
  console.log("Collateral Token:", collateralToken);
  console.log("Index Token:", indexToken);
  console.log("Order Vault:", orderVault);

  // Expected addresses from DEPLOYMENT.md
  console.log("\n=== Expected Addresses (from DEPLOYMENT.md) ===");
  console.log("Exchange Router: 0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41");
  console.log("Order Vault: 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5");
  console.log("ETH/USD Market: 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336");
  console.log("USDC: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  console.log("WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");

  // Check exchange router interface
  console.log("\n=== Exchange Router Check ===");
  const routerContract = await ethers.getContractAt("IExchangeRouter", exchangeRouter);

  try {
    const dataStore = await routerContract.dataStore();
    console.log("DataStore:", dataStore);
    console.log("Expected DataStore: 0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8");
  } catch (e: any) {
    console.log("Failed to get dataStore:", e.message);
  }

  try {
    const router = await routerContract.router();
    console.log("Router (for approvals):", router);
  } catch (e: any) {
    console.log("Failed to get router:", e.message);
  }

  // Check position key
  console.log("\n=== Position Key Check ===");
  const positionKey = await hm.getPositionKey();
  console.log("Position Key:", positionKey);

  // Check current position
  const sizeUsd = await hm.getPositionSizeUsd();
  const sizeTokens = await hm.getPositionSizeTokens();
  const collateral = await hm.getCollateralAmount();

  console.log("\n=== Current Position ===");
  console.log("Size USD (30d):", sizeUsd.toString());
  console.log("Size Tokens:", sizeTokens.toString());
  console.log("Collateral:", collateral.toString());
  console.log("Has Position:", await hm.hasPosition());

  // Try to get GMX's minimum execution fee
  console.log("\n=== Execution Fee ===");
  const execFee = await hm.getExecutionFee();
  const execFeeOverride = await hm.executionFeeOverride();
  console.log("Execution Fee:", ethers.formatEther(execFee), "ETH");
  console.log("Fee Override:", execFeeOverride.toString());

  // Check slippage
  console.log("\n=== Slippage Settings ===");
  const slippageTolerance = await hm.slippageTolerance();
  console.log("Slippage Tolerance:", ethers.formatUnits(slippageTolerance, 16), "%");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
