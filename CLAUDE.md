# CLAUDE.md

Development guidelines for AI assistants working on the Harmonia project.

## Project Overview

Harmonia is a delta-neutral yield strategy that combines Uniswap v3 LP positions with GMX v2 perpetual hedging on Arbitrum. The goal is to capture trading fees while eliminating directional price exposure.

## Quick Start

```bash
npm install          # Install dependencies
npm run compile      # Compile contracts
npm test             # Run all tests
npm run format       # Format code
```

## Codebase Structure

```
contracts/
├── interfaces/           # Protocol interfaces (implemented)
│   ├── IUniswapV3.sol   # Uniswap v3 pool, position manager, router
│   ├── IGMXV2.sol       # GMX v2 exchange router, data store, reader
│   ├── IChainlink.sol   # Price feeds, automation registry
│   ├── ILiquidityManager.sol  # LiquidityManager interface
│   └── IHedgeManager.sol      # HedgeManager interface
├── libraries/            # Core calculation libraries (implemented)
│   ├── DeltaCalculator.sol  # LP delta/gamma calculations
│   └── YieldMath.sol        # APY and yield calculations
├── core/                 # Main contracts (implemented)
│   ├── DeltaNeutralVault.sol   # ERC-4626 vault
│   ├── LiquidityManager.sol    # Uniswap v3 operations
│   └── HedgeManager.sol        # GMX v2 operations
├── periphery/            # Supporting contracts (NOT YET IMPLEMENTED)
│   └── RebalanceController.sol # Chainlink Automation keeper
└── test/                 # Test harness and mock contracts
    ├── MockERC20.sol
    ├── MockUniswapV3.sol
    ├── MockGMXV2.sol
    ├── DeltaCalculatorHarness.sol
    └── YieldMathHarness.sol
```

## Implementation Status

**Completed (Phases 1-5):**
- `DeltaCalculator` library - Full delta/gamma math for Uniswap v3 positions
- `YieldMath` library - APY calculations and yield metrics
- All external protocol interfaces
- `DeltaNeutralVault` - ERC-4626 vault with deposit/withdraw
- `LiquidityManager` - Uniswap v3 position management
- `HedgeManager` - GMX v2 perpetual short position management
- Comprehensive test suite (350+ tests)
- Fork tests against Arbitrum mainnet

**Not Yet Implemented (Phases 6-8):**
- Rebalance automation (`RebalanceController`)
- Security hardening
- Deployment scripts

## Key Technical Concepts

### Delta Calculation

LP positions in Uniswap v3 have a delta that varies with price:
- Uses `sqrtPriceX96` format (Q96 fixed-point)
- Delta = 0 above range, varies 0→1 in range, = 1 below range
- See `contracts/libraries/DeltaCalculator.sol` for implementation

### Precision and Math

- Use 1e18 for percentage values (e.g., 5% = 5e16)
- Use Q96 (2^96) for Uniswap price representation
- GMX uses 30 decimals for USD values
- Always use `mulDiv` for safe division to avoid overflow

### Testing Patterns

Tests are organized by priority:
- `test/scenarios/CriticalScenarios.test.ts` (P0) - Liquidation, oracle attacks
- `test/scenarios/HighPriorityScenarios.test.ts` (P1) - Rebalance failures
- `test/scenarios/MediumPriorityScenarios.test.ts` (P2) - Fee collection
- `test/scenarios/LowerPriorityScenarios.test.ts` (P3) - Normal operations

Fork tests use Arbitrum mainnet state:
- `test/fork/UniswapV3Fork.test.ts` - Real pool interactions
- `test/fork/ChainlinkPriceFeed.test.ts` - Live price feed testing
- `test/fork/LiquidityManagerFork.test.ts` - LP position management on mainnet
- `test/fork/HedgeManagerFork.test.ts` - GMX v2 hedge management on mainnet

Unit tests for core contracts:
- `test/unit/DeltaNeutralVault.test.ts` - ERC-4626 vault tests (75 tests)
- `test/unit/LiquidityManager.test.ts` - LP management tests (47 tests)
- `test/unit/HedgeManager.test.ts` - GMX v2 hedge tests (59 tests)

## Common Tasks

### Adding a New Contract

1. Create the contract in the appropriate directory (`core/`, `periphery/`, etc.)
2. Add corresponding test file in `test/unit/` or `test/integration/`
3. Run `npm run compile` to verify compilation
4. Run `npm test` to ensure all tests pass
5. Run `npm run format` before committing

### Running Fork Tests

```bash
# Set your Alchemy API key
export ALCHEMY_API_KEY=your_alchemy_api_key_here

# Run fork tests
npx hardhat test test/fork/**/*.test.ts
```

### Debugging Delta Calculations

Use the test harness for isolated testing:
```typescript
const harness = await DeltaCalculatorHarness.deploy();
const delta = await harness.calculateDelta(sqrtPriceX96, lower, upper, liquidity);
```

## Code Style

- Solidity: Follow existing patterns in `contracts/libraries/`
- TypeScript: Prettier formatting with 2-space indentation
- Run `npm run format` before committing

## Important Constants

```solidity
// Arbitrum addresses
USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1

// Strategy parameters (from PLAN.md)
DELTA_THRESHOLD = 5e16      // 5% - trigger rebalance
MAX_LEVERAGE = 3e18         // 3x max on perps
MIN_HEDGE_RATIO = 80e16     // Hedge at least 80% of delta
EMERGENCY_THRESHOLD = 20e16 // Emergency unwind at 20% drift
```

## Documentation

- `PLAN.md` - Complete technical specification and design decisions
- `README.md` - Project overview and setup instructions
- Code comments follow NatSpec format

## Next Implementation Steps

1. ~~Implement `DeltaNeutralVault` (ERC-4626 vault with deposit/withdraw)~~ ✓ (Phase 3)
2. ~~Implement `LiquidityManager` (Uniswap v3 position management)~~ ✓ (Phase 4)
3. ~~Implement `HedgeManager` (GMX v2 short position management)~~ ✓ (Phase 5)
4. Implement `RebalanceController` (Chainlink Automation keeper) - Phase 6
5. Security hardening and gas optimization - Phase 7
6. Write deployment scripts - Phase 8
