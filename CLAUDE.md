# CLAUDE.md

Development guidelines for AI assistants working on the Harmonia project.

## Project Overview

Harmonia is a delta-neutral yield strategy that combines Uniswap v3 LP positions with GMX v2 perpetual hedging on Arbitrum. The goal is to capture trading fees while eliminating directional price exposure.

**Approach**: EOA-based with TypeScript scripts/programs (not smart contracts).

## Quick Start

```bash
npm install                                    # Install dependencies
npx hardhat run scripts/gmx-read-position.ts     # Read GMX positions
```

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
├── check-pool.ts             # Check Uniswap pool state
├── check-balance.ts          # Check token balances
└── check-usdc.ts             # Check USDC balance

src/                          # Core modules (to be built)
├── modules/
│   ├── gmx/                  # GMX V2 perpetual operations
│   ├── uniswap/              # Uniswap V3 LP operations
│   ├── math/                 # Delta/yield calculations
│   └── chainlink/            # Price feed operations
├── strategy/                 # Strategy orchestration
└── config/                   # Configuration
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

## Important Constants

```typescript
// Arbitrum addresses
USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"

// Strategy parameters
DELTA_THRESHOLD = 5e16      // 5% - trigger rebalance
MAX_LEVERAGE = 3e18         // 3x max on perps
MAX_SLIPPAGE = 1e16         // 1% slippage tolerance
```

## Documentation

- `PLAN.md` - Complete technical specification and design decisions

## Implementation Roadmap

See `PLAN.md` Part 6 for the current implementation roadmap:

1. **Phase 1**: Core modules (GMX, Uniswap, Math, Chainlink)
2. **Phase 2**: Strategy layer (monitor, rebalance, compound)
3. **Phase 3**: Operations (CLI, monitoring, alerts)
4. **Phase 4**: Automation (cron-based execution)

## Previous Approach

The smart contract-based approach has been archived as git tag `abandoned-v1`.
