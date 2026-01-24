import { Command } from "commander";
import { addCommonOptions } from "./base";
import { monitorPosition } from "./strategy/monitor-position";
import { executeRebalance } from "./strategy/execute-rebalance";
import { executeAdjustRange } from "./strategy/execute-adjust-range";

/**
 * Register all strategy commands
 */
export function registerStrategyCommands(program: Command): void {
  const strategy = program.command("strategy").description("Strategy execution commands");

  // Monitor position
  addCommonOptions(
    strategy
      .command("monitor")
      .description("Monitor delta-neutral position status")
      .option("--token-id <id>", "Uniswap token ID to monitor")
      .action(async (options) => {
        await monitorPosition({
          account: options.account,
          tokenId: options.tokenId,
        });
      })
  );

  // Execute rebalance
  addCommonOptions(
    strategy
      .command("rebalance")
      .description("Execute rebalance operation")
      .option("--token-id <id>", "Uniswap token ID")
      .option("--dry-run", "Perform dry run without executing", false)
      .action(async (options) => {
        await executeRebalance({
          account: options.account,
          tokenId: options.tokenId,
          dryRun: options.dryRun ?? false,
        });
      })
  );

  // Execute adjust range
  addCommonOptions(
    strategy
      .command("adjust-range")
      .description("Execute range adjustment")
      .option("--token-id <id>", "Uniswap token ID")
      .option("--range-width <number>", "Range width (e.g., 0.2 for 20%)")
      .option("--price-lower <number>", "Lower price bound")
      .option("--price-upper <number>", "Upper price bound")
      .option("--slippage-bps <number>", "Slippage tolerance in basis points", "50")
      .option("--dry-run", "Perform dry run without executing", false)
      .action(async (options) => {
        await executeAdjustRange({
          account: options.account,
          tokenId: options.tokenId,
          rangeWidth: options.rangeWidth ? Number(options.rangeWidth) : undefined,
          priceLower: options.priceLower ? Number(options.priceLower) : undefined,
          priceUpper: options.priceUpper ? Number(options.priceUpper) : undefined,
          slippageBps: options.slippageBps ? BigInt(options.slippageBps) : undefined,
          dryRun: options.dryRun ?? false,
        });
      })
  );
}
