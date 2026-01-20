import { ethers, network } from "hardhat";
import { ARBITRUM_TOKENS } from "../../src/markets/registry";

async function main() {
  const hmAddress = process.env.HEDGE_MANAGER || "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const depositor = process.env.DEPOSITOR || "0x560EBafD8dB62cbdB44B50539d65b48072b98277";
  const acceptableDecimals = parseInt(process.env.ACCEPTABLE_DECIMALS || "12");
  const sizeUsd = BigInt(process.env.SIZE_USD || "200");
  const collateralUsd = BigInt(process.env.COLLATERAL_USD || "100");

  const sizeDeltaUsd = sizeUsd * 10n ** 30n;
  const collateralAmount = collateralUsd * 10n ** 6n;

  await network.provider.send("hardhat_mine", ["0x1"]);
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [depositor] });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [hmAddress] });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [vaultAddress] });
  await network.provider.send("hardhat_setBalance", [depositor, "0x56BC75E2D63100000"]);
  await network.provider.send("hardhat_setBalance", [hmAddress, "0x56BC75E2D63100000"]);
  await network.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);

  const depositorSigner = await ethers.getSigner(depositor);
  const hmSigner = await ethers.getSigner(hmAddress);
  const vaultSigner = await ethers.getSigner(vaultAddress);

  const usdc = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.USDC.address, depositorSigner);
  const hm = await ethers.getContractAt("HedgeManager", hmAddress, vaultSigner);
  const exchangeRouter = await ethers.getContractAt("IExchangeRouter", await hm.exchangeRouter(), hmSigner);

  console.log("Funding HM with collateral...");
  await (await usdc.transfer(hmAddress, collateralAmount)).wait();

  const priceFeed = await ethers.getContractAt("IChainlinkPriceFeed", await hm.priceFeed());
  const round = await priceFeed.latestRoundData();
  const oraclePrice = BigInt(round[1].toString()); // 8 decimals

  const price18 = oraclePrice * 10n ** 10n;
  let acceptablePrice: bigint;
  if (acceptableDecimals === 12) {
    acceptablePrice = (price18 * 10n ** 12n) / 10n ** 18n; // 12 decimals
  } else {
    acceptablePrice = (price18 * 10n ** 30n) / 10n ** 18n; // 30 decimals
  }

  const execFee = await hm.getExecutionFee();
  const orderVault = await hm.orderVault();
  const market = await hm.market();
  const collateralToken = await hm.collateralToken();

  const mode = process.env.MODE || "send";
  if (mode === "send") {
    console.log("Sending tokens + WNT via exchangeRouter...");
    await (await usdc.connect(hmSigner).approve(await hm.exchangeRouter(), collateralAmount)).wait();
    await (await exchangeRouter.sendTokens(collateralToken, orderVault, collateralAmount)).wait();
    await (await exchangeRouter.sendWnt(orderVault, execFee, { value: execFee })).wait();
  } else {
    console.log("Directly transferring collateral to orderVault...");
    await (await usdc.connect(hmSigner).transfer(orderVault, collateralAmount)).wait();
  }

  const params = {
    addresses: {
      receiver: vaultAddress,
      cancellationReceiver: hmAddress,
      callbackContract: ethers.ZeroAddress,
      uiFeeReceiver: ethers.ZeroAddress,
      market,
      initialCollateralToken: collateralToken,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: sizeDeltaUsd,
      initialCollateralDeltaAmount: collateralAmount,
      triggerPrice: 0,
      acceptablePrice: acceptablePrice,
      executionFee: execFee,
      callbackGasLimit: 0,
      minOutputAmount: 0,
      validFromTime: 0,
    },
    orderType: 2, // MarketIncrease
    decreasePositionSwapType: 0,
    isLong: false,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.ZeroHash,
    dataList: [],
  };

  console.log("Creating order with acceptable decimals:", acceptableDecimals);
  try {
    const tx = await exchangeRouter.createOrder(params, mode === "send" ? {} : { value: execFee });
    console.log("createOrder tx:", tx.hash);
    await tx.wait();
    console.log("createOrder succeeded.");
  } catch (error) {
    console.error("createOrder failed:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
