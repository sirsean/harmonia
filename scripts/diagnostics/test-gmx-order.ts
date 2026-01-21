import { ethers } from "hardhat";

// This script tests if we can create a GMX order by simulating the HedgeManager's _createOrder flow

async function main() {
  const hmAddr = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
  const hm = await ethers.getContractAt("HedgeManager", hmAddr);

  console.log("=== Testing GMX Order Creation ===\n");

  // Get all the configuration
  const exchangeRouter = await hm.exchangeRouter();
  const market = await hm.market();
  const collateralToken = await hm.collateralToken();
  const indexToken = await hm.indexToken();
  const orderVault = await hm.orderVault();
  const slippageTolerance = await hm.slippageTolerance();
  const execFee = await hm.getExecutionFee();
  const vault = await hm.vault();

  console.log("Configuration:");
  console.log("  Exchange Router:", exchangeRouter);
  console.log("  Market:", market);
  console.log("  Collateral Token:", collateralToken);
  console.log("  Index Token:", indexToken);
  console.log("  Order Vault:", orderVault);
  console.log("  Slippage Tolerance:", ethers.formatUnits(slippageTolerance, 16), "%");
  console.log("  Execution Fee:", ethers.formatEther(execFee), "ETH");
  console.log("  Vault:", vault);

  // Get current price
  const priceFeed = await hm.priceFeed();
  const feed = await ethers.getContractAt("IChainlinkPriceFeed", priceFeed);
  const [, answer, , ,] = await feed.latestRoundData();
  const price8 = BigInt(answer.toString());
  const price12 = price8 * 10000n; // 8 -> 12 decimals

  console.log("\nPrice:");
  console.log("  Chainlink (8d):", ethers.formatUnits(price8, 8));
  console.log("  GMX format (12d):", ethers.formatUnits(price12, 12));

  // Calculate acceptable price for short (sell)
  const PRECISION = 10n ** 18n;
  const acceptablePrice = (price12 * (PRECISION - slippageTolerance)) / PRECISION;
  console.log("  Acceptable price (12d):", ethers.formatUnits(acceptablePrice, 12));

  // Test order parameters
  const testSizeDeltaUsd = 100n * 10n ** 30n; // $100 position
  const testCollateralAmount = 50n * 10n ** 6n; // 50 USDC

  console.log("\nTest order:");
  console.log("  Size delta USD:", ethers.formatUnits(testSizeDeltaUsd, 30), "USD");
  console.log("  Collateral:", ethers.formatUnits(testCollateralAmount, 6), "USDC");

  // Build the order params as the contract would
  const orderParams = {
    addresses: {
      receiver: hmAddr,
      cancellationReceiver: hmAddr,
      callbackContract: ethers.ZeroAddress,
      uiFeeReceiver: ethers.ZeroAddress,
      market: market,
      initialCollateralToken: collateralToken,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: testSizeDeltaUsd,
      initialCollateralDeltaAmount: testCollateralAmount,
      triggerPrice: 0n,
      acceptablePrice: acceptablePrice,
      executionFee: execFee,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
    },
    orderType: 2, // MarketIncrease
    decreasePositionSwapType: 0, // NoSwap
    isLong: false,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.ZeroHash,
    dataList: [],
  };

  console.log("\nOrder params built. Testing...");

  // Try to encode the call
  const router = await ethers.getContractAt("IExchangeRouter", exchangeRouter);

  try {
    // First check if we can even encode the call properly
    const iface = router.interface;
    const calldata = iface.encodeFunctionData("createOrder", [orderParams]);
    console.log("✅ Order params encoded successfully");
    console.log("   Calldata length:", calldata.length);

    // Try a static call (will fail because we don't have collateral sent, but we can see the error)
    console.log("\nAttempting staticCall to createOrder (expected to fail)...");
    await router.createOrder.staticCall(orderParams, { value: execFee });
    console.log("✅ createOrder staticCall succeeded (unexpected!)");
  } catch (e: any) {
    console.log("\n❌ Error:", e.message);
    if (e.reason) {
      console.log("   Reason:", e.reason);
    }
    if (e.data && e.data !== "0x") {
      console.log("   Error data:", e.data);
      // Try to decode error
      const selector = e.data.slice(0, 10);
      console.log("   Error selector:", selector);
    }
  }

  // Let's also check if the ExchangeRouter has the expected interface
  console.log("\n=== Checking ExchangeRouter Interface ===");

  try {
    const dsAddr = await router.dataStore();
    console.log("✅ dataStore():", dsAddr);
  } catch (e: any) {
    console.log("❌ dataStore() failed:", e.message);
  }

  try {
    const ovAddr = await router.orderVault();
    console.log("✅ orderVault():", ovAddr);
  } catch (e: any) {
    console.log("❌ orderVault() failed:", e.message);
  }

  try {
    const routerAddr = await router.router();
    console.log("✅ router():", routerAddr);
  } catch (e: any) {
    console.log("❌ router() failed:", e.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
