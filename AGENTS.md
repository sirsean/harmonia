# AGENTS.md

Development guidelines for AI assistants working on the Harmonia project.

## Project Overview

Harmonia is a delta-neutral yield strategy that combines Uniswap v3 LP positions with GMX v2 perpetual hedging on Arbitrum. The goal is to capture trading fees while eliminating directional price exposure.

**Approach**: EOA-based with TypeScript scripts/programs (not smart contracts).

## Quick Start

```bash
npm install                                    # Install dependencies
npm run cli -- gmx read-position --network arbitrum  # Read GMX positions
npm run cli -- monitor --network arbitrum            # Monitor positions
```

See `docs/CLI.md` for complete CLI documentation.

## Development Workflow

### Code Quality Standards

**Always run tests, linting, and formatting before committing code.**

#### Testing

```bash
npm test              # Run all tests once
npm run test:watch    # Run tests in watch mode
```

**Note:** Always use `npm test` (or `npm run test:watch`) to run tests. Do not use `npx vitest` directly, as it requires manual intervention to complete.

**Test Requirements:**
- ✅ **All tests must pass** - Never commit code with failing tests
- ✅ **Comprehensive coverage** - Write tests for all new functionality
- ✅ **Keep tests updated** - Update tests when modifying existing code
- ✅ **Integration tests** - Use cassette replays (via `nock`) for external API calls when available
- ✅ **Test files** - Located in `test/` directory, mirroring `src/` structure

#### Linting

```bash
npm run lint          # Check code formatting (read-only)
```

**Linting Requirements:**
- ✅ **Always lint before committing** - Ensures consistent code style
- ✅ **Fix all linting errors** - Don't commit code with formatting issues
- ✅ Uses Prettier to check formatting of `scripts/**/*.ts` and `src/**/*.ts`

#### Formatting

```bash
npm run format        # Auto-format all code
```

**Formatting Requirements:**
- ✅ **Format code before committing** - Run `npm run format` to auto-fix formatting
- ✅ **Consistent style** - Prettier configuration in `.prettierrc`
- ✅ **Formats** - All TypeScript files in `scripts/` and `src/` directories

### Standard Workflow

1. **Make changes** to code
2. **Run `npm run format`** to auto-format
3. **Run `npm run lint`** to verify formatting (should pass after step 2)
4. **Run `npm test`** to ensure all tests pass
5. **Write/update tests** for any new functionality
6. **Commit** only when tests pass and code is formatted

**Remember:** The test suite is a critical part of this project. Maintain comprehensive test coverage and ensure tests always pass. Well-tested code is essential for a financial strategy that manages real funds.

#### Transaction Handling

**CRITICAL: Always wait for transaction confirmations before sending subsequent transactions.**

**Transaction Confirmation Requirements:**
- ✅ **ALWAYS wait for confirmation** - After sending any transaction (approve, transfer, mint, swap, etc.), you MUST wait for the transaction receipt before continuing
- ✅ **Use `await tx.wait()`** - For ethers.js transactions, use `await tx.wait()` to wait for confirmation
- ✅ **Fetch fresh nonces** - After waiting for a transaction, fetch a fresh nonce using `await signer.getNonce("pending")` instead of manually incrementing
- ✅ **Never manually increment nonces** - Manual nonce incrementing (`nonce += 1`) can cause "nonce too low" errors if transactions fail or other transactions occur

**Why this matters:**
- Sending transactions without waiting causes "nonce too low" errors
- The blockchain state may not reflect your transaction immediately
- Subsequent transactions will fail if they use stale nonces
- This is especially critical in production where real funds are at stake

**Example:**
```typescript
// ✅ CORRECT: Wait for confirmation and fetch fresh nonce
const approval = await token.approve(spender, amount, { nonce });
await approval.wait();
nonce = await signer.getNonce("pending"); // Fetch fresh nonce

// ❌ WRONG: Don't manually increment nonce
const approval = await token.approve(spender, amount, { nonce });
await approval.wait();
nonce += 1; // This can cause nonce errors!
```

## Codebase Structure

```
scripts/                      # Legacy scripts (use CLI instead)
├── config/                   # Configuration files
│   ├── addresses.ts          # Contract addresses and constants
│   └── range.ts              # Range configuration for Uniswap positions
└── ...                       # Legacy script files

src/                          # Core modules and CLI
├── cli/                      # Unified CLI interface
│   ├── index.ts              # CLI entry point
│   └── commands/             # Command implementations
│       ├── gmx/              # GMX commands
│       ├── uniswap/          # Uniswap commands
│       ├── utility/          # Utility commands
│       ├── strategy/         # Strategy commands
│       └── monitor.ts        # Monitor command
├── modules/
│   ├── gmx/                  # GMX V2 perpetual operations
│   │   ├── reader.ts         # Read positions and orders
│   │   ├── orders.ts         # Create and manage orders
│   │   ├── position.ts       # Position calculations
│   │   ├── prices.ts         # Price fetching
│   │   └── types.ts          # Type definitions
│   ├── uniswap/              # Uniswap V3 LP operations
│   │   ├── reader.ts         # Read positions and pool state
│   │   ├── liquidity.ts      # Liquidity calculations
│   │   ├── fees.ts           # Fee calculations
│   │   └── types.ts          # Type definitions
│   ├── math/                 # Delta/yield calculations
│   │   ├── delta.ts          # Delta calculations
│   │   ├── ticks.ts          # Tick math utilities
│   │   └── yield.ts          # Yield calculations
│   └── chainlink/            # Price feed operations
│       ├── price.ts          # Price feed reader
│       └── types.ts          # Type definitions
└── strategy/                 # Strategy orchestration
    ├── monitor.ts            # Position monitoring
    ├── rebalance.ts          # Rebalance execution
    └── types.ts              # Type definitions
```

## Key Technical Concepts

### Delta Calculation

LP positions in Uniswap v3 have a delta that varies with price:
- Uses `sqrtPriceX96` format (Q96 fixed-point)
- Delta = 0 above range, varies 0→1 in range, = 1 below range

### Precision and Math

- Use 1e18 for percentage values (e.g., 5% = 5e16)
- Use Q96 (2^96) for Uniswap price representation
- GMX uses 30 decimals for USD values
- GMX uses 12 decimals for prices in orders

### GMX V2 Order Types

- `orderType: 2` = MarketIncrease (open/increase position)
- `orderType: 4` = MarketDecrease (close/decrease position)
- `isLong: false` for short positions

## Common Tasks

All tasks are now performed using the unified CLI. See `docs/CLI.md` for complete documentation.

### Reading Positions

```bash
# Read all GMX positions
npm run cli -- gmx read-position --network arbitrum

# Read for specific account
npm run cli -- gmx read-position --network arbitrum --account 0x...

# Read Uniswap positions
npm run cli -- uniswap read-position --network arbitrum

# Monitor all positions (recommended)
npm run cli -- monitor --network arbitrum
```

### GMX Operations

```bash
# Open short position
npm run cli -- gmx open-short --network arbitrum --collateral 20 --size 100

# Close short position
npm run cli -- gmx close-short --network arbitrum --market <market-address>

# Read pending orders
npm run cli -- gmx read-orders --network arbitrum

# Read specific order
npm run cli -- gmx read-order --network arbitrum --order-key <key>
```

### Strategy Operations

```bash
# Monitor delta-neutral positions
npm run cli -- monitor --network arbitrum

# Optimize strategy position
npm run cli -- strategy optimize --network arbitrum --token-id <id>
```

### Utility Commands

```bash
# Check ETH balance
npm run cli -- util balance --network arbitrum

# Check USDC balance
npm run cli -- util usdc --network arbitrum

# Check Uniswap pool state
npm run cli -- uniswap check-pool --network arbitrum --pool <address>
```

### Using Environment Variables

For convenience, you can set the network once:

```bash
export NETWORK=arbitrum

npm run cli -- monitor
npm run cli -- gmx read-position
npm run cli -- uniswap read-position
```

## Runtime Strategy Parameters

Strategy config is now runtime-tunable via SQLite-backed params.

### Parameter precedence

1. Account runtime param override
2. Global runtime param override
3. Environment/default config from `src/config/strategy.ts`

### CLI commands

```bash
# Show effective params (account scope by default)
npm run cli -- strategy params show --network arbitrum

# Show global scope only
npm run cli -- strategy params show --network arbitrum --global

# Set runtime param (manual lock by default)
npm run cli -- strategy params set --network arbitrum --key defaultRangeWidth --value 0.08 --reason "widen for volatility"

# Set runtime param with TTL
npm run cli -- strategy params set --network arbitrum --key hedgeDeltaThreshold --value 0.04 --ttl 3600 --reason "temporary tighter hedge"

# Clear runtime param
npm run cli -- strategy params clear --network arbitrum --key hedgeDeltaThreshold

# View runtime param history
npm run cli -- strategy params history --network arbitrum --limit 50

# Enable/disable auto-tuning
npm run cli -- strategy params auto --network arbitrum --enable
npm run cli -- strategy params auto --network arbitrum --disable
```

### Source of truth

- Contract addresses: `src/config/addresses.ts`
- Static strategy defaults + validation: `src/config/strategy.ts`
- Runtime merge/precedence logic: `src/strategy/runtime-config.ts`
- Auto regime tuning: `src/strategy/auto-tuner.ts`
- Runtime param storage + audit: `src/utils/database.ts`, `src/utils/migrations.ts`

## Documentation

- `PLAN.md` - Complete technical specification and design decisions
- `docs/` - Analysis documents and technical deep-dives (e.g., `docs/RANGE_ANALYSIS.md`)

**Note**: Analysis documents, technical deep-dives, and similar documentation should be placed in the `docs/` folder for better organization, rather than in the root directory.

## Implementation Roadmap

See `PLAN.md` Part 6 for the detailed implementation roadmap:

1. **Phase 1**: Core modules (GMX, Uniswap, Math, Chainlink) ✅ **Complete**
2. **Phase 2**: Strategy layer (monitor, optimize, compound) 🔄 **In Progress**
   - ✅ Position monitoring (`monitor.ts`, `monitor` CLI command)
   - ✅ Strategy optimization (`optimize` CLI command)
   - ⏳ Compounding logic
3. **Phase 3**: Operations (CLI, monitoring, alerts) ✅ **Complete**
   - ✅ Unified CLI interface (`src/cli/`)
   - ✅ All commands accessible via CLI
   - ⏳ Monitoring and alerts
4. **Phase 4**: Automation (cron-based execution) ⏳ **Pending**

## Previous Approach

The smart contract-based approach has been archived as git tag `abandoned-v1`.
