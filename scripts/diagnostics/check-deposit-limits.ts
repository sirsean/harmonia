import { ethers } from "hardhat";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
  const [signer] = await ethers.getSigners();
  const signerAddress = await signer.getAddress();

  try {
    const maxDeposit = await vault.maxDeposit(signerAddress);
    console.log("maxDeposit:", maxDeposit.toString());
  } catch (error) {
    console.error("maxDeposit error:", error);
  }

  try {
    const preview = await vault.previewDeposit(ethers.parseUnits("600", 6));
    console.log("previewDeposit(600):", preview.toString());
  } catch (error) {
    console.error("previewDeposit error:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
