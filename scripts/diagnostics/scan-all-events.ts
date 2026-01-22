import { ethers } from "hardhat";

const HM_ADDRESS = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
const EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";
const START_BLOCK = 423873303;

async function main() {
  console.log(`Deep scanning for ${HM_ADDRESS} in data/topics starting from ${START_BLOCK}...`);

  // Scan 100 blocks
  const maxBlock = START_BLOCK + 100;
  const batchSize = 5;

  // Clean address for search (no 0x, lowercase)
  const addrClean = HM_ADDRESS.slice(2).toLowerCase();

  for (let fromBlock = START_BLOCK; fromBlock < maxBlock; fromBlock += batchSize) {
    const toBlock = Math.min(fromBlock + batchSize - 1, maxBlock);
    process.stdout.write(`Scanning ${fromBlock} to ${toBlock}... \r`);

    try {
      const logs = await ethers.provider.getLogs({
        address: EVENT_EMITTER,
        fromBlock: fromBlock,
        toBlock: toBlock,
      });

      for (const log of logs) {
        let found = false;
        
        // Check topics
        for (const topic of log.topics) {
          if (topic.toLowerCase().includes(addrClean)) {
            found = true;
            break;
          }
        }

        // Check data
        if (!found && log.data.toLowerCase().includes(addrClean)) {
          found = true;
        }

        if (found) {
          console.log(`\n[${log.blockNumber}] Found event involving HedgeManager!`);
          console.log(`Tx: ${log.transactionHash}`);
          
          const dataHex = log.data.toLowerCase();
          
          if (dataHex.includes("506f736974696f6e496e637265617365")) console.log("Event Type: PositionIncrease");
          else if (dataHex.includes("506f736974696f6e4465637265617365")) console.log("Event Type: PositionDecrease");
          else if (dataHex.includes("4f726465724578656375746564")) console.log("Event Type: OrderExecuted");
          else if (dataHex.includes("4f7264657243616e63656c6c6564")) console.log("Event Type: OrderCancelled");
          else if (dataHex.includes("4c69717569646174696f6e")) console.log("Event Type: Liquidation");
          else {
            console.log("Event Type: Unknown");
            console.log("Data:", dataHex.substring(0, 200) + "...");
          }
        }
      }
    } catch (e: any) {
      console.log(`Error: ${e.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
