import { ethers } from "hardhat";

const TX_HASH = process.env.TX_HASH || "0x5a90ca46b34743d75a845b7a9dd4348a87ccc6c2daaaa42fe307bd37a7e6fc08";

async function main() {
  console.log("=== Transaction Trace ===");
  console.log("TX Hash:", TX_HASH);
  console.log("");

  // Get transaction receipt
  const receipt = await ethers.provider.getTransactionReceipt(TX_HASH);
  console.log("Status:", receipt?.status === 1 ? "SUCCESS" : "FAILED");
  console.log("Gas used:", receipt?.gasUsed.toString());
  console.log("Block:", receipt?.blockNumber);
  console.log("Logs count:", receipt?.logs.length);

  if (receipt?.logs && receipt.logs.length > 0) {
    console.log("\n=== Logs ===");
    for (const log of receipt.logs) {
      console.log("Address:", log.address);
      console.log("Topics:", log.topics);
      console.log("Data:", log.data);
      console.log("---");
    }
  }

  // Get transaction details
  const tx = await ethers.provider.getTransaction(TX_HASH);
  console.log("\n=== Transaction ===");
  console.log("From:", tx?.from);
  console.log("To:", tx?.to);
  console.log("Data:", tx?.data?.slice(0, 50) + "...");

  // Try debug_traceTransaction (might not be available on all providers)
  console.log("\n=== Attempting trace ===");
  try {
    const trace = await ethers.provider.send("debug_traceTransaction", [
      TX_HASH,
      { tracer: "callTracer" }
    ]);
    console.log("Trace result:");
    console.log(JSON.stringify(trace, null, 2).slice(0, 5000));
  } catch (e: any) {
    console.log("debug_traceTransaction not available:", e.message);
  }

  // Try eth_call with block to replay
  console.log("\n=== Attempting replay ===");
  if (tx && receipt) {
    try {
      await ethers.provider.call(
        {
          to: tx.to,
          from: tx.from,
          data: tx.data,
          gasLimit: tx.gasLimit,
        },
        receipt.blockNumber - 1
      );
      console.log("Replay succeeded (unexpected for failed tx)");
    } catch (e: any) {
      console.log("Replay error:", e.message);
      if (e.data) {
        console.log("Error data:", e.data);
      }
      // Try to decode
      if (e.data && e.data !== "0x") {
        const commonErrors = new ethers.Interface([
          "error EnforcedPause()",
          "error OnlyVault()",
          "error Unauthorized(address)",
          "error ZeroAmount()",
          "error InsufficientExecutionFee()",
          "error PositionTooSmall()",
          "error NoPosition()",
          "error SlippageTooHigh()",
          "error DeadlineExpired()",
          "error TWAPDeviationTooHigh(uint256,uint256,uint256)",
          "error InvalidTickRange()",
          "error OracleStale(uint256,uint256)",
          "error PositionExists()",
          "error CircuitBreakerActive()",
        ]);

        try {
          const decoded = commonErrors.parseError(e.data);
          console.log("Decoded error:", decoded?.name, decoded?.args);
        } catch {
          // Couldn't decode with common errors
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
