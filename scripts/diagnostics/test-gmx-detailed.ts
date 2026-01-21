import { ethers } from "hardhat";

async function main() {
  console.log("=== Detailed GMX V2 Interface Check ===\n");

  const EXCHANGE_ROUTER = "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41";
  const DATASTORE = "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8";
  const ORDER_VAULT = "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5";
  const MARKET = "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336";
  const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

  // Get code at the exchange router to verify it exists
  const routerCode = await ethers.provider.getCode(EXCHANGE_ROUTER);
  console.log("Exchange Router has code:", routerCode.length > 2 ? "Yes" : "No");

  // Check the GMX createOrder interface by looking at recent transactions
  // Let's check what happens if we try different order structures

  // Try the minimal GMX V2.1 interface
  const gmxV21Interface = new ethers.Interface([
    `function createOrder((
      (address receiver, address cancellationReceiver, address callbackContract, address uiFeeReceiver, address market, address initialCollateralToken, address[] swapPath) addresses,
      (uint256 sizeDeltaUsd, uint256 initialCollateralDeltaAmount, uint256 triggerPrice, uint256 acceptablePrice, uint256 executionFee, uint256 callbackGasLimit, uint256 minOutputAmount, uint256 validFromTime) numbers,
      uint8 orderType,
      uint8 decreasePositionSwapType,
      bool isLong,
      bool shouldUnwrapNativeToken,
      bool autoCancel,
      bytes32 referralCode,
      bytes32[] dataList
    ) params) external payable returns (bytes32)`,
  ]);

  console.log("\n=== Testing GMX V2.1 interface (with validFromTime) ===");

  const orderParamsWithValidFromTime = {
    addresses: {
      receiver: "0x9D81A634c269cf262192886B5cC678E00c9D96d8", // HedgeManager
      cancellationReceiver: "0x9D81A634c269cf262192886B5cC678E00c9D96d8",
      callbackContract: ethers.ZeroAddress,
      uiFeeReceiver: ethers.ZeroAddress,
      market: MARKET,
      initialCollateralToken: USDC,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: 100n * 10n ** 30n, // $100
      initialCollateralDeltaAmount: 50n * 10n ** 6n, // 50 USDC
      triggerPrice: 0n,
      acceptablePrice: 2800n * 10n ** 12n, // $2800 acceptable price
      executionFee: 10n ** 16n, // 0.01 ETH
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n, // <-- Added validFromTime
    },
    orderType: 2, // MarketIncrease
    decreasePositionSwapType: 0, // NoSwap
    isLong: false,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.ZeroHash,
    dataList: [],
  };

  try {
    const calldata = gmxV21Interface.encodeFunctionData("createOrder", [orderParamsWithValidFromTime]);
    console.log("✅ Encoded with validFromTime successfully");
    console.log("   Calldata length:", calldata.length);

    // Try to call with this calldata
    const [signer] = await ethers.getSigners();
    console.log("\nAttempting call from:", await signer.getAddress());

    const result = await ethers.provider.call({
      to: EXCHANGE_ROUTER,
      data: calldata,
      value: 10n ** 16n,
      from: await signer.getAddress(),
    });
    console.log("Call result:", result);
  } catch (e: any) {
    console.log("❌ Error with validFromTime interface:", e.message);

    // Check if the error gives us more info
    if (e.data) {
      console.log("   Error data:", e.data);
      // Try to decode GMX error
      try {
        const errorSelector = e.data.slice(0, 10);
        console.log("   Error selector:", errorSelector);
        // GMX common errors
        const knownErrors: Record<string, string> = {
          "0xd674f9c1": "EmptyReceiver",
          "0x8e7da76a": "InvalidTokens",
          "0x27e10c82": "EmptyExecutionFee",
          "0x8b50f148": "InsufficientWntAmountForExecutionFee",
          "0x3ed86f51": "EmptyOrder",
          "0x63d22534": "OrderNotValid",
        };
        if (knownErrors[errorSelector]) {
          console.log("   Known GMX error:", knownErrors[errorSelector]);
        }
      } catch {}
    }
  }

  // Also check if there's a different struct layout
  console.log("\n=== Testing our current interface (without validFromTime) ===");

  const ourInterface = new ethers.Interface([
    `function createOrder((
      (address receiver, address cancellationReceiver, address callbackContract, address uiFeeReceiver, address market, address initialCollateralToken, address[] swapPath) addresses,
      (uint256 sizeDeltaUsd, uint256 initialCollateralDeltaAmount, uint256 triggerPrice, uint256 acceptablePrice, uint256 executionFee, uint256 callbackGasLimit, uint256 minOutputAmount) numbers,
      uint8 orderType,
      uint8 decreasePositionSwapType,
      bool isLong,
      bool shouldUnwrapNativeToken,
      bool autoCancel,
      bytes32 referralCode,
      bytes32[] dataList
    ) params) external payable returns (bytes32)`,
  ]);

  const orderParamsWithoutValidFromTime = {
    addresses: {
      receiver: "0x9D81A634c269cf262192886B5cC678E00c9D96d8",
      cancellationReceiver: "0x9D81A634c269cf262192886B5cC678E00c9D96d8",
      callbackContract: ethers.ZeroAddress,
      uiFeeReceiver: ethers.ZeroAddress,
      market: MARKET,
      initialCollateralToken: USDC,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: 100n * 10n ** 30n,
      initialCollateralDeltaAmount: 50n * 10n ** 6n,
      triggerPrice: 0n,
      acceptablePrice: 2800n * 10n ** 12n,
      executionFee: 10n ** 16n,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
    },
    orderType: 2,
    decreasePositionSwapType: 0,
    isLong: false,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.ZeroHash,
    dataList: [],
  };

  try {
    const calldata = ourInterface.encodeFunctionData("createOrder", [orderParamsWithoutValidFromTime]);
    console.log("✅ Encoded without validFromTime successfully");
    console.log("   Calldata length:", calldata.length);
  } catch (e: any) {
    console.log("❌ Error encoding without validFromTime:", e.message);
  }

  // Check function selector
  console.log("\n=== Function Selectors ===");
  console.log("With validFromTime:", gmxV21Interface.getFunction("createOrder")?.selector);
  console.log("Without validFromTime:", ourInterface.getFunction("createOrder")?.selector);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
