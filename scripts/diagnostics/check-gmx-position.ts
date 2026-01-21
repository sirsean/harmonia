import { ethers } from "hardhat";

async function main() {
  const hmAddr = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
  const hm = await ethers.getContractAt("HedgeManager", hmAddr);

  console.log("=== GMX Position Key Investigation ===\n");

  // Get configuration
  const market = await hm.market();
  const collateralToken = await hm.collateralToken();
  const isLong = false; // shorts

  console.log("HedgeManager:", hmAddr);
  console.log("Market:", market);
  console.log("Collateral Token:", collateralToken);
  console.log("Is Long:", isLong);

  // Get position key from contract
  const positionKey = await hm.getPositionKey();
  console.log("\nPosition key from contract:", positionKey);

  // Calculate position key manually (same as GMXPositionUtils)
  // GMX uses: keccak256(abi.encode(account, market, collateralToken, isLong))
  const manualPositionKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "bool"],
      [hmAddr, market, collateralToken, isLong]
    )
  );
  console.log("Position key calculated manually:", manualPositionKey);
  console.log("Keys match:", positionKey === manualPositionKey);

  // Now let's check if GMX actually has this position
  const exchangeRouter = await hm.exchangeRouter();
  const routerContract = await ethers.getContractAt("IExchangeRouter", exchangeRouter);
  const dataStore = await routerContract.dataStore();

  console.log("\n=== Checking GMX DataStore ===");
  console.log("DataStore:", dataStore);

  const ds = await ethers.getContractAt("IDataStore", dataStore);

  // GMX v2 uses specific key patterns
  // See: https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/data/Keys.sol

  // POSITION constants - GMX uses keccak256(abi.encode("POSITION_SIZE_IN_USD")) not toUtf8Bytes
  const POSITION_SIZE_IN_USD = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["POSITION_SIZE_IN_USD"])
  );

  console.log("\nKey generation check:");
  console.log("POSITION_SIZE_IN_USD (abi.encode string):", POSITION_SIZE_IN_USD);

  // The key for reading position size is: keccak256(abi.encode(POSITION_SIZE_IN_USD, positionKey))
  const sizeKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [POSITION_SIZE_IN_USD, positionKey]
    )
  );
  console.log("Size key:", sizeKey);

  // Read from datastore
  try {
    const sizeUsd = await ds.getUint(sizeKey);
    console.log("\nPosition size from DataStore:", sizeUsd.toString());
    console.log("Position size (USD):", ethers.formatUnits(sizeUsd, 30));
  } catch (e: any) {
    console.log("Error reading size:", e.message);
  }

  // Let's also try alternative key formats that GMX might use
  console.log("\n=== Alternative key formats ===");

  // Try using different prefix key formats
  const accountPositionListKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], ["ACCOUNT_POSITION_LIST", hmAddr])
  );
  console.log("Account position list key:", accountPositionListKey);

  // Check last order
  const lastOrderKey = await hm.lastOrderKey();
  console.log("\n=== Last Order Check ===");
  console.log("Last order key:", lastOrderKey);

  // Order reading key would be similar
  const ORDER_SIZE_DELTA_USD = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["SIZE_DELTA_USD"])
  );
  const orderSizeKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ORDER_SIZE_DELTA_USD, lastOrderKey]
    )
  );

  try {
    const orderSize = await ds.getUint(orderSizeKey);
    console.log("Order still pending in DataStore:", orderSize.toString());
    if (orderSize === 0n) {
      console.log("Order was already executed or cancelled");
    }
  } catch (e: any) {
    console.log("Error reading order:", e.message);
  }

  // Let's check what GMX Reader can tell us
  console.log("\n=== Checking via GMX Reader ===");
  // GMX Reader address on Arbitrum
  const READER_ADDR = "0xf60becbba223EEA9495Da3f606753867eC10d139";

  try {
    const reader = await ethers.getContractAt(
      [
        "function getPosition(address dataStore, address account, address market, address collateralToken, bool isLong) view returns (tuple(uint256 sizeInUsd, uint256 sizeInTokens, uint256 collateralAmount, uint256 borrowingFactor, uint256 fundingFeeAmountPerSize, uint256 longTokenClaimableFundingAmountPerSize, uint256 shortTokenClaimableFundingAmountPerSize, uint256 increasedAtBlock, uint256 decreasedAtBlock))"
      ],
      READER_ADDR
    );

    const position = await reader.getPosition(dataStore, hmAddr, market, collateralToken, isLong);
    console.log("\nPosition from Reader:");
    console.log("  Size USD:", position.sizeInUsd.toString());
    console.log("  Size Tokens:", position.sizeInTokens.toString());
    console.log("  Collateral:", position.collateralAmount.toString());
    console.log("  Borrowing Factor:", position.borrowingFactor.toString());
  } catch (e: any) {
    console.log("Error reading from Reader:", e.message);

    // Try alternative Reader interface
    try {
      const reader2 = await ethers.getContractAt(
        [
          "function getPositionInfo(address dataStore, bytes32 positionKey) view returns (tuple(uint256 sizeInUsd, uint256 sizeInTokens, uint256 collateralAmount))"
        ],
        READER_ADDR
      );
      const posInfo = await reader2.getPositionInfo(dataStore, positionKey);
      console.log("\nPosition from Reader (alt):");
      console.log("  Size USD:", posInfo.sizeInUsd.toString());
    } catch (e2: any) {
      console.log("Alternative Reader also failed:", e2.message);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
