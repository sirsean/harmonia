import { ethers } from "hardhat";

const ORDER_KEY = "0x1d96e30a496580a5309e102e8efd250ba2149c0f00997e812d822315a9ff7b91";
const HM_ADDRESS = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
const COMPOUND_TX = "0x3303e28aa1e8ebff475f0e1f60a11b776f845bf1f34d1f677067a1c4b2f848b9";

async function main() {
  console.log("=== Trace Order Cancellation ===\n");

  // Get the compound tx receipt
  const receipt = await ethers.provider.getTransactionReceipt(COMPOUND_TX);
  console.log("Compound tx block:", receipt?.blockNumber);
  console.log("Compound tx logs:", receipt?.logs.length);

  // Look for subsequent transactions to/from HM
  console.log("\n=== Checking block range for cancellation ===");

  const startBlock = receipt!.blockNumber;
  const currentBlock = await ethers.provider.getBlockNumber();
  console.log("Start block:", startBlock);
  console.log("Current block:", currentBlock);
  console.log("Blocks elapsed:", currentBlock - startBlock);

  // Check for USDC balance history
  const usdc = await ethers.getContractAt("IERC20", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");

  console.log("\n=== Current Balances ===");
  const hmBalance = await usdc.balanceOf(HM_ADDRESS);
  console.log("HM USDC balance now:", ethers.formatUnits(hmBalance, 6));

  // Check GMX Order Vault
  const ORDER_VAULT = "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5";
  const orderVaultBalance = await usdc.balanceOf(ORDER_VAULT);
  console.log("GMX Order Vault USDC:", ethers.formatUnits(orderVaultBalance, 6));

  // The cancellation receiver should be HM
  // Let me check the HedgeManager contract for the callback
  const hm = await ethers.getContractAt("HedgeManager", HM_ADDRESS);

  // Check what the cancelCallback is set to
  console.log("\n=== HedgeManager Config ===");
  const vault = await hm.vault();
  const exchangeRouter = await hm.exchangeRouter();
  const orderVault = await hm.orderVault();

  console.log("Vault:", vault);
  console.log("Exchange Router:", exchangeRouter);
  console.log("Order Vault:", orderVault);

  // Let's look at the order data from the compound tx
  console.log("\n=== Decoding Order From Compound TX ===");

  // Parse the ShortOpened event
  const shortOpenedTopic = ethers.id("ShortOpened(bytes32,uint256,uint256)");
  for (const log of receipt!.logs) {
    if (log.address.toLowerCase() === HM_ADDRESS.toLowerCase()) {
      if (log.topics[0] === shortOpenedTopic) {
        console.log("ShortOpened event found!");
        const orderKey = log.topics[1];
        const data = ethers.AbiCoder.defaultAbiCoder().decode(
          ["uint256", "uint256"],
          log.data
        );
        console.log("Order Key:", orderKey);
        console.log("Size Delta USD (30d):", data[0].toString());
        console.log("Collateral Amount:", ethers.formatUnits(data[1], 6), "USDC");

        // Calculate position size in USD
        const sizeUsd = Number(data[0]) / 1e30;
        console.log("\nPosition Size: $" + sizeUsd.toFixed(2));

        // GMX minimum order size is typically $100-500
        if (sizeUsd < 100) {
          console.log("\n⚠️  ORDER LIKELY TOO SMALL - GMX typically requires minimum $100-500 orders");
        }
      }
    }
  }

  // Check the GMX event emitter for OrderCancelled
  const EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";
  console.log("\n=== Checking GMX Events (manual topic filter) ===");

  // OrderCancelled event
  // Check a small range after the compound tx
  const scanRange = 100; // blocks
  for (let i = 0; i < Math.min(10, Math.ceil((currentBlock - startBlock) / scanRange)); i++) {
    const fromBlock = startBlock + i * scanRange;
    const toBlock = Math.min(fromBlock + scanRange - 1, currentBlock);

    try {
      const logs = await ethers.provider.getLogs({
        address: EVENT_EMITTER,
        fromBlock,
        toBlock,
        topics: [
          null, // any event
          null,
          ORDER_KEY // indexed order key
        ]
      });

      if (logs.length > 0) {
        console.log(`Found ${logs.length} events for order in blocks ${fromBlock}-${toBlock}`);
        for (const log of logs) {
          console.log("  Block:", log.blockNumber);
          console.log("  Tx:", log.transactionHash);
        }
      }
    } catch (e: any) {
      // Provider rate limit
      if (!e.message.includes("Free tier")) {
        console.log("Error:", e.message);
      }
    }
  }

  // Check GMX minPositionSize for the market
  console.log("\n=== GMX Market Config ===");
  const market = await hm.market();
  console.log("Market:", market);

  // Try to read min position size from DataStore
  const routerContract = await ethers.getContractAt("IExchangeRouter", exchangeRouter);
  const dataStore = await routerContract.dataStore();
  const ds = await ethers.getContractAt("IDataStore", dataStore);

  // MIN_POSITION_SIZE_USD key
  const MIN_POSITION_SIZE_USD = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["MIN_POSITION_SIZE_USD"])
  );

  try {
    const minSize = await ds.getUint(MIN_POSITION_SIZE_USD);
    console.log("Global MIN_POSITION_SIZE_USD:", ethers.formatUnits(minSize, 30), "USD");
  } catch (e: any) {
    console.log("Could not read MIN_POSITION_SIZE_USD:", e.message);
  }

  // Market-specific min position size
  // keccak256(abi.encode("MIN_POSITION_SIZE_USD", market))
  const marketMinSizeKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address"],
      [MIN_POSITION_SIZE_USD, market]
    )
  );

  try {
    const marketMinSize = await ds.getUint(marketMinSizeKey);
    console.log("Market MIN_POSITION_SIZE_USD:", ethers.formatUnits(marketMinSize, 30), "USD");
  } catch (e: any) {
    console.log("Could not read market min size:", e.message);
  }

  // Check our HedgeManager minPositionSize setting
  const hmMinSize = await hm.minPositionSize();
  console.log("\nHedgeManager minPositionSize:", ethers.formatUnits(hmMinSize, 30), "USD");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
