#!/usr/bin/env node

// Set HARDHAT_NETWORK before Hardhat is imported/initialized
// Parse arguments early to check for --network option
if (require.main === module) {
  const args = process.argv.slice(2);
  const networkIndex = args.findIndex((arg) => arg === "--network" || arg === "-n");
  if (networkIndex !== -1 && args[networkIndex + 1]) {
    const network = args[networkIndex + 1];
    // Set HARDHAT_NETWORK before Hardhat initializes
    process.env.HARDHAT_NETWORK = network;
  } else if (process.env.NETWORK) {
    // Also check for NETWORK environment variable
    process.env.HARDHAT_NETWORK = process.env.NETWORK;
  }
}

import { Command } from "commander";
import { registerGmxCommands } from "./commands/gmx";
import { registerUniswapCommands } from "./commands/uniswap";
import { registerUtilityCommands } from "./commands/utility";
import { registerStrategyCommands } from "./commands/strategy";
import { registerMonitorCommand } from "./commands/monitor";
import { registerDashboardCommand } from "./commands/dashboard";

const program = new Command();

program
  .name("harmonia")
  .description("Delta-neutral yield strategy CLI for Uniswap v3 LP and GMX v2 hedging")
  .version("2.0.0");

// Register command groups
registerGmxCommands(program);
registerUniswapCommands(program);
registerUtilityCommands(program);
registerStrategyCommands(program);
registerMonitorCommand(program);
registerDashboardCommand(program);

// Parse command line arguments only if this file is being run directly
// This allows the CLI to be imported for testing without executing
if (require.main === module) {
  program.parse();
}
