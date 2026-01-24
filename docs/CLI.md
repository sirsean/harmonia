# Harmonia CLI Documentation

## Overview

The Harmonia CLI provides a unified command-line interface for managing delta-neutral yield strategies using Uniswap v3 LP positions and GMX v2 hedging on Arbitrum. The CLI is built using the [Commander.js](https://github.com/tj/commander.js) library and follows an extensible command structure.

## Installation

The CLI is included with the Harmonia package. To use it:

```bash
npm run cli -- <command> [options]
```

Or if installed globally:

```bash
harmonia <command> [options]
```

## Command Structure

The CLI is organized into command groups:

- `monitor` - Monitor delta-neutral position status and health
- `gmx` - GMX v2 perpetual operations
- `uniswap` - Uniswap v3 LP operations
- `util` / `utility` - Utility commands
- `strategy` - Strategy execution commands

**Note**: Analysis commands (analyze-loss, analyze-range-size, etc.) are available as scripts in the `scripts/` directory but are not yet implemented in the CLI.

Each command group contains multiple subcommands. Use `--help` to see available commands:

```bash
npm run cli -- --help
npm run cli -- gmx --help
npm run cli -- uniswap --help
```

## Common Options

Most commands support these common options:

- `-a, --account <address>` - Account address to use (defaults to first signer)
- `-n, --network <network>` - Network to use (defaults to hardhat fork network)

**Important**: To connect to actual Arbitrum mainnet, you must specify `--network arbitrum` (or use the `NETWORK` environment variable). Without this option, the CLI will use Hardhat's fork network which may cause errors.

You can specify the network in two ways:

1. **Command-line option** (recommended):
   ```bash
   npm run cli -- monitor --network arbitrum
   npm run cli -- gmx read-position --network arbitrum
   ```

2. **Environment variable** (useful for all commands):
   ```bash
   NETWORK=arbitrum npm run cli -- monitor
   NETWORK=arbitrum npm run cli -- gmx read-position
   ```

The environment variable approach is convenient when running multiple commands:
```bash
export NETWORK=arbitrum
npm run cli -- monitor
npm run cli -- gmx read-position
npm run cli -- uniswap read-position
```

## Monitor Command

Monitor your delta-neutral position status and health:

```bash
npm run cli -- monitor [options]
```

Options:
- `--token-id <id>` - Uniswap token ID to monitor (monitors all positions if not specified)
- `--min-fee-threshold <amount>` - Minimum fee threshold in USD (default: 10)

This command provides a comprehensive view of:
- Uniswap LP positions (price ranges, deltas, values, fees)
- GMX hedge position (size, delta, collateral, net value)
- Net strategy metrics (net delta, delta drift)
- Total portfolio value
- Action recommendations

Example:
```bash
# Monitor all positions on Arbitrum mainnet
npm run cli -- monitor --network arbitrum

# Monitor specific token ID
npm run cli -- monitor --network arbitrum --token-id 12345

# Monitor with custom fee threshold
npm run cli -- monitor --network arbitrum --min-fee-threshold 20
```

## GMX Commands

### Read Positions

View GMX positions for an account:

```bash
npm run cli -- gmx read-position [options]
```

Options:
- `-s, --start <number>` - Start index (default: 0)
- `-e, --end <number>` - End index (default: 10)
- `-m, --market <address>` - Filter by market address
- `--maintenance-margin-bps <number>` - Maintenance margin basis points (default: 100)

Example:
```bash
npm run cli -- gmx read-position --network arbitrum --account 0x1234... --start 0 --end 5
# Or using environment variable:
NETWORK=arbitrum npm run cli -- gmx read-position --account 0x1234... --start 0 --end 5
```

### Open Short Position

Create a new GMX short position:

```bash
npm run cli -- gmx open-short [options]
```

Options:
- `--collateral <amount>` - Collateral amount in USDC (required, e.g., "20")
- `--size <amount>` - Position size in USD (required, e.g., "100")
- `--execution-fee <amount>` - Execution fee in ETH (default: "0.01")
- `--slippage-bps <number>` - Slippage tolerance in basis points (default: 100)

Example:
```bash
npm run cli -- gmx open-short --network arbitrum --collateral 20 --size 100 --slippage-bps 50
# Or using environment variable:
NETWORK=arbitrum npm run cli -- gmx open-short --collateral 20 --size 100 --slippage-bps 50
```

### Close Short Position

Close an existing GMX short position:

```bash
npm run cli -- gmx close-short [options]
```

Options:
- `--market <address>` - Market address (required)
- `--size <amount>` - Size to close in USD (defaults to full position)
- `--execution-fee <amount>` - Execution fee in ETH (default: "0.01")
- `--slippage-bps <number>` - Slippage tolerance in basis points (default: 100)

Example:
```bash
npm run cli -- gmx close-short --network arbitrum --market 0xabcd... --slippage-bps 50
# Or using environment variable:
NETWORK=arbitrum npm run cli -- gmx close-short --market 0xabcd... --slippage-bps 50
```

### Read Orders

View pending GMX orders:

```bash
npm run cli -- gmx read-orders [options]
```

Options:
- `-s, --start <number>` - Start index (default: 0)
- `-e, --end <number>` - End index (default: 10)

Example:
```bash
npm run cli -- gmx read-orders --network arbitrum --account 0x1234...
# Or using environment variable:
NETWORK=arbitrum npm run cli -- gmx read-orders --account 0x1234...
```

### Read Order

View a specific GMX order by key:

```bash
npm run cli -- gmx read-order [options]
```

Options:
- `--order-key <key>` - Order key (required)
- `--tx-hash <hash>` - Transaction hash (optional, used to find order key)

Example:
```bash
npm run cli -- gmx read-order --network arbitrum --order-key 0x1234...
# Or using environment variable:
NETWORK=arbitrum npm run cli -- gmx read-order --order-key 0x1234...
```

## Uniswap Commands

### Read Positions

View Uniswap v3 positions for an account:

```bash
npm run cli -- uniswap read-position [options]
```

Options:
- `--token-id <id>` - Specific token ID to read
- `--show-closed` - Show closed positions

Example:
```bash
npm run cli -- uniswap read-position --network arbitrum --account 0x1234... --show-closed
# Or using environment variable:
NETWORK=arbitrum npm run cli -- uniswap read-position --account 0x1234... --show-closed
```

### Check Pool

Check Uniswap pool state:

```bash
npm run cli -- uniswap check-pool [options]
```

Options:
- `--pool <address>` - Pool address (required)

Example:
```bash
npm run cli -- uniswap check-pool --network arbitrum --pool 0xabcd...
# Or using environment variable:
NETWORK=arbitrum npm run cli -- uniswap check-pool --pool 0xabcd...
```

## Utility Commands

### Check Balance

Check ETH balance for an account:

```bash
npm run cli -- util balance [options]
```

Example:
```bash
npm run cli -- util balance --network arbitrum --account 0x1234...
# Or using environment variable:
NETWORK=arbitrum npm run cli -- util balance --account 0x1234...
```

### Check USDC

Check USDC balance for an account:

```bash
npm run cli -- util usdc [options]
```

Example:
```bash
npm run cli -- util usdc --network arbitrum --account 0x1234...
# Or using environment variable:
NETWORK=arbitrum npm run cli -- util usdc --account 0x1234...
```

## Strategy Commands

### Monitor Position

Monitor delta-neutral position status:

```bash
npm run cli -- strategy monitor [options]
```

Options:
- `--token-id <id>` - Uniswap token ID to monitor

Example:
```bash
npm run cli -- strategy monitor --network arbitrum --token-id 12345
# Or using environment variable:
NETWORK=arbitrum npm run cli -- strategy monitor --token-id 12345
```

### Execute Rebalance

Execute rebalance operation:

```bash
npm run cli -- strategy rebalance [options]
```

Options:
- `--token-id <id>` - Uniswap token ID
- `--dry-run` - Perform dry run without executing

Example:
```bash
npm run cli -- strategy rebalance --network arbitrum --token-id 12345 --dry-run
# Or using environment variable:
NETWORK=arbitrum npm run cli -- strategy rebalance --token-id 12345 --dry-run
```

### Execute Adjust Range

Execute range adjustment:

```bash
npm run cli -- strategy adjust-range [options]
```

Options:
- `--token-id <id>` - Uniswap token ID
- `--dry-run` - Perform dry run without executing

Example:
```bash
npm run cli -- strategy adjust-range --network arbitrum --token-id 12345 --dry-run
# Or using environment variable:
NETWORK=arbitrum npm run cli -- strategy adjust-range --token-id 12345 --dry-run
```

## Extending the CLI

The CLI is designed to be easily extensible. To add a new command:

### 1. Create Command Implementation

Create a new file in `src/cli/commands/<group>/<command>.ts`:

```typescript
import { getSignerAndAccount } from "../base";

export interface MyCommandOptions {
  account?: string;
  // Add your command-specific options
}

export async function myCommand(options: MyCommandOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  // Implement your command logic
}
```

### 2. Register the Command

In `src/cli/commands/<group>.ts`, add your command:

```typescript
import { Command } from "commander";
import { addCommonOptions } from "./base";
import { myCommand } from "./<group>/<command>";

export function register<Group>Commands(program: Command): void {
  const group = program.command("<group>").description("...");

  addCommonOptions(
    group
      .command("<command>")
      .description("Command description")
      .option("--my-option <value>", "Option description")
      .action(async (options) => {
        await myCommand({
          account: options.account,
          // Map CLI options to function options
        });
      })
  );
}
```

### 3. Export from Index

Ensure your command group is registered in `src/cli/index.ts`:

```typescript
import { register<Group>Commands } from "./commands/<group>";

// ... in the main function:
register<Group>Commands(program);
```

### 4. Write Tests

Create tests in `test/cli/commands/<group>.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { register<Group>Commands } from "../../../src/cli/commands/<group>";

describe("<Group> Commands", () => {
  it("should register commands", () => {
    const program = new Command();
    register<Group>Commands(program);
    
    const groupCommand = program.commands.find((cmd) => cmd.name() === "<group>");
    expect(groupCommand).toBeDefined();
  });
});
```

## Architecture

### Command Structure

```
src/cli/
├── index.ts                    # Main entry point
└── commands/
    ├── base.ts                 # Common utilities and options
    ├── gmx.ts                  # GMX command group registration
    ├── gmx/
    │   ├── read-position.ts
    │   ├── open-short.ts
    │   └── ...
    ├── uniswap.ts
    ├── uniswap/
    │   └── ...
    ├── utility.ts
    ├── utility/
    │   └── ...
    ├── analysis.ts
    ├── analysis/
    │   └── ...
    ├── strategy.ts
    └── strategy/
        └── ...
```

### Design Principles

1. **Separation of Concerns**: Each command is a separate module with a clear interface
2. **Reusability**: Common functionality is extracted to `base.ts`
3. **Testability**: Commands are pure functions that can be tested independently
4. **Extensibility**: New commands can be added without modifying existing code
5. **Type Safety**: All commands use TypeScript interfaces for options

### Command Interface Pattern

All commands follow this pattern:

```typescript
// 1. Define options interface
export interface CommandOptions {
  account?: string;
  // ... command-specific options
}

// 2. Export async function
export async function commandName(options: CommandOptions = {}): Promise<void> {
  // 3. Get signer/account using base utility
  const { signer, account } = await getSignerAndAccount(options.account);
  
  // 4. Implement command logic
  // ...
}
```

## Testing

Run CLI tests:

```bash
npm test -- test/cli
```

The test suite includes:
- Command registration tests
- Base utility tests
- Individual command tests (mocked)

## Environment Variables

The CLI respects Hardhat configuration and environment variables:

- `ACCOUNT` - Default account address (can be overridden with `--account`)
- `NETWORK` - Network name (can be overridden with `--network`). Set to `arbitrum` to connect to Arbitrum mainnet. This applies to **all commands**.
- Other Hardhat-specific environment variables

**Example**: Using environment variables for all commands:
```bash
export NETWORK=arbitrum
export ACCOUNT=0x1234567890123456789012345678901234567890

npm run cli -- monitor
npm run cli -- gmx read-position
npm run cli -- uniswap read-position
```

## Error Handling

Commands should handle errors gracefully:

```typescript
try {
  await commandFunction(options);
} catch (error) {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
```

The CLI entry point (`src/cli/index.ts`) handles uncaught errors automatically.

## Best Practices

1. **Use Common Options**: Always use `addCommonOptions()` for commands that need account/network
2. **Type Safety**: Define TypeScript interfaces for all command options
3. **Documentation**: Add JSDoc comments to exported functions
4. **Testing**: Write tests for all new commands
5. **Error Messages**: Provide clear, actionable error messages
6. **Validation**: Validate required options before executing commands

## Examples

See the test files in `test/cli/commands/` for examples of how to structure and test commands.
