import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";

// GMX Reader ABI (minimal for getAccountPositions)
const READER_ABI = [
  "function getAccountPositions(address dataStore, address account, uint256 start, uint256 end) view returns (tuple(tuple(address account, address market, address collateralToken) addresses, tuple(uint256 sizeInUsd, uint256 sizeInTokens, uint256 collateralAmount, uint256 borrowingFactor, uint256 fundingFeeAmountPerSize, uint256 longTokenClaimableFundingAmountPerSize, uint256 shortTokenClaimableFundingAmountPerSize, uint256 increasedAtBlock, uint256 decreasedAtBlock, uint256 increasedAtTime, uint256 decreasedAtTime) numbers, tuple(bool isLong) flags)[])",
];

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("GMX V2 CLOSE SHORT POSITION");
  console.log("=".repeat(60) + "\n");

  const [signer] = await ethers.getSigners();
  const myAddress = await signer.getAddress();

  const routerAddress = ARBITRUM_MAINNET.gmxExchangeRouter;
  const marketAddress = ARBITRUM_MAINNET.gmxEthUsdMarket;
  const usdcAddress = ARBITRUM_MAINNET.usdc;

  const executionFee = ethers.parseEther("0.01");

  const reader = new ethers.Contract(ARBITRUM_MAINNET.gmxReader, READER_ABI, ethers.provider);
  const positions = await reader.getAccountPositions(
    ARBITRUM_MAINNET.gmxDataStore,
    myAddress,
    0,
    10
  );

  const shortPosition = positions.find(
    (pos: any) =>
      pos.addresses.market.toLowerCase() === marketAddress.toLowerCase() &&
      pos.addresses.collateralToken.toLowerCase() === usdcAddress.toLowerCase() &&
      pos.flags.isLong === false
  );

  if (!shortPosition) {
    console.log("No ETH short position found.");
    return;
  }

  const sizeDeltaUsd = shortPosition.numbers.sizeInUsd;
  console.log("Position Size (USD):", ethers.formatUnits(sizeDeltaUsd, 30));

  // Chainlink ETH/USD price (8 decimals)
  const feed = await ethers.getContractAt(
    ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"],
    ARBITRUM_MAINNET.chainlinkEthUsdFeed,
    signer
  );
  const [, price] = await feed.latestRoundData();
  console.log("Current ETH Price:", ethers.formatUnits(price, 8));

  // Acceptable Price: 1% slippage for short close (max price)
  const priceUsd12 = ethers.parseUnits(ethers.formatUnits(price, 8), 12);
  const acceptablePrice = (priceUsd12 * BigInt(101)) / BigInt(100);
  console.log("Acceptable Price:", ethers.formatUnits(acceptablePrice, 12), "USD");

  const routerAbi = [
    "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
    "function sendWnt(address receiver, uint256 amount) external payable",
    "function createOrder(((address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath),(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime),uint8 orderType,uint8 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList) params) external payable returns (bytes32 orderKey)",
  ];
  const router = await ethers.getContractAt(routerAbi, routerAddress, signer);

  const params = [
    [myAddress, myAddress, ethers.ZeroAddress, ethers.ZeroAddress, marketAddress, usdcAddress, []],
    [sizeDeltaUsd, 0, 0, acceptablePrice, executionFee, 0, 0, 0],
    4, // MarketDecrease
    0, // NoSwap
    false,
    false,
    false,
    ethers.ZeroHash,
    [],
  ];

  console.log("Sending Transaction...");
  const sendWntData = router.interface.encodeFunctionData("sendWnt", [
    ARBITRUM_MAINNET.gmxOrderVault,
    executionFee,
  ]);
  const createOrderData = router.interface.encodeFunctionData("createOrder", [params]);

  const tx = await router.multicall([sendWntData, createOrderData], {
    value: executionFee,
    gasLimit: 4000000,
    nonce: await signer.getNonce("pending"),
  });

  console.log("Tx Hash:", tx.hash);
  await tx.wait();
  console.log("\nSUCCESS! Close order created.");
  console.log("Explorer: https://arbiscan.io/tx/" + tx.hash);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
