import { ethers } from "hardhat";

async function main() {
  const hmAddr = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
  const hm = await ethers.getContractAt("HedgeManager", hmAddr);

  console.log("=== Position History Investigation ===\n");

  // Check current position state
  const hasPosition = await hm.hasPosition();
  const sizeUsd = await hm.getPositionSizeUsd();
  const sizeTokens = await hm.getPositionSizeTokens();
  const collateral = await hm.getCollateralAmount();

  console.log("=== Current Position State ===");
  console.log("Has position:", hasPosition);
  console.log("Size USD (30d):", sizeUsd.toString());
  console.log("Size Tokens:", sizeTokens.toString());
  console.log("Collateral:", collateral.toString());

  // Check last order key
  const lastOrderKey = await hm.lastOrderKey();
  console.log("\nLast order key:", lastOrderKey);

  // Check total funding received
  const totalFundingReceived = await hm.totalFundingReceived();
  console.log("Total funding received:", totalFundingReceived.toString());

  // Check total collateral deposited
  const totalCollateralDeposited = await hm.totalCollateralDeposited();
  console.log("Total collateral deposited:", ethers.formatUnits(totalCollateralDeposited, 6), "USDC");

  // Check position key
  const positionKey = await hm.getPositionKey();
  console.log("\nPosition key:", positionKey);

  // Check the GMX DataStore directly for any position data
  const exchangeRouter = await hm.exchangeRouter();
  const routerContract = await ethers.getContractAt("IExchangeRouter", exchangeRouter);
  const dataStore = await routerContract.dataStore();

  console.log("\n=== GMX DataStore Check ===");
  console.log("DataStore:", dataStore);

  // Try to read position directly from DataStore
  const ds = await ethers.getContractAt("IDataStore", dataStore);

  // Position keys used by HedgeManager
  const POSITION_SIZE_IN_USD = ethers.keccak256(ethers.toUtf8Bytes("POSITION_SIZE_IN_USD"));
  const POSITION_SIZE_IN_TOKENS = ethers.keccak256(ethers.toUtf8Bytes("POSITION_SIZE_IN_TOKENS"));
  const POSITION_COLLATERAL_AMOUNT = ethers.keccak256(ethers.toUtf8Bytes("POSITION_COLLATERAL_AMOUNT"));

  // Check what the contract constants are
  const contractSizeKey = await hm.POSITION_SIZE_IN_USD();
  const contractSizeTokensKey = await hm.POSITION_SIZE_IN_TOKENS();
  const contractCollateralKey = await hm.POSITION_COLLATERAL_AMOUNT();

  console.log("\nContract key constants:");
  console.log("POSITION_SIZE_IN_USD:", contractSizeKey);
  console.log("Expected (keccak of 'POSITION_SIZE_IN_USD'):", POSITION_SIZE_IN_USD);
  console.log("Match:", contractSizeKey === POSITION_SIZE_IN_USD);

  // Check USDC balance in HedgeManager
  const collateralToken = await hm.collateralToken();
  const usdc = await ethers.getContractAt("IERC20", collateralToken);
  const hmBalance = await usdc.balanceOf(hmAddr);
  console.log("\n=== HedgeManager USDC Balance ===");
  console.log("Balance:", ethers.formatUnits(hmBalance, 6), "USDC");

  // Check ETH balance in HedgeManager
  const hmEthBalance = await ethers.provider.getBalance(hmAddr);
  console.log("ETH Balance:", ethers.formatEther(hmEthBalance), "ETH");

  // Look for events - check for ShortOpened, ShortClosed, etc.
  console.log("\n=== Checking Recent Events ===");

  const filter = hm.filters.ShortOpened();
  const openEvents = await hm.queryFilter(filter, -100000);
  console.log("ShortOpened events in last 100k blocks:", openEvents.length);

  for (const event of openEvents) {
    console.log("  Block:", event.blockNumber);
    console.log("  OrderKey:", event.args?.orderKey);
    console.log("  SizeDeltaUsd:", event.args?.sizeDeltaUsd?.toString());
    console.log("  CollateralAmount:", event.args?.collateralAmount?.toString());
  }

  const closeFilter = hm.filters.ShortClosed();
  const closeEvents = await hm.queryFilter(closeFilter, -100000);
  console.log("\nShortClosed events in last 100k blocks:", closeEvents.length);

  for (const event of closeEvents) {
    console.log("  Block:", event.blockNumber);
    console.log("  OrderKey:", event.args?.orderKey);
  }

  const adjustFilter = hm.filters.HedgeAdjusted();
  const adjustEvents = await hm.queryFilter(adjustFilter, -100000);
  console.log("\nHedgeAdjusted events in last 100k blocks:", adjustEvents.length);

  for (const event of adjustEvents) {
    console.log("  Block:", event.blockNumber);
    console.log("  OrderKey:", event.args?.orderKey);
    console.log("  OldSize:", event.args?.oldSizeUsd?.toString());
    console.log("  NewTarget:", event.args?.newTargetSizeUsd?.toString());
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
