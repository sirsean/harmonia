import { Command } from "commander";
import { addCommonOptions } from "./base";
import { checkBalance } from "./utility/check-balance";
import { checkUsdc } from "./utility/check-usdc";

/**
 * Register all utility commands
 */
export function registerUtilityCommands(program: Command): void {
  const utility = program.command("util").alias("utility").description("Utility commands");

  // Check balance
  addCommonOptions(
    utility
      .command("balance")
      .description("Check ETH balance for an account")
      .action(async (options) => {
        await checkBalance({
          account: options.account,
        });
      })
  );

  // Check USDC balance
  addCommonOptions(
    utility
      .command("usdc")
      .description("Check USDC balance for an account")
      .action(async (options) => {
        await checkUsdc({
          account: options.account,
        });
      })
  );
}
