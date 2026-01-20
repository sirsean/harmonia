import { ethers } from "hardhat";
import { ARBITRUM_TOKENS } from "../../src/markets/registry";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const amount = process.env.AMOUNT || "1000000"; // 1,000,000 USDC
  const decimals = ARBITRUM_TOKENS.USDC.decimals;
  const approveAmount = ethers.parseUnits(amount, decimals);

  const [signer] = await ethers.getSigners();
  const usdc = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.USDC.address, signer);

  console.log("Approving vault for USDC...");
  const tx = await usdc.approve(vaultAddress, approveAmount);
  console.log("Tx hash:", tx.hash);
  await tx.wait();
  console.log("Approved:", amount, "USDC");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
