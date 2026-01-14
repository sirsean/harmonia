# Delta-Neutral Structured Product: Research & Implementation Plan

## Executive Summary

This document presents a comprehensive analysis and implementation plan for building a delta-neutral structured product on an EVM-compatible L2. The system will generate yield by providing concentrated liquidity on Uniswap v3 while hedging directional exposure through perpetual futures positions.

**Core Value Proposition**: Capture LP fees and potentially positive funding rates while eliminating directional price risk through continuous delta hedging.

---

## Part 1: Theoretical Foundation

### 1.1 Uniswap v3 LP Position as an Options-Like Instrument

A Uniswap v3 concentrated liquidity position is mathematically equivalent to a short put option (or covered call, depending on perspective). Guillaume Lambert's seminal work established that:

**Position Value Formula:**
```
V(S) = L * (2√S - √Pa - S/√Pb)    when Pa ≤ S ≤ Pb
V(S) = L * (√Pb - √Pa)            when S > Pb  (100% quote token)
V(S) = L * (1/√Pa - 1/√Pb) * S    when S < Pa  (100% base token)
```

Where:
- `L` = liquidity amount
- `S` = current spot price
- `Pa` = lower price bound
- `Pb` = upper price bound
- `K = √(Pa * Pb)` = strike price
- `r = √(Pb/Pa)` = range factor

### 1.2 Greeks of a Uniswap v3 Position

**Delta (∂V/∂S):**
```
δ(S) = L * (1/√S - 1/√Pb)    when Pa ≤ S ≤ Pb
δ(S) = 0                      when S > Pb
δ(S) = L * (1/√Pa - 1/√Pb)   when S < Pa
```

Key insight: Delta varies continuously within the range, starting at ~0.5 at the strike price (K) and approaching 0 as price moves toward Pb, and 1 as price moves toward Pa.

**Gamma (∂²V/∂S²):**
```
γ(S) = -L / (2 * S^(3/2))    when Pa ≤ S ≤ Pb
γ(S) = 0                      outside range
```

The negative gamma means the position loses value from price volatility (characteristic of short options).

**Practical Implications:**
- LP positions are inherently **short volatility**
- Higher volatility = higher impermanent loss
- Fee income must exceed IL + hedging costs for profitability

### 1.3 Delta-Neutral Strategy Mechanics

To achieve delta neutrality, we offset the LP position's delta with a short position in perpetual futures:

```
Net Delta = δ_LP + δ_Perp = 0
δ_Perp = -δ_LP

Short perp size = δ_LP * notional_value
```

**Example:**
- LP position: $100,000 in ETH/USDC pool
- Current delta: 0.45 (45% exposed to ETH)
- Required short: 0.45 * $100,000 = $45,000 notional short ETH-PERP

As price moves, delta changes, requiring **dynamic rebalancing**.

---

## Part 2: Protocol Selection Analysis

### 2.1 L2 Network Selection

| Network | Pros | Cons | Recommendation |
|---------|------|------|----------------|
| **Arbitrum** | GMX ecosystem, highest DeFi TVL, mature | Higher fees than Base | **Primary choice** |
| **Base** | Low fees, Coinbase backing, growing ecosystem | Synthetix sunsetting L2s | Secondary option |
| **Optimism** | Synthetix V2 (deprecated), Perp Protocol | Limited perp options now | Not recommended |

**Recommendation: Arbitrum** - Best perp protocol integration (GMX v2) with deep liquidity.

### 2.2 Perpetual Futures Protocol Selection

| Protocol | Network | Pros | Cons |
|----------|---------|------|------|
| **GMX v2** | Arbitrum | Deep liquidity, well-documented API, multi-asset | Keeper-based execution delay |
| **Synthetix Perps** | Moving to Mainnet | Oracle-based pricing | Sunsetting L2 deployments |
| **Hyperliquid** | Own L1 | 70%+ market share, low fees | Not EVM, no composability |

**Recommendation: GMX v2** - Best combination of liquidity, documentation, and smart contract composability.

### 2.3 Uniswap v3 Pool Selection Criteria

For this strategy to work, we need:

1. **USDC as quote token** - Stable side for deposits/withdrawals
2. **Base token available on perp market** - ETH, BTC (WBTC), etc.
3. **Sufficient trading volume** - Higher fees earned
4. **Appropriate fee tier** - Balance between fee income and IL

**Recommended Pools:**
- **ETH/USDC 0.05%** - Highest volume, tightest spreads
- **WBTC/USDC 0.3%** - Good volume, higher fees compensate for wider range
- **ARB/USDC 0.3%** - Native token, decent volume

---

## Part 3: System Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DeltaNeutralVault                           │
├─────────────────────────────────────────────────────────────────────┤
│  User Interface Layer                                               │
│  ├── deposit(uint256 amount)                                        │
│  ├── withdraw(uint256 shares)                                       │
│  ├── getYieldMetrics() → (1d, 7d, 30d APY)                         │
│  └── getPositionDetails() → (lpValue, perpValue, netDelta)         │
├─────────────────────────────────────────────────────────────────────┤
│  Strategy Layer                                                     │
│  ├── LiquidityManager (Uniswap v3)                                 │
│  │   ├── mintPosition()                                             │
│  │   ├── adjustRange()                                              │
│  │   ├── collectFees()                                              │
│  │   └── calculateDelta()                                           │
│  ├── HedgeManager (GMX v2)                                         │
│  │   ├── openShort()                                                │
│  │   ├── adjustPosition()                                           │
│  │   ├── closeShort()                                               │
│  │   └── collectFunding()                                           │
│  └── RebalanceController                                            │
│      ├── checkRebalanceNeeded()                                     │
│      └── executeRebalance()                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Data Layer                                                         │
│  ├── YieldAccounting                                                │
│  │   ├── trackFeeIncome()                                           │
│  │   ├── trackFundingPayments()                                     │
│  │   ├── trackRebalanceCosts()                                      │
│  │   └── calculateHistoricalYield()                                 │
│  └── PositionState                                                  │
│      ├── lpTokenId                                                  │
│      ├── perpPositionKey                                            │
│      └── lastRebalanceTimestamp                                     │
├─────────────────────────────────────────────────────────────────────┤
│  External Integrations                                              │
│  ├── Uniswap v3 NonfungiblePositionManager                         │
│  ├── GMX v2 ExchangeRouter + OrderVault                            │
│  ├── Chainlink Price Feeds                                         │
│  └── Chainlink Automation (Keepers)                                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      Keeper Infrastructure                          │
├─────────────────────────────────────────────────────────────────────┤
│  Chainlink Automation Upkeep                                        │
│  ├── checkUpkeep() - Off-chain delta monitoring                    │
│  └── performUpkeep() - Trigger rebalance when needed               │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Contract Structure

```
contracts/
├── core/
│   ├── DeltaNeutralVault.sol      # Main vault with ERC-4626
│   ├── LiquidityManager.sol       # Uniswap v3 integration
│   └── HedgeManager.sol           # GMX v2 integration
├── libraries/
│   ├── DeltaCalculator.sol        # LP position delta math
│   ├── TickMath.sol               # Price/tick conversions
│   └── YieldMath.sol              # APY calculations
├── periphery/
│   ├── SwapRouter.sol             # USDC ↔ ETH swaps
│   └── KeeperCompatible.sol       # Chainlink Automation
└── interfaces/
    ├── IUniswapV3.sol
    ├── IGMXV2.sol
    └── IChainlinkAutomation.sol
```

---

## Part 4: Core Implementation Details

### 4.1 Delta Calculation

> **Implementation:** [`contracts/libraries/DeltaCalculator.sol`](contracts/libraries/DeltaCalculator.sol)

The DeltaCalculator library provides complete delta and gamma calculations for Uniswap v3 LP positions. Key functions:

| Function | Purpose |
|----------|---------|
| `calculateDelta()` | Position delta based on price zone (below/in/above range) |
| `calculateDeltaRatio()` | Delta as percentage (0-1 scaled by 1e18) |
| `getBaseTokenAmount()` | ETH amount in position |
| `getQuoteTokenAmount()` | USDC amount in position |
| `getPositionValue()` | Total position value in quote token |
| `calculateGamma()` | Negative gamma (short volatility exposure) |
| `priceToSqrtPriceX96()` | Convert price to Uniswap Q96 format |
| `sqrtPriceX96ToPrice()` | Convert Q96 to human-readable price |

**Delta by price zone:**
- Below range (`S < Pa`): Delta = maximum (full ETH exposure)
- In range (`Pa ≤ S ≤ Pb`): Delta varies continuously from 1 to 0
- Above range (`S > Pb`): Delta = 0 (full USDC exposure)

### 4.2 GMX v2 Integration for Hedging

> **Status:** Design complete, implementation pending
> **Interfaces:** [`contracts/interfaces/IGMXV2.sol`](contracts/interfaces/IGMXV2.sol)

The HedgeManager contract will handle all GMX v2 perpetual operations for delta hedging.

**Core Operations:**

| Function | Purpose |
|----------|---------|
| `adjustHedge()` | Open/increase/decrease short position |
| `getShortPositionSize()` | Read current position from DataStore |
| `getExecutionFee()` | Calculate required keeper execution fee |
| `claimFunding()` | Collect accumulated funding payments |

**GMX v2 Integration Points:**
- `ExchangeRouter.createOrder()` - Submit market orders
- `OrderVault` - Collateral escrow for orders
- `DataStore` - Read position state and parameters
- `Reader` - Query market and position data

**Order Parameters:**
- `orderType`: `MarketIncrease` or `MarketDecrease`
- `isLong`: Always `false` (short positions only)
- `sizeDeltaUsd`: Position size change (30 decimals)
- `acceptablePrice`: Set to max for market orders

### 4.3 Rebalancing Logic

> **Status:** Design complete, implementation pending
> **Interfaces:** [`contracts/interfaces/IChainlink.sol`](contracts/interfaces/IChainlink.sol)

The RebalanceController implements Chainlink Automation for autonomous delta rebalancing.

**Rebalance Thresholds:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `DELTA_THRESHOLD` | 5% (5e16) | Trigger rebalance when exceeded |
| `MIN_REBALANCE_INTERVAL` | 1 hour | Prevent excessive rebalancing |
| `MAX_REBALANCE_INTERVAL` | 24 hours | Force periodic check |

**Chainlink Automation Flow:**

1. `checkUpkeep()` (off-chain)
   - Calculate net delta: `lpDelta + hedgeDelta`
   - Return `true` if |delta| > threshold OR max interval exceeded

2. `performUpkeep()` (on-chain)
   - Re-verify conditions
   - Call `vault.rebalance(deltaDrift)`
   - Update `lastRebalanceTime`

**Rebalance Decision Matrix:**

| Condition | Min Interval Passed? | Action |
|-----------|---------------------|--------|
| \|delta\| > 5% | Yes | Rebalance |
| \|delta\| > 5% | No | Wait |
| Time > 24h | Yes | Force rebalance |
| \|delta\| ≤ 5% | - | No action |

### 4.4 Yield Tracking System

> **Implementation:** [`contracts/libraries/YieldMath.sol`](contracts/libraries/YieldMath.sol)
> **YieldTracker contract:** Design complete, implementation pending

The YieldMath library provides APY and yield metric calculations. Key functions:

| Function | Purpose |
|----------|---------|
| `calculateAPY()` | Annualized yield from two snapshots |
| `calculateReturn()` | Simple return percentage between values |
| `periodReturnToAPY()` | Convert period return to annualized rate |
| `calculateTotalFees()` | Fee income in USD from token amounts |
| `calculateFundingAPY()` | Perpetual funding rate as APY |
| `calculateBreakevenVolatility()` | Volatility threshold for profitability |

**Yield Components:**

| Source | Tracking Method |
|--------|-----------------|
| LP Fees | Cumulative fee0/fee1 collected |
| Funding Income | Cumulative funding payments (+/-) |
| Rebalance Costs | Gas + slippage per rebalance |

**Snapshot-Based APY Calculation:**
```
APY = (netIncome / startValue) * (365 days / timeDelta)
netIncome = fees + funding - rebalanceCosts
```

The YieldTracker contract will maintain daily snapshots for calculating rolling 1/7/30 day APY metrics.

### 4.5 Main Vault Contract

> **Status:** Design complete, implementation pending
> **Interfaces:** [`contracts/interfaces/IUniswapV3.sol`](contracts/interfaces/IUniswapV3.sol)

The DeltaNeutralVault is the main entry point implementing ERC-4626 tokenized vault standard.

**Core Architecture:**

```
DeltaNeutralVault (ERC-4626)
├── deposit() → _deployCapital()
│   ├── Swap USDC → ETH (partial)
│   ├── Add liquidity to Uniswap v3
│   └── Open short hedge on GMX v2
├── withdraw() → _unwindCapital()
│   ├── Remove liquidity
│   ├── Close proportional hedge
│   └── Swap ETH → USDC
├── rebalance() ← RebalanceController
│   └── Adjust hedge to match LP delta
└── compound()
    ├── Collect LP fees
    ├── Claim funding
    └── Reinvest
```

**Key Functions:**

| Function | Purpose |
|----------|---------|
| `deposit(assets, receiver)` | Deposit USDC, receive vault shares |
| `withdraw(assets, receiver, owner)` | Burn shares, receive USDC |
| `totalAssets()` | LP value + hedge collateral + PnL |
| `calculateLPDelta()` | Current LP position delta |
| `rebalance(deltaDrift)` | Adjust hedge (keeper only) |
| `compound()` | Reinvest accrued yield |

**Dependencies:**
- `LiquidityManager` - Uniswap v3 operations
- `HedgeManager` - GMX v2 operations
- `YieldTracker` - APY calculations
- `RebalanceController` - Automation

---

## Part 5: Keeper System Design

> **Status:** Design complete, implementation pending
> **Interfaces:** [`contracts/interfaces/IChainlink.sol`](contracts/interfaces/IChainlink.sol)

### 5.1 Chainlink Automation Integration

The DeltaNeutralKeeper contract handles three automated tasks via Chainlink Automation:

**Upkeep Priority Order:**

| Priority | Type | Trigger | Action |
|----------|------|---------|--------|
| 1 | Rebalance | \|delta\| > 5% | `vault.rebalance(netDelta)` |
| 2 | Compound | 24h + fees > minimum | `vault.compound()` |
| 3 | Snapshot | 24h elapsed | `yieldTracker.recordSnapshot()` |

**Automation Flow:**
1. Chainlink nodes call `checkUpkeep()` off-chain
2. If upkeep needed, `performUpkeep()` is called on-chain
3. Gas costs paid from LINK balance in Automation Registry

**Registration:**
- Register upkeep via Chainlink Automation Registry
- Fund with LINK tokens for gas
- Set gas limit appropriate for operation (~500k for rebalance)

### 5.2 Off-Chain Monitoring (Backup)

A TypeScript monitoring script provides redundancy:
- Polls vault state every 60 seconds
- Triggers rebalance if Chainlink keeper fails
- Logs delta drift and yield metrics
- Alerts on anomalous conditions

**Monitoring Metrics:**
- Net delta percentage
- LP position value
- Hedge position size and PnL
- Pending fees and funding
- Time since last rebalance

---

## Part 6: Risk Analysis & Mitigations

### 6.1 Risk Categories

| Risk Category | Risk | Severity | Mitigation |
|--------------|------|----------|------------|
| **Market Risk** | Extreme price moves outside LP range | High | Wide range, automatic range adjustment |
| **Market Risk** | Negative funding rates | Medium | Monitor and exit if persistent |
| **Protocol Risk** | GMX liquidation | High | Conservative leverage (2-3x max) |
| **Protocol Risk** | Uniswap v3 pool manipulation | Medium | TWAP price checks |
| **Execution Risk** | Rebalance front-running | Medium | Private mempool, slippage limits |
| **Execution Risk** | Keeper failure | High | Multiple keeper redundancy |
| **Smart Contract Risk** | Bugs in vault logic | Critical | Audits, formal verification |
| **Smart Contract Risk** | Integration bugs (GMX/Uni) | High | Extensive testing, gradual rollout |

### 6.2 Position Sizing Guardrails

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `MAX_LEVERAGE` | 3x | Maximum leverage on perpetual position |
| `MAX_SINGLE_TX_PCT` | 10% | Max vault % per single transaction |
| `MIN_HEDGE_RATIO` | 80% | Minimum hedge coverage required |
| `MAX_HEDGE_RATIO` | 120% | Maximum hedge to prevent over-hedging |
| `EMERGENCY_DELTA_THRESHOLD` | 20% | Trigger emergency unwind |

### 6.3 Circuit Breakers

**Automatic Pause Conditions:**

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Delta drift | > 20% | Pause all operations |
| Liquidation proximity | < 10% margin | Pause + alert |
| Oracle deviation | > 5% from TWAP | Block rebalance |

**Emergency Unwind Flow:**
1. `emergencyUnwind()` called by owner/guardian
2. Close all GMX perpetual positions
3. Remove all Uniswap v3 liquidity
4. Swap all assets to USDC
5. Users can withdraw their share

**Recovery Process:**
- Investigate root cause
- Propose fix via governance
- Resume operations with updated parameters

---

## Part 7: Implementation Roadmap

### Completed Work

#### Phase 1: Foundation (COMPLETE)

**Deliverables:**
- [x] Project structure and build configuration
- [x] Delta calculation library with comprehensive tests
- [x] Yield math library with APY calculations
- [x] All external protocol interfaces (Uniswap v3, GMX v2, Chainlink)
- [x] Unit tests for delta and yield math

**Key Files:**
- [`contracts/libraries/DeltaCalculator.sol`](contracts/libraries/DeltaCalculator.sol) - LP delta/gamma calculations
- [`contracts/libraries/YieldMath.sol`](contracts/libraries/YieldMath.sol) - APY and yield metrics
- [`contracts/interfaces/`](contracts/interfaces/) - Protocol interface definitions

**Milestones Achieved:**
1. Delta calculator implements Guillaume Lambert's options pricing framework
2. Fork tests validate calculations against live Arbitrum pool state

#### Phase 2: Comprehensive Testing (COMPLETE)

**Deliverables:**
- [x] Priority-based scenario test suite (P0-P3)
- [x] Fork tests against Arbitrum mainnet
- [x] Test harness contracts for library testing

**Test Coverage:**
- [`test/scenarios/CriticalScenarios.test.ts`](test/scenarios/CriticalScenarios.test.ts) - P0: Liquidation, oracle attacks
- [`test/scenarios/HighPriorityScenarios.test.ts`](test/scenarios/HighPriorityScenarios.test.ts) - P1: Rebalance failures
- [`test/scenarios/MediumPriorityScenarios.test.ts`](test/scenarios/MediumPriorityScenarios.test.ts) - P2: Fee collection
- [`test/scenarios/LowerPriorityScenarios.test.ts`](test/scenarios/LowerPriorityScenarios.test.ts) - P3: Normal operations
- [`test/fork/`](test/fork/) - Live Arbitrum state validation

#### Phase 3: Core Vault Implementation (COMPLETE)

**Objective:** Build the main vault contract and deposit/withdraw flow.

**Deliverables:**
- [x] `DeltaNeutralVault.sol` - ERC-4626 vault with share accounting
- [x] Basic deposit flow (receive USDC, mint shares)
- [x] Basic withdraw flow (burn shares, return USDC)
- [x] `totalAssets()` calculation combining LP + hedge positions
- [x] Unit tests for vault operations (55 tests)

**Key Files:**
- [`contracts/core/DeltaNeutralVault.sol`](contracts/core/DeltaNeutralVault.sol) - Main ERC-4626 vault contract
- [`contracts/test/MockERC20.sol`](contracts/test/MockERC20.sol) - Mock token for testing
- [`test/unit/DeltaNeutralVault.test.ts`](test/unit/DeltaNeutralVault.test.ts) - Comprehensive vault tests

**Features Implemented:**
- Full ERC-4626 compliance (deposit, mint, withdraw, redeem)
- Deposit cap enforcement
- Pause/unpause functionality
- Emergency unwind capability
- Rebalance authorization (owner + controller)
- Manager address configuration (for Phases 4-6)
- Delta monitoring views (returning stubs for Phase 4+)
- Fee collection and funding claim interfaces (stubs)

**Architecture Decisions:**
1. Uses OpenZeppelin v5.0 for ERC-4626, Ownable, Pausable, ReentrancyGuard
2. Position value hooks prepared for LiquidityManager and HedgeManager integration
3. Delta/hedge value functions return 0 until Phases 4-5 implementation
4. Events emit placeholder values for LP/hedge values until integration

---

### Next Steps

#### Phase 4: Liquidity Management

**Objective:** Integrate with Uniswap v3 for LP position management.

**Deliverables:**
- [ ] `LiquidityManager.sol` - Uniswap v3 position operations
- [ ] Mint new LP positions with configurable range
- [ ] Collect accrued fees
- [ ] Increase/decrease liquidity
- [ ] Range adjustment (remove + re-add at new ticks)
- [ ] Integration tests with fork

**Implementation Order:**
1. Create LiquidityManager contract with position tracking
2. Implement `mintPosition()` with NonfungiblePositionManager
3. Implement `collectFees()` for fee harvesting
4. Implement `adjustLiquidity()` for size changes
5. Add range rebalancing logic

#### Phase 5: Hedge Management

**Objective:** Integrate with GMX v2 for perpetual hedging.

**Deliverables:**
- [ ] `HedgeManager.sol` - GMX v2 short position operations
- [ ] Open market short orders
- [ ] Increase/decrease position size
- [ ] Close positions
- [ ] Read position state and funding accrued
- [ ] Fork tests against GMX v2

**Implementation Order:**
1. Create HedgeManager contract with GMX integration
2. Implement `openShort()` with ExchangeRouter
3. Implement `adjustPosition()` for delta rebalancing
4. Implement position reading from DataStore
5. Add funding rate tracking

#### Phase 6: Rebalancing Automation

**Objective:** Automated delta monitoring and rebalancing.

**Deliverables:**
- [ ] `RebalanceController.sol` - Chainlink Automation keeper
- [ ] `checkUpkeep()` - Off-chain delta monitoring
- [ ] `performUpkeep()` - On-chain rebalance execution
- [ ] Yield snapshot recording
- [ ] Compound functionality

**Implementation Order:**
1. Create RebalanceController with Chainlink interface
2. Implement delta drift detection logic
3. Implement rebalance execution flow
4. Add time-based constraints (min/max intervals)
5. Integrate yield tracking

#### Phase 7: Security Hardening

**Objective:** Prepare for production deployment.

**Deliverables:**
- [ ] Emergency pause mechanism
- [ ] Circuit breakers for critical conditions
- [ ] Gas optimization pass
- [ ] Slippage protection
- [ ] Access control review
- [ ] Internal security audit

**Target Metrics:**
- Rebalance gas cost < 500k
- Emergency unwind gas < 1M
- Zero high/critical findings

#### Phase 8: Deployment

**Objective:** Launch on Arbitrum mainnet.

**Deliverables:**
- [ ] Deployment scripts for all contracts
- [ ] Contract verification on Arbiscan
- [ ] Chainlink Automation upkeep registration
- [ ] Initial deposit cap ($10k)
- [ ] Monitoring and alerting setup
- [ ] External audit engagement

**Launch Criteria:**
- 2 weeks testnet operation without issues
- Internal audit complete
- External audit scheduled

---

## Part 8: Expected Economics

### 8.1 Revenue Sources

| Source | Expected Range | Notes |
|--------|---------------|-------|
| LP Fees (ETH/USDC 0.05%) | 5-15% APY | Volume dependent |
| LP Fees (ETH/USDC 0.3%) | 10-25% APY | Higher fee tier |
| Perp Funding (when receiving) | 0-20% APY | Market dependent |

### 8.2 Cost Sources

| Cost | Expected Range | Notes |
|------|---------------|-------|
| Perp Funding (when paying) | 0-30% APY | Market dependent |
| Rebalance gas | 0.1-0.5% APY | Frequency dependent |
| Swap slippage | 0.05-0.2% per rebalance | Size dependent |
| GMX borrowing fees | 0.01-0.1% per day | Utilization dependent |

### 8.3 Target Net Yield

**Conservative estimate**: 5-15% APY in normal market conditions
**Bull case**: 20-30% APY with favorable funding rates
**Bear case**: 0-5% APY with negative funding

---

## Part 9: Technology Stack Summary

```
Smart Contracts:
├── Solidity 0.8.19+
├── OpenZeppelin (ERC4626, ReentrancyGuard)
├── Uniswap v3 SDK
└── Chainlink Automation

External Protocols:
├── Uniswap v3 (Arbitrum)
├── GMX v2 (Arbitrum)
├── Chainlink (Price Feeds + Automation)
└── (Optional) Gelato as backup keeper

Development:
├── Foundry (testing + deployment)
├── Hardhat (optional, for coverage)
└── TypeScript (keeper scripts)

Monitoring:
├── Tenderly (transaction simulation)
├── OpenZeppelin Defender (alerts)
└── Custom dashboard (yield metrics)
```

---

## Appendix A: Key Contract Addresses (Arbitrum)

```
Uniswap v3:
- NonfungiblePositionManager: 0xC36442b4a4522E871399CD717aBDD847Ab11FE88
- SwapRouter: 0xE592427A0AEce92De3Edee1F18E0157C05861564
- Factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984
- ETH/USDC 0.05% Pool: 0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443

GMX v2:
- ExchangeRouter: 0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8
- OrderVault: 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5
- DataStore: 0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8
- ETH/USD Market: 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336

Chainlink:
- ETH/USD Feed: 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
- Automation Registry: 0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1

Tokens:
- USDC: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
- WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
```

---

## Appendix B: References

1. Lambert, G. "Pricing Uniswap v3 LP Positions: Towards a New Options Paradigm" (2021)
2. Lambert, G. "Understanding the Value of Uniswap v3 Liquidity Positions" (2021)
3. Khakhar, A. & Chen, X. "Delta Hedging Liquidity Positions on Automated Market Makers" (2022)
4. Elsts, A. "Liquidity Math in Uniswap V3" Technical Note
5. GMX Documentation: https://docs.gmx.io/
6. Uniswap v3 Documentation: https://docs.uniswap.org/
7. Chainlink Automation Documentation: https://docs.chain.link/chainlink-automation

---

*Document prepared for Sean - January 2026*
