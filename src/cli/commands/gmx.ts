import { Command } from "commander";
import { addCommonOptions } from "./base";
import { gmxReadPosition } from "./gmx/read-position";
import { gmxOpenShort } from "./gmx/open-short";
import { gmxCloseShort } from "./gmx/close-short";
import { gmxReadOrders } from "./gmx/read-orders";
import { gmxReadOrder } from "./gmx/read-order";

/**
 * Register all GMX-related commands
 */
export function registerGmxCommands(program: Command): void {
  const gmx = program.command("gmx").description("GMX v2 perpetual operations");

  // Read positions
  addCommonOptions(
    gmx
      .command("read-position")
      .alias("positions")
      .description("Read GMX positions for an account")
      .option("-s, --start <number>", "Start index", "0")
      .option("-e, --end <number>", "End index", "10")
      .option("-m, --market <address>", "Filter by market address")
      .option("--maintenance-margin-bps <number>", "Maintenance margin basis points", "100")
      .action(async (options) => {
        await gmxReadPosition({
          account: options.account,
          start: parseInt(options.start, 10),
          end: parseInt(options.end, 10),
          market: options.market,
          maintenanceMarginBps: BigInt(options.maintenanceMarginBps || "100"),
        });
      })
  );

  // Open short position
  addCommonOptions(
    gmx
      .command("open-short")
      .description("Open a GMX short position (dry-run by default)")
      .requiredOption("--collateral <amount>", "Collateral amount in USDC (e.g., 20)")
      .requiredOption("--size <amount>", "Position size in USD (e.g., 100)")
      .option("--execution-fee <amount>", "Execution fee in ETH", "0.01")
      .option("--slippage-bps <number>", "Slippage tolerance in basis points", "100")
      .option("--execute", "Actually execute the transaction (default: dry-run)", false)
      .action(async (options) => {
        await gmxOpenShort({
          account: options.account,
          collateralAmount: options.collateral,
          sizeDeltaUsd: options.size,
          executionFee: options.executionFee,
          slippageBps: parseInt(options.slippageBps || "100", 10),
          execute: options.execute ?? false,
        });
      })
  );

  // Close short position
  addCommonOptions(
    gmx
      .command("close-short")
      .description("Close a GMX short position (dry-run by default)")
      .requiredOption("--market <address>", "Market address")
      .option("--size <amount>", "Size to close in USD (defaults to full position)")
      .option("--execution-fee <amount>", "Execution fee in ETH", "0.01")
      .option("--slippage-bps <number>", "Slippage tolerance in basis points", "100")
      .option("--execute", "Actually execute the transaction (default: dry-run)", false)
      .action(async (options) => {
        await gmxCloseShort({
          account: options.account,
          market: options.market,
          sizeDeltaUsd: options.size,
          executionFee: options.executionFee,
          slippageBps: parseInt(options.slippageBps || "100", 10),
          execute: options.execute ?? false,
        });
      })
  );

  // Read orders
  addCommonOptions(
    gmx
      .command("read-orders")
      .alias("orders")
      .description("Read pending GMX orders")
      .option("-s, --start <number>", "Start index", "0")
      .option("-e, --end <number>", "End index", "10")
      .action(async (options) => {
        await gmxReadOrders({
          account: options.account,
          start: parseInt(options.start, 10),
          end: parseInt(options.end, 10),
        });
      })
  );

  // Read single order
  addCommonOptions(
    gmx
      .command("read-order")
      .description("Read a specific GMX order by key")
      .requiredOption("--order-key <key>", "Order key")
      .action(async (options) => {
        await gmxReadOrder({
          account: options.account,
          orderKey: options.orderKey,
        });
      })
  );
}
