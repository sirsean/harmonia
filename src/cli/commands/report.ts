import { Command } from "commander";
import { addCommonOptions } from "./base";
import { generateReport, generateAPRReport } from "./report-impl";

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
      .option("--period <period>", "Time period: 7d, 30d, 90d, or lifetime (default: 30d)")
      .action(async (options) => {
        await generateAPRReport({
          account: options.account,
          period: options.period || "30d",
        });
      })
  );
}
