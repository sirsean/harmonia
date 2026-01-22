import { ethers } from "hardhat";

const TX_HASH = "0xbaf0d8f455794d9bed695401c27858e2c4ae730cb7e1871f8ba7e2f05b95d0e0";
const EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";

async function main() {
  console.log("=== Execution TX Analysis ===");
  console.log("Tx:", TX_HASH);

  const receipt = await ethers.provider.getTransactionReceipt(TX_HASH);
  console.log("Status:", receipt?.status);
  console.log("Logs:", receipt?.logs.length);

  for (const log of receipt?.logs || []) {
    if (log.address.toLowerCase() === EVENT_EMITTER.toLowerCase()) {
        const data = log.data.toLowerCase();
        let eventName = "Unknown";
        
        if (data.includes("4f726465724578656375746564")) eventName = "OrderExecuted";
        if (data.includes("4f7264657243616e63656c6c6564")) eventName = "OrderCancelled";
        if (data.includes("506f736974696f6e496e637265617365")) eventName = "PositionIncrease";
        if (data.includes("506f736974696f6e4465637265617365")) eventName = "PositionDecrease";
        
        console.log(`
Event: ${eventName}`);
        
        if (eventName === "PositionIncrease") {
            console.log("Position Increased!");
            // Try to find size
            // Data is huge, let's look for our $170 (approx 1.7e20 in 18d? no 30d)
            // 170 * 1e30 = 1.7e32
            // Hex: 0x865...
            console.log("Data length:", data.length);
        }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
