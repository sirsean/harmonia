import { ethers } from "hardhat";
import { getSignerAndAccount } from "../base";

export interface CheckBalanceOptions {
  account?: string;
}

export async function checkBalance(options: CheckBalanceOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  const balance = await ethers.provider.getBalance(account);
  console.log("Address:", account);
  console.log("Balance:", ethers.formatEther(balance), "ETH");
}
