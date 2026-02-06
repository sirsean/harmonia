import { Command } from "commander";
import { addCommonOptions } from "./base";
import { generateReport, generateAPRReport, generateCapitalBandsReport } from "./report-impl";

/**
 * Register the report command
 */
export function registerReportCommand(program: Command): void {
  // Main report command (daily report)
  addCommonOptions(
    program
      .command("report")
      .description("Generate daily position performance and health report")
      .option("--date <date>", "Generate report for specific date (YYYY-MM-DD, defaults to today)")
      .option("--reports-dir <path>", "Custom reports directory (default: ./reports)")
      .action(async (options) => {
        await generateReport({
          account: options.account,
          date: options.date,
          reportsDir: options.reportsDir,
        });
      })
  );

  // Separate APR command
  addCommonOptions(
    program
      .command("apr")
      .description("Calculate and display APR metrics")
      .option("--period <period>", "Time period: 1d, 7d, 30d, 90d, or lifetime (default: 30d)")
      .action(async (options) => {
        await generateAPRReport({
          account: options.account,
          period: options.period || "30d",
        });
      })
  );

  addCommonOptions(
    program
      .command("capital-bands")
      .description("Estimate break-even capital and scaling effects from recent performance")
      .option("--window-hours <hours>", "Lookback window in hours (default: 24)")
      .option("--db-path <path>", "Custom monitoring database path")
      .option("--include-eth", "Include native ETH wallet value in capital/PnL calculations")
      .option(
        "--allocations <csv>",
        "Comma-separated allocation USD values (e.g., 500,1000,2500,5000)"
      )
      .option(
        "--hedge-gas-usd <usd>",
        "Override per-hedge gas cost assumption in USD (defaults to observed optimization average)"
      )
      .option(
        "--hedge-exec-fee-usd <usd>",
        "Override per-hedge GMX execution fee assumption in USD (defaults to observed optimization average)"
      )
      .action(async (options) => {
        await generateCapitalBandsReport({
          account: options.account,
          windowHours: options.windowHours ? Number(options.windowHours) : undefined,
          dbPath: options.dbPath,
          includeEth: Boolean(options.includeEth),
          allocations: options.allocations,
          hedgeGasUsd: options.hedgeGasUsd,
          hedgeExecFeeUsd: options.hedgeExecFeeUsd,
        });
      })
  );
}
