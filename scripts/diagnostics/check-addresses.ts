import { ethers } from "hardhat";

const VAULT_ADDRESS = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";

async function main() {
  const vault = await ethers.getContractAt("DeltaNeutralVault", VAULT_ADDRESS);
  const lmAddress = await vault.liquidityManager();
  const lm = await ethers.getContractAt("LiquidityManager", lmAddress);

  const asset = await vault.asset();
  const quoteToken = await lm.quoteToken();
  const baseToken = await lm.baseToken();

  console.log("Vault Asset: ", asset);
  console.log("LM Quote:    ", quoteToken);
  console.log("LM Base:     ", baseToken);

  console.log("Asset == Quote?", asset.toLowerCase() === quoteToken.toLowerCase());
  console.log("Asset == Base? ", asset.toLowerCase() === baseToken.toLowerCase());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
