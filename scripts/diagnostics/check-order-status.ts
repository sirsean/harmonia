import { ethers } from "hardhat";

const HM_ADDRESS = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
const ORDER_KEY = "0x522fe5bea27d030c669a01a28ca48460adf6b1d406f3c89cbb28cb899f8fdf74";

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

  // Scan last 500 blocks
  const currentBlock = await ethers.provider.getBlockNumber();
  const startBlock = currentBlock - 500;
  const maxBlock = currentBlock;
  const batchSize = 5; // Strict limit

  console.log(`Scanning for ${ORDER_KEY} from ${startBlock} to ${maxBlock}...`);

  for (let from = startBlock; from < maxBlock; from += batchSize) {
      const to = Math.min(from + batchSize - 1, maxBlock);
      // process.stdout.write(`Scanning ${from}-${to}\r`);
      
      const filter = {
        address: EVENT_EMITTER,
        fromBlock: from,
        toBlock: to,
        topics: [null, null, ORDER_KEY]
      };

      try {
        const logs = await ethers.provider.getLogs(filter);
        if (logs.length > 0) {
            console.log(`\nFound ${logs.length} events in ${from}-${to}!`);
            for (const log of logs) {
                console.log("Block:", log.blockNumber);
                console.log("Tx:", log.transactionHash);
                
                // Try to identify event type by common hashes in data
                const data = log.data.toLowerCase();
                if (data.includes("4f726465724578656375746564")) console.log("Event: OrderExecuted");
                if (data.includes("4f7264657243616e63656c6c6564")) console.log("Event: OrderCancelled");
                if (data.includes("4f7264657243726561746564")) console.log("Event: OrderCreated");
                if (data.includes("506f736974696f6e496e637265617365")) console.log("Event: PositionIncrease");
                if (data.includes("506f736974696f6e4465637265617365")) console.log("Event: PositionDecrease");
                
                // Decode receipt for errors
                // const receipt = await ethers.provider.getTransactionReceipt(log.transactionHash);
                // console.log("Receipt Status:", receipt?.status);
            }
        }
      } catch (e) {
          // ignore error
      }
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
