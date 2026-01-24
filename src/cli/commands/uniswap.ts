import { Command } from "commander";
import { addCommonOptions } from "./base";
import { uniswapReadPosition } from "./uniswap/read-position";
import { uniswapCheckPool } from "./uniswap/check-pool";
import { uniswapOpenPosition } from "./uniswap/open-position";
import { uniswapClosePosition } from "./uniswap/close-position";

/**
 * Register all Uniswap-related commands
 */
export function registerUniswapCommands(program: Command): void {
  const uniswap = program.command("uniswap").description("Uniswap v3 LP operations");

  // Read positions
  addCommonOptions(
    uniswap
      .command("read-position")
      .alias("positions")
      .description("Read Uniswap v3 positions for an account")
      .option("--token-id <id>", "Specific token ID to read")
      .option("--show-closed", "Show closed positions", false)
      .action(async (options) => {
        await uniswapReadPosition({
          account: options.account,
          tokenId: options.tokenId,
          showClosed: options.showClosed,
        });
      })
  );

  // Open position
  addCommonOptions(
    uniswap
      .command("open-position")
      .description("Open a new Uniswap v3 LP position")
      .option("--pool <address>", "Pool address")
      .option("--fee <number>", "Fee tier (500, 3000, 10000)", "500")
      .option("--tick-spacing <number>", "Tick spacing", "10")
      .option("--slippage-bps <number>", "Slippage tolerance in basis points", "50")
      .option("--range-width <number>", "Range width (e.g., 0.2 for 20%)")
      .option("--price-lower <number>", "Lower price bound")
      .option("--price-upper <number>", "Upper price bound")
      .option("--tick-lower <number>", "Lower tick (overrides price-lower)")
      .option("--tick-upper <number>", "Upper tick (overrides price-upper)")
      .option("--amount0 <amount>", "Amount of token0 desired")
      .option("--amount1 <amount>", "Amount of token1 desired")
      .option("--usdc-amount <amount>", "USDC amount (auto-balances if not using amount0/amount1)")
      .action(async (options) => {
        await uniswapOpenPosition({
          account: options.account,
          pool: options.pool,
          fee: options.fee ? Number(options.fee) : undefined,
          tickSpacing: options.tickSpacing ? Number(options.tickSpacing) : undefined,
          slippageBps: options.slippageBps ? BigInt(options.slippageBps) : undefined,
          rangeWidth: options.rangeWidth ? Number(options.rangeWidth) : undefined,
          priceLower: options.priceLower ? Number(options.priceLower) : undefined,
          priceUpper: options.priceUpper ? Number(options.priceUpper) : undefined,
          tickLower: options.tickLower ? Number(options.tickLower) : undefined,
          tickUpper: options.tickUpper ? Number(options.tickUpper) : undefined,
          amount0Desired: options.amount0,
          amount1Desired: options.amount1,
          usdcAmount: options.usdcAmount,
        });
      })
  );

  // Close position
  addCommonOptions(
    uniswap
      .command("close-position")
      .description("Close a Uniswap v3 LP position")
      .requiredOption("--token-id <id>", "Token ID of position to close")
      .action(async (options) => {
        await uniswapClosePosition({
          account: options.account,
          tokenId: options.tokenId,
        });
      })
  );

  // Check pool
  addCommonOptions(
    uniswap
      .command("check-pool")
      .description("Check Uniswap pool state")
      .requiredOption("--pool <address>", "Pool address")
      .action(async (options) => {
        await uniswapCheckPool({
          pool: options.pool,
        });
      })
  );
}
