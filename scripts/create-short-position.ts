import { ethers, network } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("GMX V2 CREATE SHORT POSITION");
  console.log("=".repeat(60) + "\n");

  const [signer] = await ethers.getSigners();
  const myAddress = await signer.getAddress();

  // Configuration
  const routerAddress = ARBITRUM_MAINNET.gmxExchangeRouter;
  const orderVaultAddress = ARBITRUM_MAINNET.gmxOrderVault;
  const marketAddress = ARBITRUM_MAINNET.gmxEthUsdMarket;
  const usdcAddress = ARBITRUM_MAINNET.usdc;

  // 1. Get Real Price for Slippage
  const feed = await ethers.getContractAt(
    ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"],
    ARBITRUM_MAINNET.chainlinkEthUsdFeed,
    signer
  );
  const [, price, , ,] = await feed.latestRoundData();
  console.log("Current ETH Price:", ethers.formatUnits(price, 8));

  // Parameters
  const collateralAmount = ethers.parseUnits("20", 6); // 20 USDC
  const executionFee = ethers.parseEther("0.01"); // High fee for safety
  const sizeDeltaUsd = ethers.parseUnits("100", 30); // $100 Position

  // Acceptable Price: 1% Slippage allowed for Short
  // GMX expects 12-decimal prices for acceptablePrice in orders.
  const priceUsd12 = ethers.parseUnits(ethers.formatUnits(price, 8), 12);
  const acceptablePrice = (priceUsd12 * BigInt(99)) / BigInt(100);

  const routerAbi = [
    "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
    "function sendTokens(address token, address receiver, uint256 amount) external payable",
    "function sendWnt(address receiver, uint256 amount) external payable",
    "function createOrder(((address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath),(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime),uint8 orderType,uint8 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList) params) external payable returns (bytes32 orderKey)",
  ];
  const router = await ethers.getContractAt(routerAbi, routerAddress, signer);
  const usdc = await ethers.getContractAt("IERC20", usdcAddress, signer);

  const params = [
    [myAddress, myAddress, ethers.ZeroAddress, ethers.ZeroAddress, marketAddress, usdcAddress, []],
    [sizeDeltaUsd, collateralAmount, 0, acceptablePrice, executionFee, 0, 0, 0],
    2, // MarketIncrease
    0, // NoSwap
    false, // SHORT
    false,
    false,
    ethers.ZeroHash,
    [],
  ];

  console.log("Collateral:", ethers.formatUnits(collateralAmount, 6), "USDC");
  console.log("Size:", ethers.formatUnits(sizeDeltaUsd, 30), "USD");
  console.log("Fee:", ethers.formatEther(executionFee), "ETH");
  console.log("Acceptable Price:", ethers.formatUnits(acceptablePrice, 12), "USD");
  console.log("Constructing Multicall...");

  console.log("Approving USDC...");
  const allowance = await usdc.allowance(myAddress, routerAddress);
  if (allowance < collateralAmount) {
    const approval = await usdc.approve(routerAddress, collateralAmount);
    await approval.wait();
    console.log("Approved.");
  } else {
    console.log("Approval already sufficient.");
  }

  const sendWntData = router.interface.encodeFunctionData("sendWnt", [
    orderVaultAddress,
    executionFee,
  ]);
  const sendTokensData = router.interface.encodeFunctionData("sendTokens", [
    usdcAddress,
    orderVaultAddress,
    collateralAmount,
  ]);
  const createOrderData = router.interface.encodeFunctionData("createOrder", [params]);

  console.log("Sending Transaction...");
  try {
    const nonce = await signer.getNonce("pending");
    try {
      await router.multicall.staticCall([sendWntData, sendTokensData, createOrderData], {
        value: executionFee,
      });
      console.log("Static call succeeded.");
    } catch (error: any) {
      console.error("Static call failed:", error.shortMessage || error.message);
      if (error.data) console.error("Error Data:", error.data);
      return;
    }
    const tx = await router.multicall([sendWntData, sendTokensData, createOrderData], {
      value: executionFee,
      gasLimit: 4000000,
      nonce,
    });

    console.log("Tx Hash:", tx.hash);
    await tx.wait();
    console.log("\nSUCCESS! Short Order Created.");
    console.log("Explorer: https://arbiscan.io/tx/" + tx.hash);
  } catch (error) {
    console.error("\nTransaction Failed:", error.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
