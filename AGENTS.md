# AGENTS.md

Development guidelines for AI assistants working on the Harmonia project.

## Project Overview

Harmonia is a delta-neutral yield strategy that combines Uniswap v3 LP positions with GMX v2 perpetual hedging on Arbitrum. The goal is to capture trading fees while eliminating directional price exposure.

**Approach**: EOA-based with TypeScript scripts/programs (not smart contracts).

## Quick Start

```bash
npm install                                    # Install dependencies
npx hardhat run scripts/gmx-read-position.ts     # Read GMX positions
```

## Development Workflow

### Code Quality Standards

**Always run tests, linting, and formatting before committing code.**

#### Testing

```bash
npm test              # Run all tests once
npm run test:watch    # Run tests in watch mode
```

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

## Codebase Structure

```
scripts/
├── config/
│   └── addresses.ts          # Contract addresses and constants
├── gmx-open-short.ts         # Open GMX short position
├── gmx-close-short.ts        # Close GMX short position
├── gmx-read-position.ts      # Read GMX positions
├── read-orders.ts            # Read pending GMX orders
├── read-order.ts             # Read specific GMX order
├── scan-order-events.ts      # Scan GMX order events
├── uniswap-open-position.ts  # Open Uniswap LP position
├── uniswap-close-position.ts # Close Uniswap LP position
├── uniswap-read-position.ts  # Read Uniswap LP positions
├── execute-rebalance.ts      # Execute rebalance operation
├── monitor-position.ts       # Monitor delta-neutral positions
├── check-pool.ts             # Check Uniswap pool state
├── check-balance.ts          # Check token balances
└── check-usdc.ts             # Check USDC balance

src/                          # Core modules
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

### Reading Positions

```bash
# Read all GMX positions
npx hardhat run scripts/gmx-read-position.ts --network arbitrum

# Read for specific account
ACCOUNT=0x... npx hardhat run scripts/gmx-read-position.ts --network arbitrum
```

### Creating Short Position

```bash
npx hardhat run scripts/gmx-open-short.ts --network arbitrum
```

### Closing Short Position

```bash
npx hardhat run scripts/gmx-close-short.ts --network arbitrum
```

### Monitoring Positions

```bash
# Monitor delta-neutral positions
npx hardhat run scripts/monitor-position.ts --network arbitrum
```

### Executing Rebalance

```bash
# Execute rebalance operation
npx hardhat run scripts/execute-rebalance.ts --network arbitrum
```

### Uniswap Position Management

```bash
# Open Uniswap LP position
npx hardhat run scripts/uniswap-open-position.ts --network arbitrum

# Read Uniswap positions
npx hardhat run scripts/uniswap-read-position.ts --network arbitrum

# Close Uniswap position
npx hardhat run scripts/uniswap-close-position.ts --network arbitrum
```

## Important Constants

All contract addresses and strategy parameters are defined in `scripts/config/addresses.ts`:

```typescript
// From scripts directory:
import { ARBITRUM_MAINNET, STRATEGY_PARAMS } from './config/addresses';

// From src or test directories:
import { ARBITRUM_MAINNET, STRATEGY_PARAMS } from '../scripts/config/addresses';

// Key addresses
ARBITRUM_MAINNET.usdc              // "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
ARBITRUM_MAINNET.weth              // "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
ARBITRUM_MAINNET.gmxExchangeRouter // "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41"
ARBITRUM_MAINNET.uniswapV3PositionManager // "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"

// Strategy parameters (BigInt values)
STRATEGY_PARAMS.DELTA_THRESHOLD    // 5e16 (5%) - trigger rebalance
STRATEGY_PARAMS.MAX_LEVERAGE       // 3e18 (3x) - max leverage on perps
STRATEGY_PARAMS.MAX_SLIPPAGE       // 1e16 (1%) - slippage tolerance
STRATEGY_PARAMS.EMERGENCY_THRESHOLD // 20e16 (20%) - emergency alert threshold
```

## Documentation

- `PLAN.md` - Complete technical specification and design decisions

## Implementation Roadmap

See `PLAN.md` Part 6 for the detailed implementation roadmap:

1. **Phase 1**: Core modules (GMX, Uniswap, Math, Chainlink) ✅ **Complete**
2. **Phase 2**: Strategy layer (monitor, rebalance, compound) 🔄 **In Progress**
   - ✅ Position monitoring (`monitor.ts`, `monitor-position.ts` script)
   - ✅ Rebalance execution (`rebalance.ts`, `execute-rebalance.ts` script)
   - ⏳ Compounding logic
   - ⏳ Range adjustment
3. **Phase 3**: Operations (CLI, monitoring, alerts) ⏳ **Pending**
4. **Phase 4**: Automation (cron-based execution) ⏳ **Pending**

## Previous Approach

The smart contract-based approach has been archived as git tag `abandoned-v1`.
