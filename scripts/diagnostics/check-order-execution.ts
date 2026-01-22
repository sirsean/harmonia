import { ethers } from "hardhat";

const EXECUTE_TX = "0x6ac6c772dfec68ce0277102285860ba99e539ca0dad42002486530f80ddd1962";
const OUR_ORDER_KEY = "0x1d96e30a496580a5309e102e8efd250ba2149c0f00997e812d822315a9ff7b91";

async function main() {
  console.log("=== Check Order Execution ===\n");

  const tx = await ethers.provider.getTransaction(EXECUTE_TX);
  console.log("Tx To:", tx?.to);

  // Decode the order key from input data
  // executeOrder(bytes32 key, OracleUtils.SetPricesParams oracleParams)
  // Function selector is 4 bytes, then bytes32 key is next 32 bytes (64 hex chars)
  const inputData = tx?.data || "";
  const orderKey = "0x" + inputData.slice(10, 74);

  console.log("Order key in tx:", orderKey);
  console.log("Our order key:  ", OUR_ORDER_KEY);
  console.log("Match:", orderKey.toLowerCase() === OUR_ORDER_KEY.toLowerCase());

  // Look at the logs of this tx
  const receipt = await ethers.provider.getTransactionReceipt(EXECUTE_TX);
  console.log("\n=== Transaction Logs ===");
  console.log("Logs count:", receipt?.logs.length);

  // Look for events with our order key
  let foundOurOrder = false;
  for (const log of receipt?.logs || []) {
    for (const topic of log.topics) {
      if (topic.toLowerCase().includes(OUR_ORDER_KEY.slice(2).toLowerCase())) {
        console.log("\nFound our order key in log!");
        console.log("Address:", log.address);
        console.log("Topic:", topic);
        foundOurOrder = true;
      }
    }
  }

  if (!foundOurOrder) {
    console.log("\nOur order key NOT found in this transaction's logs");
    console.log("This execution tx is for a DIFFERENT order");
  }

  // Let's search for any tx that DOES have our order key
  console.log("\n=== Searching for our order execution ===");

  // GMX Event Emitter
  const EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";

  // Check a small range manually
  const compoundBlock = 423873298;
  const currentBlock = await ethers.provider.getBlockNumber();

  console.log("Compound block:", compoundBlock);
  console.log("Current block:", currentBlock);

  // Due to provider limitations, let's just check if there's any activity
  // by looking at HedgeManager's lastOrderKey and position state

  const HM_ADDRESS = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
  const hm = await ethers.getContractAt("HedgeManager", HM_ADDRESS);

  const [lastOrderKey, hasPosition] = await Promise.all([
    hm.lastOrderKey(),
    hm.hasPosition(),
  ]);

  console.log("\nHedgeManager state:");
  console.log("Last order key:", lastOrderKey);
  console.log("Has position:", hasPosition);

  // Read position size directly
  try {
    const posSize = await hm.getPositionSizeUsd();
    console.log("Position size USD:", ethers.formatUnits(posSize, 30));
  } catch (e: any) {
    console.log("Error getting position size:", e.message);
  }

  // The mystery: order was created, but position size is 0
  // Possible causes:
  // 1. Order was cancelled after creation
  // 2. Position was closed/liquidated
  // 3. Position key mismatch

  // Let's check if GMX has any pending orders for HM
  console.log("\n=== Checking for pending GMX orders ===");

  const exchangeRouter = await hm.exchangeRouter();
  const routerContract = await ethers.getContractAt("IExchangeRouter", exchangeRouter);
  const dataStore = await routerContract.dataStore();
  const ds = await ethers.getContractAt("IDataStore", dataStore);

  // Account order list key
  const ACCOUNT_ORDER_LIST = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["ACCOUNT_ORDER_LIST"])
  );

  const accountOrderListKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address"],
      [ACCOUNT_ORDER_LIST, HM_ADDRESS]
    )
  );

  // This is a set, not a simple value
  // Let's check our order key's status directly
  const ORDER_TYPE = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["ORDER_TYPE"])
  );

  const orderTypeKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ORDER_TYPE, OUR_ORDER_KEY]
    )
  );

  try {
    const orderType = await ds.getUint(orderTypeKey);
    console.log("Our order type in DataStore:", orderType.toString());
    if (orderType === 0n) {
      console.log("Order type 0 = order no longer exists (executed or cancelled)");
    }
  } catch (e: any) {
    console.log("Error reading order type:", e.message);
  }

  // Final check - see if our collateral is somewhere
  console.log("\n=== USDC Balance Check ===");
  const usdc = await ethers.getContractAt("IERC20", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");

  const [hmBal, vaultBal] = await Promise.all([
    usdc.balanceOf(HM_ADDRESS),
    usdc.balanceOf(await hm.vault()),
  ]);

  console.log("HedgeManager USDC:", ethers.formatUnits(hmBal, 6));
  console.log("Vault USDC:", ethers.formatUnits(vaultBal, 6));

  // The 12.21 USDC is probably stuck in GMX market or was used for the position
  // but position was then closed/liquidated
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
