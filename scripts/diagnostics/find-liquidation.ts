import { ethers } from "hardhat";

const HM_ADDRESS = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
const EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";

async function main() {
  console.log("=== Search for Liquidation ===\n");

  // Check liquidation by looking at the execution tx logs for "PositionDecrease" or liquidation
  const executeTx = "0x6ac6c772dfec68ce0277102285860ba99e539ca0dad42002486530f80ddd1962";

  const receipt = await ethers.provider.getTransactionReceipt(executeTx);
  console.log("Execution tx logs:", receipt?.logs.length);

  // GMX events we're looking for:
  // PositionIncrease, PositionDecrease, OrderExecuted, etc.
  // The event emitter uses EventLog1 with the event name in the data

  for (let i = 0; i < (receipt?.logs.length || 0); i++) {
    const log = receipt!.logs[i];

    // Check if it's from the event emitter
    if (log.address.toLowerCase() === EVENT_EMITTER.toLowerCase()) {
      console.log(`\n=== Log ${i} (Event Emitter) ===`);

      // Try to decode the event
      try {
        // The event name is in the data, check first topic for event type
        const topic0 = log.topics[0];

        // EventLog1 signature
        const eventLog1Sig = "0x468a25a7ba624ceea6e540ad6f49171b52495b648417ae91bca21676d8a24dc5";
        const eventLog2Sig = "0x137a44067c8961cd7e1d876f4754a5a3a75989b4552f1843fc69c3b372def160";

        if (topic0 === eventLog1Sig || topic0 === eventLog2Sig) {
          // Decode basic info
          const data = log.data;

          // First 32 bytes after offset is usually the event name length/offset
          // This is complex to decode, let's just look for key patterns

          // Check if data contains "OrderExecuted" or "PositionIncrease" etc
          const dataStr = data.toLowerCase();

          // Look for common event name hashes
          if (dataStr.includes("4f72646572457865637574656400")) {
            console.log("Found: OrderExecuted event");
          }
          if (dataStr.includes("506f736974696f6e496e637265617365")) {
            console.log("Found: PositionIncrease event");
          }
          if (dataStr.includes("506f736974696f6e446563726561736")) {
            console.log("Found: PositionDecrease event");
          }
          if (dataStr.includes("4c6971756964617465")) {
            console.log("Found: Liquidation-related event!");
          }

          console.log("Topics:", log.topics.slice(0, 3));
        }
      } catch (e) {
        // ignore decode errors
      }
    }

    // Look for HedgeManager events
    if (log.address.toLowerCase() === HM_ADDRESS.toLowerCase()) {
      console.log(`\n=== Log ${i} (HedgeManager) ===`);

      const hm = await ethers.getContractAt("HedgeManager", HM_ADDRESS);
      try {
        const parsed = hm.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        console.log("Event:", parsed?.name);
        console.log("Args:", parsed?.args);
      } catch (e) {
        console.log("Could not parse as HedgeManager event");
        console.log("Topics:", log.topics);
      }
    }
  }

  // Calculate the liquidation risk
  console.log("\n=== Liquidation Analysis ===");

  // Position opened:
  // Size: ~$24.43 USD
  // Collateral: ~$12.21 USDC
  // Leverage: ~2x

  const positionSize = 24.43;
  const collateral = 12.21;
  const leverage = positionSize / collateral;

  console.log("Position Size: $" + positionSize.toFixed(2));
  console.log("Collateral: $" + collateral.toFixed(2));
  console.log("Leverage: " + leverage.toFixed(2) + "x");

  // For a short:
  // P&L = -(price_change_pct) * position_size
  // Liquidation when: collateral + P&L <= maintenance_margin

  // GMX typically uses 1% maintenance margin
  const maintenanceMarginPct = 0.01;
  const maintenanceMargin = positionSize * maintenanceMarginPct;

  console.log("Maintenance Margin: $" + maintenanceMargin.toFixed(2));

  // Liquidation happens when:
  // collateral - (price_rise_pct * position_size) <= maintenance_margin
  // price_rise_pct = (collateral - maintenance_margin) / position_size

  const maxPriceRise = ((collateral - maintenanceMargin) / positionSize) * 100;
  console.log("Max Price Rise before liquidation: " + maxPriceRise.toFixed(2) + "%");

  // At 2x leverage on a short, a ~50% price increase would liquidate
  // But accounting for fees and slippage, even a small move could do it

  // Check current ETH price vs price at order time
  console.log("\n=== Price Check ===");

  const lm = await ethers.getContractAt(
    "LiquidityManager",
    "0x0aa77E5CE038c878A5d2704A6C18b53cD7d855De"
  );
  const currentPrice = await lm.getOraclePrice();
  console.log("Current ETH price: $" + ethers.formatUnits(currentPrice, 18));

  // The order was created at block 423873298
  // Executed at block 423873303 (5 blocks later)
  // If ETH price spiked even slightly during execution, the position could be underwater

  // Let's also check if there was a position decrease event in the same tx
  console.log("\n=== Checking for auto-close in execution tx ===");

  // Count how many PositionIncrease vs PositionDecrease topics there are
  let increases = 0;
  let decreases = 0;

  for (const log of receipt?.logs || []) {
    const dataHex = log.data.slice(2); // remove 0x
    // PositionIncrease = 0x506f736974696f6e496e637265617365
    if (dataHex.includes("506f736974696f6e496e637265617365")) {
      increases++;
    }
    // PositionDecrease = 0x506f736974696f6e4465637265617365
    if (dataHex.includes("506f736974696f6e4465637265617365")) {
      decreases++;
    }
    // OrderCancelled
    if (dataHex.includes("4f7264657243616e63656c6c6564")) {
      console.log("Found OrderCancelled event!");
    }
  }

  console.log("PositionIncrease events:", increases);
  console.log("PositionDecrease events:", decreases);

  if (decreases > 0 && increases > 0) {
    console.log("\n⚠️  Position was opened AND closed in same transaction!");
    console.log("This suggests immediate liquidation or auto-close due to margin requirements");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
