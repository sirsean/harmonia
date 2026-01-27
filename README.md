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
├── scripts/                      # Legacy scripts (use CLI instead)
├── src/
│   ├── cli/                      # Unified CLI interface
│   ├── modules/                  # Core protocol modules
│   │   ├── gmx/                  # GMX V2 operations
│   │   ├── uniswap/              # Uniswap V3 operations
│   │   └── math/                 # Delta/yield calculations
│   └── strategy/                 # Strategy orchestration
├── docs/
│   ├── CLI.md                    # CLI documentation
│   └── DATABASE.md               # Database setup and migrations
├── PLAN.md                       # Technical specification
└── AGENTS.md                     # Development guidelines
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

The project includes a unified CLI interface for all operations. See `docs/CLI.md` for complete documentation.

### Quick Start

```bash
# Monitor your delta-neutral positions
npm run cli -- monitor --network arbitrum

# Read GMX positions
npm run cli -- gmx read-position --network arbitrum

# Read Uniswap positions
npm run cli -- uniswap read-position --network arbitrum
```

### Common Commands

**Reading Positions:**
```bash
# GMX positions
npm run cli -- gmx read-position --network arbitrum

# Uniswap positions
npm run cli -- uniswap read-position --network arbitrum

# Monitor all positions (one-time check)
npm run cli -- monitor --network arbitrum

# Run monitoring daemon (continuous, stores to database)
npm run cli -- daemon --network arbitrum
```

**GMX Operations:**
```bash
# Open short position
npm run cli -- gmx open-short --network arbitrum --collateral 20 --size 100

# Close short position
npm run cli -- gmx close-short --network arbitrum --market <market-address>

# Read pending orders
npm run cli -- gmx read-orders --network arbitrum
```

**Using Environment Variables:**
```bash
# Set network once for all commands
export NETWORK=arbitrum

npm run cli -- monitor
npm run cli -- gmx read-position
npm run cli -- uniswap read-position
```

### Tests

```bash
# Runs unit + integration tests. Integration tests use cassette replays when available.
npm test
```

## Configuration

Create a `.env` file based on `.env.example`:

```env
# Required for Arbitrum interaction
ALCHEMY_API_KEY=your_alchemy_api_key_here

# Required for transactions
PRIVATE_KEY=your_private_key

# Optional: Discord alerts
DISCORD_CHANNEL_ID=your_discord_channel_id_here
DISCORD_APP_TOKEN=your_discord_bot_token_here
```

### Discord Alerts

The strategy can send alerts to Discord when important events occur:

- **Error alerts**: Sent when monitor checks fail or optimizations encounter errors
- **Warning alerts**: Sent when positions are out of range or delta drift is high
- **Success alerts**: Sent when optimizations complete successfully

To enable Discord alerts:

1. Create a Discord bot in the [Discord Developer Portal](https://discord.com/developers/applications)
2. Get your bot token (`DISCORD_APP_TOKEN`)
3. Get the channel ID where you want alerts sent (`DISCORD_CHANNEL_ID`)
   - Enable Developer Mode in Discord settings
   - Right-click the channel and select "Copy ID"
4. Add the bot to your server with permissions to send messages
5. Add both values to your `.env` file

If Discord is not configured, alerts will be skipped gracefully without affecting strategy operations.

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
