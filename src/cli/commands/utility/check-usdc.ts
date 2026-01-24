import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { getSignerAndAccount } from "../base";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

export interface CheckUsdcOptions {
  account?: string;
}

export async function checkUsdc(options: CheckUsdcOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  const usdcAddress = ARBITRUM_MAINNET.usdc;
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, ethers.provider);
  const balance = await usdc.balanceOf(account);

  console.log("Address:", account);
  console.log("USDC Balance:", ethers.formatUnits(balance, 6));
}
