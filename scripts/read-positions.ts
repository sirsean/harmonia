import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";

// GMX Reader ABI (minimal for getAccountPositions)
const READER_ABI = [
  "function getAccountPositions(address dataStore, address account, uint256 start, uint256 end) view returns (tuple(tuple(address account, address market, address collateralToken) addresses, tuple(uint256 sizeInUsd, uint256 sizeInTokens, uint256 collateralAmount, uint256 borrowingFactor, uint256 fundingFeeAmountPerSize, uint256 longTokenClaimableFundingAmountPerSize, uint256 shortTokenClaimableFundingAmountPerSize, uint256 increasedAtBlock, uint256 decreasedAtBlock, uint256 increasedAtTime, uint256 decreasedAtTime) numbers, tuple(bool isLong) flags)[])",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const account = process.env.ACCOUNT || signer.address;
  const start = Number(process.env.START || "0");
  const end = Number(process.env.END || "10");
  const marketFilter = (process.env.MARKET || "").toLowerCase();

  const reader = new ethers.Contract(ARBITRUM_MAINNET.gmxReader, READER_ABI, ethers.provider);
  const positions = await reader.getAccountPositions(
    ARBITRUM_MAINNET.gmxDataStore,
    account,
    start,
    end
  );

  console.log("Reader:", ARBITRUM_MAINNET.gmxReader);
  console.log("Account:", account);
  console.log(`Range: ${start}..${end}`);
  console.log("Positions:", positions.length);

  for (const position of positions) {
    const addresses = position.addresses;
    const numbers = position.numbers;
    const flags = position.flags;

    if (marketFilter && addresses.market.toLowerCase() !== marketFilter) {
      continue;
    }

    console.log("\nMarket:", addresses.market);
    console.log("Collateral:", addresses.collateralToken);
    console.log("Is Long:", flags.isLong);
    console.log("Size (USD):", ethers.formatUnits(numbers.sizeInUsd, 30));
    console.log("Size (Tokens):", ethers.formatUnits(numbers.sizeInTokens, 18));
    console.log("Collateral Amount:", ethers.formatUnits(numbers.collateralAmount, 6));
    console.log("Increased At:", numbers.increasedAtTime?.toString?.() || "0");
    console.log("Decreased At:", numbers.decreasedAtTime?.toString?.() || "0");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
