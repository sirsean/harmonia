# Harmonia

A delta-neutral yield strategy on Arbitrum that generates yield through concentrated Uniswap v3 liquidity provision while hedging directional exposure via GMX v2 perpetual futures.

## Overview

Harmonia captures LP fees and favorable funding rates while eliminating directional price risk through continuous delta hedging. The strategy:

1. **Provides concentrated liquidity** on Uniswap v3 (ETH/USDC pool) to earn trading fees
2. **Opens short positions** on GMX v2 to hedge the LP position's delta exposure
3. **Automatically rebalances** to maintain delta neutrality
4. **Compounds fees** by reinvesting collected earnings

**Target yield**: 5-30% APY depending on market conditions (volume, volatility, funding rates).

## Architecture

This project uses an **EOA-based approach** with TypeScript scripts rather than smart contracts. This provides:

- Simpler development and iteration
- Easier debugging and monitoring
- Lower gas costs (no proxy overhead)
- Flexible strategy adjustments
- No audit requirements

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EOA Wallet                                  │
│                   (Holds tokens and positions)                      │
├─────────────────────────────────────────────────────────────────────┤
│  Assets:                                                            │
│  ├── USDC (collateral and quote token)                             │
│  ├── WETH (base token for LP)                                      │
│  └── Uniswap V3 LP NFT Position                                    │
│                                                                     │
│  Positions:                                                         │
│  ├── Uniswap V3 Concentrated Liquidity Position                    │
│  └── GMX V2 Short Perpetual Position                               │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    TypeScript Control Layer                         │
├─────────────────────────────────────────────────────────────────────┤
│  modules/gmx/       → GMX V2 perpetual operations                  │
│  modules/uniswap/   → Uniswap V3 LP operations                     │
│  modules/math/      → Delta/yield calculations                     │
│  strategy/          → Rebalance, compound, monitor                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
harmonia/
├── scripts/
│   ├── config/
│   │   └── addresses.ts          # Contract addresses and constants
│   ├── create-short-position.ts  # Open GMX short position
│   ├── close-short-position.ts   # Close GMX short position
│   ├── read-positions.ts         # Read GMX positions
│   └── ...                       # Other utility scripts
├── src/
│   ├── modules/                  # Core protocol modules (to be built)
│   │   ├── gmx/                  # GMX V2 operations
│   │   ├── uniswap/              # Uniswap V3 operations
│   │   └── math/                 # Delta/yield calculations
│   └── strategy/                 # Strategy orchestration
├── PLAN.md                       # Technical specification
└── CLAUDE.md                     # Development guidelines
```

## Installation

```bash
# Clone the repository
git clone https://github.com/sirsean/harmonia.git
cd harmonia

# Install dependencies
npm install
```

## Usage

### Reading GMX Positions

```bash
npx hardhat run scripts/read-positions.ts --network arbitrum
```

### Tests

```bash
# Runs unit + integration tests. Integration tests use cassette replays when available.
npm test
```

### Creating a Short Position

```bash
npx hardhat run scripts/create-short-position.ts --network arbitrum
```

### Closing a Short Position

```bash
npx hardhat run scripts/close-short-position.ts --network arbitrum
```

## Configuration

Create a `.env` file based on `.env.example`:

```env
# Required for Arbitrum interaction
ALCHEMY_API_KEY=your_alchemy_api_key_here

# Required for transactions
PRIVATE_KEY=your_private_key
```

## Key Concepts

### Delta Calculation

Uniswap v3 LP positions have a continuously varying delta based on price location:
- **Below range**: Delta = 1 (100% ETH exposure)
- **In range**: Delta varies from 1 to 0 as price rises
- **Above range**: Delta = 0 (100% USDC exposure)

### Yield Sources

| Source | Expected APY | Notes |
|--------|-------------|-------|
| LP Fees (0.05% tier) | 5-15% | Volume dependent |
| LP Fees (0.3% tier) | 10-25% | Higher fee, wider range |
| Funding Rate Income | 0-20% | When receiving funding |

### Risk Management

- **Delta threshold**: Rebalance when |delta| > 5%
- **Max leverage**: 3x on perpetual positions
- **Emergency threshold**: Alert at 20% delta drift
- **Max slippage**: 1% on swaps and orders

## Contract Addresses (Arbitrum)

| Contract | Address |
|----------|---------|
| Uniswap v3 PositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| Uniswap v3 WETH/USDC Pool | `0xC6962004f452bE9203591991D15f6b388e09E8D0` |
| GMX ExchangeRouter | `0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8` |
| GMX Reader | `0xf60becbba223EEA9495Da3f606753867eC10d139` |
| Chainlink ETH/USD Feed | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` |
| USDC (Native) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |

## References

- Lambert, G. ["Pricing Uniswap v3 LP Positions: Towards a New Options Paradigm"](https://lambert-guillaume.medium.com/pricing-uniswap-v3-lp-positions-towards-a-new-options-paradigm-dce3e3b50125)
- GMX Documentation: https://docs.gmx.io/
- Uniswap v3 Documentation: https://docs.uniswap.org/

## Previous Approach

The smart contract-based approach has been archived as git tag `abandoned-v1`.
