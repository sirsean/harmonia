import { ethers } from "hardhat";

const DEFAULT_VAULT = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || DEFAULT_VAULT;
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const send = process.env.SEND === "1" || process.env.SEND === "true";

  console.log("=== Send Compound Transaction ===");
  console.log("Vault:", vaultAddress);
  console.log("Mode:", dryRun ? "DRY RUN" : send ? "SEND" : "CHECK ONLY");
  console.log("");

  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);

  // Check state
  const [paused, circuitBreaker, idle, asset] = await Promise.all([
    vault.paused(),
    vault.circuitBreakerTriggered(),
    ethers.getContractAt("IERC20", await vault.asset()).then(t => t.balanceOf(vaultAddress)),
    vault.asset(),
  ]);

  console.log("Vault paused:", paused);
  console.log("Circuit breaker:", circuitBreaker);
  console.log("Idle assets:", ethers.formatUnits(idle, 6), "USDC");

  if (paused) {
    console.log("\nCannot compound - vault is paused");
    return;
  }

  if (idle === 0n) {
    console.log("\nNothing to compound - no idle assets");
    return;
  }

  // Try estimate gas
  console.log("\n=== Gas Estimation ===");
  try {
    const gasEstimate = await vault.compound.estimateGas();
    console.log("Gas estimate:", gasEstimate.toString());
  } catch (e: any) {
    console.log("Gas estimation FAILED");
    console.log("Error:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
    }
    if (e.error?.data) {
      console.log("Inner error data:", e.error.data);
    }
    if (e.info?.error?.data) {
      console.log("Info error data:", e.info.error.data);
    }

    // Try to decode the error
    if (e.data && e.data !== "0x") {
      try {
        // Common errors interface
        const iface = new ethers.Interface([
          "error EnforcedPause()",
          "error OnlyVault()",
          "error Unauthorized(address)",
          "error ZeroAmount()",
          "error InsufficientExecutionFee()",
          "error PositionTooSmall()",
          "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
          "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
        ]);
        const decoded = iface.parseError(e.data);
        if (decoded) {
          console.log("Decoded error:", decoded.name, decoded.args);
        }
      } catch {
        // Couldn't decode
      }
    }
    console.log("\nContinuing with explicit gas limit despite estimation failure...");
  }

  // Dry run
  if (dryRun) {
    console.log("\n=== Dry Run ===");
    try {
      await vault.compound.staticCall();
      console.log("compound() staticCall: SUCCESS");
    } catch (e: any) {
      console.log("compound() staticCall: FAILED");
      console.log("Error:", e.message);
    }
    return;
  }

  // Actually send
  if (!send) {
    console.log("\nSet SEND=1 to actually send the transaction");
    console.log("Set DRY_RUN=1 to simulate");
    return;
  }

  console.log("\n=== Sending Transaction ===");
  try {
    // Use explicit gas limit to bypass gas estimation
    const tx = await vault.compound({ gasLimit: 5000000 });
    console.log("Transaction hash:", tx.hash);

    const receipt = await tx.wait();
    console.log("Confirmed in block:", receipt?.blockNumber);
    console.log("Gas used:", receipt?.gasUsed?.toString());
    console.log("Status:", receipt?.status === 1 ? "SUCCESS" : "FAILED");

    // Parse events
    if (receipt?.logs) {
      console.log("\n=== Events ===");
      for (const log of receipt.logs) {
        try {
          const parsed = vault.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (parsed) {
            console.log(`${parsed.name}:`, parsed.args);
          }
        } catch {
          // Not a vault event
        }
      }
    }
  } catch (e: any) {
    console.log("Transaction FAILED");
    console.log("Error:", e.message);
    if (e.receipt) {
      console.log("Receipt status:", e.receipt.status);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
