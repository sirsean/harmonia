import { ethers } from "hardhat";

const COMPOUND_TX = "0x6ac6c772dfec68ce0277102285860ba99e539ca0dad42002486530f80ddd1962";
const EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";
const HM = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";

async function main() {
  console.log("=== Decode Order Details ===\n");

  const receipt = await ethers.provider.getTransactionReceipt(COMPOUND_TX);

  // Get HedgeManager events
  const hm = await ethers.getContractAt("HedgeManager", HM);

  console.log("=== HedgeManager Events ===");
  for (const log of receipt!.logs) {
    if (log.address.toLowerCase() === HM.toLowerCase()) {
      try {
        const parsed = hm.interface.parseLog({
          topics: [...log.topics],
          data: log.data
        });
        console.log("Event:", parsed?.name);
        if (parsed?.args) {
          for (let i = 0; i < parsed.args.length; i++) {
            const arg = parsed.args[i];
            if (typeof arg === 'bigint') {
              console.log(`  arg[${i}]:`, arg.toString());
            } else {
              console.log(`  arg[${i}]:`, arg);
            }
          }
        }
      } catch {
        // Not parseable
      }
    }
  }

  // Look at the GMX PositionIncrease Event
  console.log("\n=== GMX PositionIncrease Event ===");
  for (let i = 0; i < receipt!.logs.length; i++) {
    const log = receipt!.logs[i];
    if (log.address.toLowerCase() === EVENT_EMITTER.toLowerCase()) {
      const dataHex = log.data.slice(2).toLowerCase();
      
      if (dataHex.includes('506f736974696f6e496e637265617365')) {
        console.log("Found PositionIncrease at log index:", i);
        console.log("FULL DATA HEX:", dataHex);
        
        // Try to find numbers that look like our expected values
        // Size: ~24425586498810129239033910440000 (24.42e30)
        // Collateral: ~12212793 (12.21e6)
        
        const sizeHex = BigInt("24425586498810129239033910440000").toString(16);
        const collHex = BigInt("12212793").toString(16);
        
        console.log(`Searching for size hex: ${sizeHex}`);
        if (dataHex.includes(sizeHex)) {
            console.log("✅ Found expected size in event data!");
        } else {
            console.log("❌ Did NOT find expected size in event data.");
        }
        
        console.log(`Searching for collateral hex: ${collHex}`);
        if (dataHex.includes(collHex)) {
            console.log("✅ Found expected collateral in event data!");
        } else {
            console.log("❌ Did NOT find expected collateral in event data.");
        }

        break;
      }
    }
  }

  console.log("\n=== Position Analysis ===");

  // The ShortOpened event data
  const shortOpenedEvent = hm.interface.getEvent("ShortOpened");
  console.log("ShortOpened event signature:", shortOpenedEvent?.format());

  // Check the HedgeAdjusted event too
  try {
    const hedgeAdjustedEvent = hm.interface.getEvent("HedgeAdjusted");
    console.log("HedgeAdjusted event signature:", hedgeAdjustedEvent?.format());
  } catch {
    console.log("No HedgeAdjusted event in interface");
  }

  // Let's also check the current position in the GMX Reader with different approach
  console.log("\n=== Try Direct DataStore Read ===");

  const exchangeRouter = await hm.exchangeRouter();
  const routerContract = await ethers.getContractAt("IExchangeRouter", exchangeRouter);
  const dataStore = await routerContract.dataStore();

  console.log("DataStore:", dataStore);

  // Position key
  const market = await hm.market();
  const collateralToken = await hm.collateralToken();
  const isLong = false;

  console.log("Account (HM):", HM);
  console.log("Market:", market);
  console.log("Collateral:", collateralToken);
  console.log("IsLong:", isLong);

  // Manually calculate position key
  const positionKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "bool"],
      [HM, market, collateralToken, isLong]
    )
  );
  console.log("Position Key:", positionKey);

  // Try reading position directly with different key formats
  const ds = await ethers.getContractAt("IDataStore", dataStore);

  // GMX v2.1 uses slightly different key format
  // POSITION (string hash)
  const POSITION = ethers.keccak256(ethers.toUtf8Bytes("POSITION"));
  console.log("\nPOSITION prefix (utf8):", POSITION);

  // SIZE_IN_USD
  const SIZE_IN_USD = ethers.keccak256(ethers.toUtf8Bytes("SIZE_IN_USD"));

  // Try: keccak256(abi.encode(POSITION, account, market, collateralToken, isLong))
  const posKey2 = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "address", "bool"],
      [POSITION, HM, market, collateralToken, isLong]
    )
  );
  console.log("Alternative position key:", posKey2);

  // Read size
  const sizeKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [SIZE_IN_USD, positionKey]
    )
  );

  try {
    const size = await ds.getUint(sizeKey);
    console.log("Position size (standard key):", size.toString());
  } catch (e: any) {
    console.log("Error reading size:", e.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});