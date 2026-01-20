import { ethers } from "hardhat";
import { ARBITRUM_TOKENS } from "../../src/markets/registry";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const decimals = ARBITRUM_TOKENS.USDC.decimals;
  const rawAmount = process.env.DEPOSIT_AMOUNT || "600";
  const amount = ethers.parseUnits(rawAmount, decimals);
  const [signer] = await ethers.getSigners();

  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress, signer);

  try {
    const shares = await vault.deposit.staticCall(amount, await signer.getAddress());
    console.log(`staticCall success: shares=${shares.toString()}`);
  } catch (error) {
    const err = error as { data?: string; error?: { data?: string } };
    const data = err?.data || err?.error?.data;
    console.error("staticCall reverted.");
    if (data) {
      try {
        const parsed = vault.interface.parseError(data);
        console.error("Decoded error:", parsed?.name, parsed?.args);
      } catch {
        console.error("Revert data:", data);
      }
    } else {
      console.error(error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
