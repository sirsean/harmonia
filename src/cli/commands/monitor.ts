import { Command } from "commander";
import { addCommonOptions } from "./base";
import { monitor } from "./monitor-impl";

/**
 * Register the monitor command
 */
export function registerMonitorCommand(program: Command): void {
  addCommonOptions(
    program
      .command("monitor")
      .description("Monitor delta-neutral position status and health")
      .option("--token-id <id>", "Uniswap token ID to monitor (monitors all if not specified)")
      .option("--min-fee-threshold <amount>", "Minimum fee threshold in USD (default: 10)", "10")
      .action(async (options) => {
        await monitor({
          account: options.account,
          tokenId: options.tokenId,
          minFeeThreshold: options.minFeeThreshold,
        });
      })
  );
}
