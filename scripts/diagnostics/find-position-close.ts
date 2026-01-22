import { ethers } from "hardhat";

const HM_ADDRESS = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
const EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";
// Block where order was executed
const START_BLOCK = 423873303;

async function main() {
  console.log(`Searching for events for ${HM_ADDRESS} starting from block ${START_BLOCK}...`);

  // Pad address to 32 bytes for topic matching
  const topicAddress = ethers.zeroPadValue(HM_ADDRESS, 32);
  
  // We want to scan the next ~1000 blocks or so.
  // Ideally we loop until we find something or hit current block.
  // For this diagnostic, let's scan 5000 blocks (should be enough if it happened soon).
  
  const currentBlock = await ethers.provider.getBlockNumber();
  const maxBlock = Math.min(currentBlock, START_BLOCK + 500);
  const batchSize = 5; // Reduced batch size for strict RPC limits

  console.log(`Scanning up to block ${maxBlock} in batches of ${batchSize}...`);

  let foundEvents = 0;

  for (let fromBlock = START_BLOCK; fromBlock < maxBlock; fromBlock += batchSize) {
    const toBlock = Math.min(fromBlock + batchSize - 1, maxBlock);
    process.stdout.write(`Scanning ${fromBlock} to ${toBlock}... \r`);

    try {
      const logs = await ethers.provider.getLogs({
        address: EVENT_EMITTER,
        fromBlock: fromBlock,
        toBlock: toBlock,
        topics: [
          null, // Any signature (EventLog1, EventLog2, etc)
          null, // Any event name hash
          topicAddress // The account address is usually indexed here for Position events
        ]
      });

      if (logs.length > 0) {
        console.log(`\nFound ${logs.length} events in range ${fromBlock}-${toBlock}`);
        
        for (const log of logs) {
            // Determine event type
            const dataHex = log.data.toLowerCase();
            let eventType = "Unknown";
            
            // Hex representations of event names
            if (dataHex.includes("506f736974696f6e496e637265617365")) eventType = "PositionIncrease"; // PositionIncrease
            else if (dataHex.includes("506f736974696f6e4465637265617365")) eventType = "PositionDecrease"; // PositionDecrease
            else if (dataHex.includes("4f726465724578656375746564")) eventType = "OrderExecuted"; // OrderExecuted
            else if (dataHex.includes("4f7264657243616e63656c6c6564")) eventType = "OrderCancelled"; // OrderCancelled
            else if (dataHex.includes("4c69717569646174696f6e")) eventType = "Liquidation"; // Liquidation
            
            console.log(`[${log.blockNumber}] Tx: ${log.transactionHash} - ${eventType}`);
            
            if (eventType === "PositionDecrease" || eventType === "Liquidation") {
                console.log("!!! FOUND CLOSING EVENT !!!");
                
                // If we find a decrease, let's look at the transaction details
                const tx = await ethers.provider.getTransaction(log.transactionHash);
                console.log("Transaction from:", tx?.from);
                
                // Decode receipt for more context
                const receipt = await ethers.provider.getTransactionReceipt(log.transactionHash);
                console.log("Gas used:", receipt?.gasUsed.toString());
            }
        }
        foundEvents += logs.length;
      }
    } catch (e: any) {
      console.log(`\nError scanning ${fromBlock}-${toBlock}: ${e.message}`);
      // Try to reduce batch size if error?
    }
  }

  console.log(`\nScan complete. Found ${foundEvents} total events.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
