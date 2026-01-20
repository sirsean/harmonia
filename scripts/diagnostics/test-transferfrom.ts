import { ethers, network } from "hardhat";
import { ARBITRUM_TOKENS } from "../../src/markets/registry";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const depositor = process.env.DEPOSITOR || "0x560EBafD8dB62cbdB44B50539d65b48072b98277";
  const lmAddress = process.env.LIQUIDITY_MANAGER || "0x0aa77E5CE038c878A5d2704A6C18b53cD7d855De";
  const rawAmount = process.env.AMOUNT || "600";
  const amount = ethers.parseUnits(rawAmount, ARBITRUM_TOKENS.USDC.decimals);

  await network.provider.send("hardhat_mine", ["0x1"]);
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [vaultAddress] });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [lmAddress] });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [depositor] });
  await network.provider.send("hardhat_setBalance", [lmAddress, "0x56BC75E2D63100000"]);
  await network.provider.send("hardhat_setBalance", [depositor, "0x56BC75E2D63100000"]);

  const depositorSigner = await ethers.getSigner(depositor);
  const lmSigner = await ethers.getSigner(lmAddress);
  const usdcDepositor = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.USDC.address, depositorSigner);
  const usdc = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.USDC.address, lmSigner);

  console.log("Transferring USDC to vault...");
  const transferTx = await usdcDepositor.transfer(vaultAddress, amount);
  await transferTx.wait();

  const vaultBalance = await usdc.balanceOf(vaultAddress);
  console.log("Vault USDC balance:", ethers.formatUnits(vaultBalance, ARBITRUM_TOKENS.USDC.decimals));

  console.log("Attempting transferFrom vault -> LM...");
  try {
    const tx = await usdc.transferFrom(vaultAddress, lmAddress, amount);
    console.log("Tx:", tx.hash);
    await tx.wait();
    console.log("transferFrom succeeded");
  } catch (error) {
    console.error("transferFrom failed:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
