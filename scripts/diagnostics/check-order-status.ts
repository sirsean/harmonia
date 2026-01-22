import { ethers } from "hardhat";

const HM_ADDRESS = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
const ORDER_KEY = "0x931f434c82c898f5656e212b775c6a544ee8b5b36cc7fa0c65eea32e17f42135";

// GMX Event Handler address on Arbitrum
const EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";

async function main() {
  console.log("=== GMX Order Status Check ===\n");
  console.log("Order Key:", ORDER_KEY);
  console.log("");

  // Check for OrderCancelled events
  const eventEmitter = await ethers.getContractAt(
    [
      "event EventLog1(address msgSender, string eventName, string eventNameHash, bytes32 indexed topic1, tuple(tuple(string key, address value)[] items, tuple(string key, address[] value)[] arrayItems) addressItems, tuple(tuple(string key, uint256 value)[] items, tuple(string key, uint256[] value)[] arrayItems) uintItems, tuple(tuple(string key, int256 value)[] items, tuple(string key, int256[] value)[] arrayItems) intItems, tuple(tuple(string key, bool value)[] items, tuple(string key, bool[] value)[] arrayItems) boolItems, tuple(tuple(string key, bytes32 value)[] items, tuple(string key, bytes32[] value)[] arrayItems) bytes32Items, tuple(tuple(string key, bytes value)[] items, tuple(string key, bytes[] value)[] arrayItems) bytesItems, tuple(tuple(string key, string value)[] items, tuple(string key, string[] value)[] arrayItems) stringItems)"
    ],
    EVENT_EMITTER
  );

  // Get block from recent operations
  const startBlock = await ethers.provider.getBlockNumber() - 500;
  const currentBlock = await ethers.provider.getBlockNumber();

  console.log("Checking events from block", startBlock, "to", currentBlock);
  console.log("");

  // Look for events with this order key
  const filter = {
    address: EVENT_EMITTER,
    fromBlock: startBlock,
    toBlock: currentBlock,
    topics: [
      null, // any event
      null,
      ORDER_KEY, // indexed topic for order key
    ]
  };

  try {
    const logs = await ethers.provider.getLogs(filter);
    console.log("Found", logs.length, "events related to this order\n");

    for (const log of logs) {
      console.log("Block:", log.blockNumber);
      console.log("Tx:", log.transactionHash);
      console.log("Topics:", log.topics);
      console.log("---");
    }
  } catch (e: any) {
    console.log("Error fetching events:", e.message);
  }

  // Also check HedgeManager events
  console.log("\n=== HedgeManager Events ===");
  const hm = await ethers.getContractAt("HedgeManager", HM_ADDRESS);

  // Check for order-related events
  const hmFilter = {
    address: HM_ADDRESS,
    fromBlock: startBlock,
    toBlock: currentBlock,
  };

  try {
    const hmLogs = await ethers.provider.getLogs(hmFilter);
    console.log("Found", hmLogs.length, "HedgeManager events\n");

    for (const log of hmLogs) {
      try {
        const parsed = hm.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed) {
          console.log("Event:", parsed.name);
          console.log("Block:", log.blockNumber);
          console.log("Tx:", log.transactionHash);
          console.log("Args:", parsed.args);
          console.log("---");
        }
      } catch (e) {
        // Not a HedgeManager event
      }
    }
  } catch (e: any) {
    console.log("Error fetching HM events:", e.message);
  }

  // Check current state
  console.log("\n=== Current HedgeManager State ===");
  const [
    lastOrderKey,
    positionSize
  ] = await Promise.all([
    hm.lastOrderKey(),
    hm.getPositionSizeUsd(),
  ]);

  console.log("Last order key:", lastOrderKey);
  console.log("Current position size (30d):", positionSize.toString());
  console.log("Current position size (USD):", ethers.formatUnits(positionSize, 30));

  // Check collateral balance stuck in HM
  const usdc = await ethers.getContractAt("IERC20", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  const hmBalance = await usdc.balanceOf(HM_ADDRESS);
  console.log("\nHM USDC balance:", ethers.formatUnits(hmBalance, 6));

  const hmEth = await ethers.provider.getBalance(HM_ADDRESS);
  console.log("HM ETH balance:", ethers.formatEther(hmEth));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
