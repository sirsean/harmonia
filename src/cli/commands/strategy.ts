import { Command } from "commander";
import { addCommonOptions } from "./base";
import { monitorPosition } from "./strategy/monitor-position";
import { executeOptimize } from "./strategy/execute-optimize";
import { closeAll } from "./strategy/close-all";
import {
  clearStrategyParam,
  setAutoTuning,
  setStrategyParam,
  showStrategyParamHistory,
  showStrategyParams,
} from "./strategy/params";

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
      .option("--db-path <path>", "SQLite DB path for runtime parameters")
      .option("--execute", "Actually execute the transaction (default: dry-run)", false)
      .action(async (options) => {
        await executeOptimize({
          account: options.account,
          tokenId: options.tokenId,
          rangeWidth: options.rangeWidth ? Number(options.rangeWidth) : undefined,
          priceLower: options.priceLower ? Number(options.priceLower) : undefined,
          priceUpper: options.priceUpper ? Number(options.priceUpper) : undefined,
          slippageBps: options.slippageBps ? BigInt(options.slippageBps) : undefined,
          dbPath: options.dbPath,
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

  const params = strategy.command("params").description("Manage runtime strategy parameters");

  addCommonOptions(
    params
      .command("show")
      .description("Show effective runtime strategy parameters")
      .option("--global", "Show global scope parameters only", false)
      .option("--db-path <path>", "SQLite DB path")
      .action(async (options) => {
        await showStrategyParams({
          account: options.account,
          global: options.global ?? false,
          dbPath: options.dbPath,
        });
      })
  );

  addCommonOptions(
    params
      .command("set")
      .description("Set a runtime strategy parameter")
      .requiredOption("--key <key>", "Runtime strategy parameter key")
      .requiredOption("--value <value>", "Numeric parameter value")
      .option("--ttl <seconds>", "Optional TTL in seconds")
      .option("--reason <text>", "Reason for the update")
      .option("--global", "Write to global scope", false)
      .option("--db-path <path>", "SQLite DB path")
      .action(async (options) => {
        await setStrategyParam({
          account: options.account,
          key: options.key,
          value: options.value,
          ttl: options.ttl !== undefined ? Number(options.ttl) : undefined,
          reason: options.reason,
          global: options.global ?? false,
          dbPath: options.dbPath,
        });
      })
  );

  addCommonOptions(
    params
      .command("clear")
      .description("Clear a runtime strategy parameter")
      .requiredOption("--key <key>", "Runtime strategy parameter key")
      .option("--reason <text>", "Reason for clearing the parameter")
      .option("--global", "Clear from global scope", false)
      .option("--db-path <path>", "SQLite DB path")
      .action(async (options) => {
        await clearStrategyParam({
          account: options.account,
          key: options.key,
          reason: options.reason,
          global: options.global ?? false,
          dbPath: options.dbPath,
        });
      })
  );

  addCommonOptions(
    params
      .command("history")
      .description("Show runtime strategy parameter history")
      .option("--key <key>", "Filter by parameter key")
      .option("--limit <n>", "Maximum history rows", "50")
      .option("--global", "Show global scope history", false)
      .option("--db-path <path>", "SQLite DB path")
      .action(async (options) => {
        await showStrategyParamHistory({
          account: options.account,
          key: options.key,
          limit: options.limit ? Number(options.limit) : undefined,
          global: options.global ?? false,
          dbPath: options.dbPath,
        });
      })
  );

  addCommonOptions(
    params
      .command("auto")
      .description("Enable or disable auto-tuning")
      .option("--enable", "Enable auto-tuning", false)
      .option("--disable", "Disable auto-tuning", false)
      .option("--reason <text>", "Reason for this change")
      .option("--global", "Update global scope", false)
      .option("--db-path <path>", "SQLite DB path")
      .action(async (options) => {
        await setAutoTuning({
          account: options.account,
          enable: options.enable ?? false,
          disable: options.disable ?? false,
          reason: options.reason,
          global: options.global ?? false,
          dbPath: options.dbPath,
        });
      })
  );
}
