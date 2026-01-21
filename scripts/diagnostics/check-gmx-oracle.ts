import { ethers } from "hardhat";

async function main() {
  const hedgeManagerAddress = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";
  const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);
  
  // GMX V2 Contracts on Arbitrum
  const exchangeRouterAddress = await hm.exchangeRouter();
  const exchangeRouter = await ethers.getContractAt("IExchangeRouter", exchangeRouterAddress);
  const dataStoreAddress = await exchangeRouter.dataStore();
  const dataStore = await ethers.getContractAt("IDataStore", dataStoreAddress);
  
  const marketAddress = await hm.market();
  console.log("Market:", marketAddress);
  
  // Try to get market info to verify tokens
  // IReader is needed.
  // We can try to guess Reader address or find it.
  // Reader is usually public.
  // 0x60... on Arbitrum?
  
  // Instead, let's just get the price of ETH from Chainlink and compare with what we think.
  const priceFeedAddress = await hm.priceFeed();
  const feed = await ethers.getContractAt("IChainlinkPriceFeed", priceFeedAddress);
  const [, answer] = await feed.latestRoundData();
  const decimals = await feed.decimals();
  console.log("Chainlink Price:", ethers.formatUnits(answer, decimals));
  
  // We can't easily query GMX internal oracle price without the Reader and signed params.
  // But we can check if the contract we use (HedgeManager) is calculating acceptablePrice correctly.
  
  // Let's assume the HedgeManager is correct about 12 decimals if the user said so.
  // But "Price slippage check" implies failure.
  
  // Let's look at the failing call again.
  // We are calling performUpkeep -> rebalance -> adjustHedge -> openShort/increaseShort -> createOrder.
  
  console.log("Checking createOrder params alignment...");
  // We can't verify alignment from outside.
  
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
