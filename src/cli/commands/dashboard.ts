import { Command } from "commander";
import { addCommonOptions } from "./base";
import { dashboard } from "./dashboard-impl";

/**
 * Register the dashboard command
 */
export function registerDashboardCommand(program: Command): void {
  addCommonOptions(
    program
      .command("dashboard")
      .description("Display real-time terminal dashboard for strategy monitoring")
      .option("--refresh-interval <seconds>", "Refresh interval in seconds (default: 30)", "30")
      .option("--no-refresh", "Run once and exit (no auto-refresh)")
      .action(async (options) => {
        await dashboard({
          account: options.account,
          refreshInterval: parseInt(options.refreshInterval, 10),
          autoRefresh: options.refresh === undefined ? true : options.refresh,
        });
      })
  );
}
