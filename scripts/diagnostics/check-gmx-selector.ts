import { ethers } from "hardhat";

async function main() {
  console.log("=== Checking GMX createOrder Function Selector ===\n");

  const EXCHANGE_ROUTER = "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41";

  // Function selectors
  const SELECTOR_WITH_VALIDFROMTIME = "0xf59c48eb";
  const SELECTOR_WITHOUT_VALIDFROMTIME = "0xf91bb758";

  // Get the contract code
  const code = await ethers.provider.getCode(EXCHANGE_ROUTER);
  console.log("Contract code length:", code.length);

  // Check if selectors are in the code
  // Note: This is a heuristic - selectors appear in PUSH4 instructions
  const withSelector = code.toLowerCase().includes(SELECTOR_WITH_VALIDFROMTIME.slice(2).toLowerCase());
  const withoutSelector = code.toLowerCase().includes(SELECTOR_WITHOUT_VALIDFROMTIME.slice(2).toLowerCase());

  console.log("\nSelector presence in bytecode:");
  console.log("  With validFromTime (0xf59c48eb):", withSelector ? "FOUND" : "NOT FOUND");
  console.log("  Without validFromTime (0xf91bb758):", withoutSelector ? "FOUND" : "NOT FOUND");

  // Error selector from our test
  console.log("\n=== Decoding Error ===");
  const errorData = "0x3a78cd7e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002386f26fc10000";
  const errorSelector = errorData.slice(0, 10);
  console.log("Error selector:", errorSelector);

  // Try to decode the error data
  // GMX uses custom errors. Let's try to decode this.
  // 0x3a78cd7e appears to be InsufficientWntAmountForExecutionFee(uint256 wntAmount, uint256 executionFee)
  try {
    const errorInterface = new ethers.Interface([
      "error InsufficientWntAmountForExecutionFee(uint256 wntAmount, uint256 executionFee)",
    ]);
    const decoded = errorInterface.parseError(errorData);
    console.log("\nDecoded error: InsufficientWntAmountForExecutionFee");
    console.log("  WNT amount:", decoded?.args[0].toString(), "=", ethers.formatEther(decoded?.args[0] || 0), "ETH");
    console.log("  Execution fee:", decoded?.args[1].toString(), "=", ethers.formatEther(decoded?.args[1] || 0), "ETH");
  } catch (e) {
    console.log("Could not decode as InsufficientWntAmountForExecutionFee");
  }

  // Check what the actual createOrder selector should be by looking at a working tx
  console.log("\n=== What this means ===");
  console.log("If GMX requires validFromTime in CreateOrderParamsNumbers:");
  console.log("1. Our interface is missing the field");
  console.log("2. Our calls use the wrong function selector");
  console.log("3. GMX will reject our calls or misinterpret the data");
  console.log("");
  console.log("The error shows that the call is getting through but:");
  console.log("- WNT amount (ETH sent for fee) = 0");
  console.log("- Required execution fee = 0.01 ETH");
  console.log("");
  console.log("This could mean the struct encoding is shifted and GMX is");
  console.log("reading the wrong field for the execution fee.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
