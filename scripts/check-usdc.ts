import { ethers, network } from "hardhat";
import { ARBITRUM_MAINNET } from "./config/addresses";

async function main() {
  const [signer] = await ethers.getSigners();
  const usdcAddress = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // Native USDC on Arbitrum
  const usdc = await ethers.getContractAt("IERC20", usdcAddress, signer);
  const balance = await usdc.balanceOf(signer.address);
  
  console.log("Address:", signer.address);
  console.log("USDC Balance:", ethers.formatUnits(balance, 6));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
