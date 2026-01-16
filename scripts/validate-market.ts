/**
 * Market Validation Script
 *
 * Validates a market configuration to ensure all components are properly
 * configured and compatible.
 *
 * Usage:
 *   npx hardhat run scripts/validate-market.ts
 *   MARKET=ETH npx hardhat run scripts/validate-market.ts
 *   MARKET=BTC npx hardhat run scripts/validate-market.ts
 */

import { ethers } from "hardhat";
import { getMarketConfig, getAvailableMarkets, MARKET_REGISTRY } from "../src/markets/registry";
import { MarketValidator, printValidationSummary } from "../src/markets/validator";

async function main() {
  const marketId = process.env.MARKET || "ETH";

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║           HARMONIA MARKET VALIDATION TOOL                  ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  // If "ALL" specified, validate all markets
  if (marketId.toUpperCase() === "ALL") {
    await validateAllMarkets();
    return;
  }

  // Get market config
  const config = getMarketConfig(marketId);

  if (!config) {
    console.error(`\nError: Unknown market "${marketId}"`);
    console.log(`\nAvailable markets: ${getAvailableMarkets().join(", ")}`);
    process.exit(1);
  }

  console.log(`\nValidating market: ${config.name}`);
  console.log(`Chain ID: ${config.chainId}`);

  // Create validator
  const provider = ethers.provider;
  const validator = new MarketValidator(provider);

  // Run validation
  const result = await validator.validateMarket(config);

  // Print summary
  printValidationSummary(result);

  // Exit with appropriate code
  process.exit(result.isValid ? 0 : 1);
}

async function validateAllMarkets() {
  console.log("\nValidating all configured markets...\n");

  const provider = ethers.provider;
  const validator = new MarketValidator(provider);

  const results: { market: string; valid: boolean }[] = [];

  for (const [id, config] of Object.entries(MARKET_REGISTRY)) {
    console.log(`\n${"─".repeat(60)}`);
    const result = await validator.validateMarket(config);
    results.push({ market: id, valid: result.isValid });
  }

  // Print final summary
  console.log("\n" + "═".repeat(60));
  console.log("FINAL SUMMARY");
  console.log("═".repeat(60));

  const validCount = results.filter((r) => r.valid).length;
  console.log(`\nTotal: ${results.length} markets`);
  console.log(`Valid: ${validCount}`);
  console.log(`Invalid: ${results.length - validCount}`);

  console.log("\nResults:");
  results.forEach((r) => {
    console.log(`  ${r.valid ? "✓" : "✗"} ${r.market}`);
  });

  process.exit(validCount === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
