import { Command } from "commander";
import { ethers } from "hardhat";
import type { Signer } from "ethers";

/**
 * Base command options that are common across many commands
 */
export interface BaseCommandOptions {
  account?: string;
  network?: string;
}

/**
 * Get a signer and account address, respecting the account option
 */
export async function getSignerAndAccount(
  accountOverride?: string
): Promise<{ signer: Signer; account: string }> {
  const [signer] = await ethers.getSigners();
  const account = accountOverride || (await signer.getAddress());
  return { signer, account };
}

/**
 * Add common options to a command
 */
export function addCommonOptions(command: Command): Command {
  return command
    .option("-a, --account <address>", "Account address to use (defaults to first signer)")
    .option("-n, --network <network>", "Network to use (defaults to hardhat config)");
}
