import { Command } from "commander";
import { addCommonOptions } from "./base";
import { generateReport } from "./report-impl";

/**
 * Register the report command
 */
export function registerReportCommand(program: Command): void {
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
}
