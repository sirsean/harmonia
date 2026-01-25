import { Command } from "commander";
import { addCommonOptions } from "./base";
import { daemon } from "./daemon-impl";

/**
 * Register the daemon command
 */
export function registerDaemonCommand(program: Command): void {
  addCommonOptions(
    program
      .command("daemon")
      .description("Run automated monitoring daemon that continuously tracks strategy metrics")
      .option("--interval <seconds>", "Monitoring interval in seconds (default: 60)", "60")
      .option("--db-path <path>", "Custom database path (default: ./data/monitoring.db)")
      .action(async (options) => {
        await daemon({
          account: options.account,
          interval: parseInt(options.interval, 10),
          dbPath: options.dbPath,
        });
      })
  );
}
