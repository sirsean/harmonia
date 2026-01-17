# Harmonia

A delta-neutral structured product on Arbitrum that generates yield through concentrated Uniswap v3 liquidity provision while hedging directional exposure via GMX v2 perpetual futures.

## Overview

Harmonia captures LP fees and favorable funding rates while eliminating directional price risk through continuous delta hedging. The strategy:

1. **Provides concentrated liquidity** on Uniswap v3 (ETH/USDC pool) to earn trading fees
2. **Opens short positions** on GMX v2 to hedge the LP position's delta exposure
3. **Automatically rebalances** via Chainlink Automation to maintain delta neutrality

**Target yield**: 5-30% APY depending on market conditions (volume, volatility, funding rates).

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    DeltaNeutralVault                     │
│                      (ERC-4626)                          │
├──────────────────────────────────────────────────────────┤
│  LiquidityManager │ HedgeManager │ RebalanceController   │
│    (Uniswap v3)   │   (GMX v2)   │  (Chainlink Keeper)   │
└──────────────────────────────────────────────────────────┘
         │                  │                   │
         ▼                  ▼                   ▼
   ┌──────────┐      ┌──────────┐       ┌──────────────┐
   │ ETH/USDC │      │ ETH-PERP │       │  Automation  │
   │   Pool   │      │  Market  │       │   Registry   │
   └──────────┘      └──────────┘       └──────────────┘
```

## Project Structure

```
harmonia/
├── contracts/
│   ├── core/              # Core protocol logic
│   │   ├── DeltaNeutralVault.sol
│   │   ├── HedgeManager.sol
│   │   ├── LiquidityManager.sol
│   │   └── RebalanceController.sol
│   ├── interfaces/        # External protocol interfaces
│   ├── libraries/         # Core calculation libraries
│   └── test/              # Test harness contracts
├── test/
│   ├── unit/              # Unit tests for libraries
│   ├── integration/       # Integration tests
│   ├── scenarios/         # Priority-based scenario tests (P0-P3)
│   ├── fork/              # Fork tests against Arbitrum mainnet
│   └── helpers/           # Test utilities and constants
├── PLAN.md                # Technical specification
└── hardhat.config.ts      # Network configuration
```

## Installation

```bash
# Clone the repository
git clone https://github.com/sirsean/harmonia.git
cd harmonia

# Install dependencies
npm install

# Compile contracts
npm run compile
```

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests
npm run test:integration

# Run fork tests (requires ALCHEMY_API_KEY)
ALCHEMY_API_KEY=<your-api-key> npm run test:fork
```

### Code Formatting

```bash
# Format all files
npm run lint:fix

# Check formatting
npm run lint
```

## Configuration

Create a `.env` file based on `.env.example`:

```env
# Required for fork tests and deployment
ALCHEMY_API_KEY=your_alchemy_api_key_here

# Required for deployment
PRIVATE_KEY=your_private_key

# Optional for contract verification
ARBISCAN_API_KEY=your_api_key
```

## Key Concepts

### Delta Calculation

Uniswap v3 LP positions have a continuously varying delta based on price location:
- **Below range**: Delta = 1 (100% ETH exposure)
- **In range**: Delta varies from 1 to 0 as price rises
- **Above range**: Delta = 0 (100% USDC exposure)

The [`DeltaCalculator`](contracts/libraries/DeltaCalculator.sol) library implements these calculations based on Guillaume Lambert's options pricing framework.

### Yield Sources

| Source | Expected APY | Notes |
|--------|-------------|-------|
| LP Fees (0.05% tier) | 5-15% | Volume dependent |
| LP Fees (0.3% tier) | 10-25% | Higher fee, wider range |
| Funding Rate Income | 0-20% | When receiving funding |

### Risk Management

- **Delta threshold**: Rebalance when |delta| > 5%
- **Max leverage**: 3x on perpetual positions
- **Emergency unwind**: Automatic at 20% delta drift
- **Circuit breakers**: Pause on liquidation proximity

## Technology Stack

- **Solidity ^0.8.20** with OpenZeppelin 5.0
- **Hardhat** for development and testing
- **Ethers.js v6** for blockchain interaction
- **TypeChain** for type-safe contract bindings

### External Protocols

- **Uniswap v3** (Arbitrum) - Concentrated liquidity
- **GMX v2** (Arbitrum) - Perpetual futures
- **Chainlink** - Price feeds & automation

## Contract Addresses (Arbitrum)

| Contract | Address |
|----------|---------|
| Uniswap v3 PositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| Uniswap v3 WETH/USDC Pool | `0xC6962004f452bE9203591991D15f6b388e09E8D0` |
| GMX ExchangeRouter | `0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8` |
| Chainlink ETH/USD Feed | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` |

## References

- Lambert, G. "Pricing Uniswap v3 LP Positions: Towards a New Options Paradigm"
- GMX Documentation: https://docs.gmx.io/
- Uniswap v3 Documentation: https://docs.uniswap.org/
- Chainlink Automation: https://docs.chain.link/chainlink-automation
