import { Command } from "commander";
import { addCommonOptions } from "./base";
import { analyzeLoss } from "./analysis/analyze-loss";
import { analyzeRangeSize } from "./analysis/analyze-range-size";
import { analyzeSlippage } from "./analysis/analyze-slippage";
import { slippageAnalysisReport } from "./analysis/slippage-analysis-report";

/**
 * Register all analysis commands
 */
export function registerAnalysisCommands(program: Command): void {
  const analysis = program.command("analyze").description("Analysis and reporting commands");

  // Analyze loss
  addCommonOptions(
    analysis
      .command("loss")
      .description("Analyze potential loss scenarios")
      .action(async (options) => {
        await analyzeLoss({
          account: options.account,
        });
      })
  );

  // Analyze range size
  addCommonOptions(
    analysis
      .command("range-size")
      .description("Analyze range size for positions")
      .action(async (options) => {
        await analyzeRangeSize({
          account: options.account,
        });
      })
  );

  // Analyze slippage
  addCommonOptions(
    analysis
      .command("slippage")
      .description("Analyze slippage for operations")
      .action(async (options) => {
        await analyzeSlippage({
          account: options.account,
        });
      })
  );

  // Slippage analysis report
  addCommonOptions(
    analysis
      .command("slippage-report")
      .description("Generate slippage analysis report")
      .action(async (options) => {
        await slippageAnalysisReport({
          account: options.account,
        });
      })
  );
}
