import { ethers } from "hardhat";
import { ARBITRUM_TOKENS } from "../src/markets/registry";

async function main() {
  // Config
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const usdcAddress = ARBITRUM_TOKENS.USDC.address;
  const decimals = ARBITRUM_TOKENS.USDC.decimals;
  
  // Parse amount from args or env (default 1000 USDC)
  // Usage: DEPOSIT_AMOUNT=500 npx hardhat run scripts/deposit.ts --network arbitrum
  const rawAmount = process.env.DEPOSIT_AMOUNT || "1000";
  const amount = ethers.parseUnits(rawAmount, decimals);

  const [signer] = await ethers.getSigners();
  const signerAddress = await signer.getAddress();

  console.log("\n" + "=".repeat(60));
  console.log("HARMONIA DEPOSIT SCRIPT");
  console.log("=".repeat(60) + "\n");
  
  console.log("Signer:", signerAddress);
  console.log("Vault:", vaultAddress);
  console.log("USDC:", usdcAddress);
  console.log("Amount:", rawAmount, "USDC");
  console.log("");

  // Connect to contracts
  const usdc = await ethers.getContractAt("IERC20", usdcAddress, signer);
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress, signer);

  // Check Balance
  const balance = await usdc.balanceOf(signerAddress);
  console.log("Current USDC Balance:", ethers.formatUnits(balance, decimals));

  if (balance < amount) {
    console.error("Error: Insufficient USDC balance!");
    console.log("Required:", ethers.formatUnits(amount, decimals));
    console.log("Available:", ethers.formatUnits(balance, decimals));
    process.exit(1);
  }

  // Check Allowance
  const allowance = await usdc.allowance(signerAddress, vaultAddress);
  console.log("Current Allowance:", ethers.formatUnits(allowance, decimals));

  if (allowance < amount) {
    console.log("Approving vault to spend USDC...");
    const tx = await usdc.approve(vaultAddress, amount);
    console.log("  Tx Hash:", tx.hash);
    await tx.wait();
    console.log("  Approval confirmed.");
  } else {
    console.log("  Allowance sufficient.");
  }

  // Deposit
  console.log("\nDepositing USDC...");
  const depositTx = await vault.deposit(amount, signerAddress);
  console.log("  Tx Hash:", depositTx.hash);
  
  console.log("  Waiting for confirmation...");
  const receipt = await depositTx.wait();
  
  console.log("\nDeposit Successful!");
  
  // Verify Shares
  const shares = await vault.balanceOf(signerAddress);
  console.log("Vault Shares Received:", ethers.formatUnits(shares, 18)); // Vault shares are 18 decimals usually? Let's check.
  // ERC4626 standard usually matches asset decimals for shares unless specified otherwise, 
  // but Harmonia Vault initializes ERC20 with default 18 decimals?
  // DeltaNeutralVault is ERC20Upgradeable which defaults to 18.
  // Let's assume 18 for now, or check contract decimals.
  const vaultDecimals = await vault.decimals();
  console.log(`Vault Shares Received (formatted): ${ethers.formatUnits(shares, vaultDecimals)} hETH`);

  console.log("\n" + "=".repeat(60));
}

main().catch((error) => {
  console.error("\nDeposit failed:", error);
  process.exit(1);
});
