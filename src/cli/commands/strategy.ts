import { Command } from "commander";
import { addCommonOptions } from "./base";
import { monitorPosition } from "./strategy/monitor-position";
import { executeOptimize } from "./strategy/execute-optimize";
import { closeAll } from "./strategy/close-all";

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

  // Execute optimize (always resets position)
  addCommonOptions(
    strategy
      .command("optimize")
      .description(
        "Optimize strategy position: collect fees, recenter LP, optimize hedge (always executes regardless of status)"
      )
      .option("--token-id <id>", "Uniswap token ID")
      .option("--range-width <number>", "Range width (e.g., 0.2 for 20%)")
      .option("--price-lower <number>", "Lower price bound")
      .option("--price-upper <number>", "Upper price bound")
      .option("--slippage-bps <number>", "Slippage tolerance in basis points", "50")
      .option("--execute", "Actually execute the transaction (default: dry-run)", false)
      .action(async (options) => {
        await executeOptimize({
          account: options.account,
          tokenId: options.tokenId,
          rangeWidth: options.rangeWidth ? Number(options.rangeWidth) : undefined,
          priceLower: options.priceLower ? Number(options.priceLower) : undefined,
          priceUpper: options.priceUpper ? Number(options.priceUpper) : undefined,
          slippageBps: options.slippageBps ? BigInt(options.slippageBps) : undefined,
          execute: options.execute ?? false,
        });
      })
  );

  // Close all positions
  addCommonOptions(
    strategy
      .command("close")
      .description("Close all strategy positions: Uniswap LP and GMX short (dry-run by default)")
      .option("--token-id <id>", "Uniswap token ID to close (default: all positions)")
      .option("--execute", "Actually execute the transaction (default: dry-run)", false)
      .action(async (options) => {
        await closeAll({
          account: options.account,
          tokenId: options.tokenId,
          execute: options.execute ?? false,
        });
      })
  );
}
