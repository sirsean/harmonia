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

#### Phase 4: Liquidity Management (COMPLETE)

**Objective:** Integrate with Uniswap v3 for LP position management.

**Deliverables:**
- [x] `LiquidityManager.sol` - Uniswap v3 position operations
- [x] Mint new LP positions with configurable range
- [x] Collect accrued fees
- [x] Increase/decrease liquidity
- [x] Range adjustment (remove + re-add at new ticks)
- [x] Integration tests with fork
- [x] DeltaNeutralVault integration

**Key Files:**
- [`contracts/core/LiquidityManager.sol`](contracts/core/LiquidityManager.sol) - Uniswap v3 position management
- [`contracts/interfaces/ILiquidityManager.sol`](contracts/interfaces/ILiquidityManager.sol) - Interface definition
- [`contracts/test/MockUniswapV3.sol`](contracts/test/MockUniswapV3.sol) - Mock contracts for unit testing
- [`test/unit/LiquidityManager.test.ts`](test/unit/LiquidityManager.test.ts) - Comprehensive unit tests (47 tests)
- [`test/fork/LiquidityManagerFork.test.ts`](test/fork/LiquidityManagerFork.test.ts) - Fork tests against Arbitrum

**Features Implemented:**
- Position lifecycle management (mint, increase, decrease, close)
- Fee collection with vault integration
- Range adjustment (atomic close and re-mint at new ticks)
- Delta and position value calculations using DeltaCalculator library
- Slippage tolerance configuration
- Tick-to-sqrtPriceX96 conversion (Uniswap TickMath)
- Comprehensive view functions for position monitoring

**Architecture Decisions:**
1. LiquidityManager holds NFT positions, vault controls operations via interface
2. Owner and vault can both call position management functions
3. Refund mechanism returns unused tokens after minting
4. Uses DeltaCalculator library for delta/gamma calculations
5. Integrated with DeltaNeutralVault via ILiquidityManager interface

**Test Coverage:**
- 47 unit tests covering all operations and edge cases
- Fork tests validate against real Arbitrum Uniswap V3 contracts
- Access control tests for vault-only functions
- Slippage and deadline validation tests

#### Phase 5: Hedge Management (COMPLETE)

**Objective:** Integrate with GMX v2 for perpetual hedging.

**Deliverables:**
- [x] `HedgeManager.sol` - GMX v2 short position operations
- [x] Open market short orders
- [x] Increase/decrease position size
- [x] Close positions
- [x] Read position state and funding accrued
- [x] Fork tests against GMX v2
- [x] DeltaNeutralVault integration

**Key Files:**
- [`contracts/core/HedgeManager.sol`](contracts/core/HedgeManager.sol) - GMX v2 perpetual position management
- [`contracts/interfaces/IHedgeManager.sol`](contracts/interfaces/IHedgeManager.sol) - Interface definition
- [`contracts/test/MockGMXV2.sol`](contracts/test/MockGMXV2.sol) - Mock contracts for unit testing
- [`test/unit/HedgeManager.test.ts`](test/unit/HedgeManager.test.ts) - Comprehensive unit tests (59 tests)
- [`test/fork/HedgeManagerFork.test.ts`](test/fork/HedgeManagerFork.test.ts) - Fork tests against Arbitrum

**Features Implemented:**
- Short position lifecycle management (open, increase, decrease, close)
- Hedge adjustment for delta rebalancing (`adjustHedge`)
- Position value and delta calculations
- Funding fee claiming and tracking
- Leverage validation (max 3x)
- Slippage protection with configurable tolerance
- Integration with Chainlink price feeds
- Comprehensive view functions for position monitoring

**Architecture Decisions:**
1. HedgeManager holds positions, vault controls operations via interface
2. Owner and vault can both call position management functions
3. Uses GMX v2 market orders for reliable execution
4. Supports execution fee refunds for excess ETH
5. Integrated with DeltaNeutralVault via IHedgeManager interface

**Test Coverage:**
- 59 unit tests covering all operations and edge cases
- Fork tests validate against real Arbitrum GMX v2 contracts
- Access control tests for vault-only functions
- Leverage and position size validation tests
- ETH handling and refund tests

---

### Next Steps

#### Phase 6: Rebalancing Automation

**Objective:** Automated delta monitoring and rebalancing.

**Deliverables:**
- [x] `RebalanceController.sol` - Chainlink Automation keeper
- [x] `checkUpkeep()` - Off-chain delta monitoring
- [x] `performUpkeep()` - On-chain rebalance/maintenance execution
- [x] Yield snapshot recording (event-based via `SnapshotRecorded`)
- [x] Compound functionality (time-based keeper calls to `vault.compound()`)

**Implementation Order:**
1. Create RebalanceController with Chainlink interface
2. Implement delta drift detection logic
3. Implement rebalance execution flow
4. Add time-based constraints (min/max intervals)
5. Integrate yield tracking

#### Phase 7: Security Hardening (COMPLETE)

**Objective:** Prepare for production deployment.

**Deliverables:**
- [x] Emergency pause mechanism
- [x] Circuit breakers for critical conditions
- [x] Gas optimization pass
- [x] Slippage protection
- [x] Access control review
- [x] Internal security audit

**Key Files:**
- [`contracts/libraries/SecurityModule.sol`](contracts/libraries/SecurityModule.sol) - Reusable security utilities
- [`test/unit/SecurityHardening.test.ts`](test/unit/SecurityHardening.test.ts) - Security unit tests (20 tests)
- [`test/fork/SecurityHardeningFork.test.ts`](test/fork/SecurityHardeningFork.test.ts) - Fork tests against Arbitrum

**Features Implemented:**

*Circuit Breakers:*
- Automatic circuit breaker when delta drift exceeds 20% (EMERGENCY_THRESHOLD)
- Manual circuit breaker trigger by owner or guardian
- Circuit breaker blocks regular user withdrawals/redemptions
- Owner/guardian can still operate during circuit breaker
- Circuit breaker reset requires delta to be within safe range

*Withdrawal Protection:*
- Maximum single withdrawal: 25% of total assets
- Large withdrawal cooldown: 1 hour between withdrawals > 10%
- Rate limiting prevents rapid fund extraction

*Oracle Security:*
- Oracle staleness checks (max 1 hour)
- Invalid/negative price rejection
- Incomplete round detection
- TWAP validation against spot price (max 3% deviation)
- Pool price vs Chainlink price cross-validation

*Access Control:*
- Guardian role for emergency operations
- Two-tier authorization (owner + guardian)
- Separate authorization for different operation types

*Leverage Monitoring:*
- Emergency leverage threshold (2.8x) warning
- Liquidation margin calculation
- Position health validation before operations

**Target Metrics (Achieved):**
- Circuit breaker trigger gas: < 100k ✓
- Withdrawal with security checks: < 200k gas ✓
- All 281 tests passing ✓

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

## Part 10: Multi-Market Configuration

The system is designed to support multiple token pairs beyond ETH/USDC, enabling deployment of specialized vaults like harmonia-ETH, harmonia-BTC, harmonia-ARB with different yield/risk characteristics.

### 10.1 Supported Markets

| Market | Base Token | Uniswap Pool | GMX Market | Expected APY | Risk Level |
|--------|------------|--------------|------------|--------------|------------|
| **ETH** | WETH (18 dec) | ETH/USDC 0.05% | ETH/USD | 5-20% | Moderate |
| **BTC** | WBTC (8 dec) | WBTC/USDC 0.3% | BTC/USD | 3-15% | Moderate |
| **ARB** | ARB (18 dec) | ARB/USDC 0.3% | ARB/USD | 10-40% | Aggressive |
| **LINK** | LINK (18 dec) | LINK/USDC 0.3% | LINK/USD | 8-30% | Aggressive |

### 10.2 Market Configuration Structure

Each market requires:
1. **Uniswap V3 Pool** - For LP position
2. **GMX V2 Market** - For perpetual hedge
3. **Chainlink Price Feed** - For price verification
4. **Matching tokens** - Base token must match across all components

```typescript
interface MarketConfig {
  id: string;                    // "ETH", "BTC", "ARB"
  baseToken: TokenConfig;        // Volatile token (what we hedge)
  quoteToken: TokenConfig;       // Stable token (USDC)
  uniswapPool: UniswapPoolConfig;
  gmxMarket: GMXMarketConfig;
  chainlinkFeed: ChainlinkFeedConfig;
  baseTokenIsToken0: boolean;    // Token ordering in pool
  strategyParams: StrategyParams;
}
```

### 10.3 Scripts

```bash
# Validate a market configuration
MARKET=ETH npx hardhat run scripts/validate-market.ts --network hardhat

# Discover viable markets for a token
TOKEN=GMX npx hardhat run scripts/discover-markets.ts --network hardhat

# Evaluate custom contract addresses
UNISWAP_POOL=0x... GMX_MARKET=0x... CHAINLINK_FEED=0x... \
  npx hardhat run scripts/evaluate-custom-market.ts --network hardhat

# Deploy a vault for a market
MARKET=ETH npx hardhat run scripts/deploy-vault.ts --network arbitrum
```

### 10.4 Deployment Process

1. **Select Market**: Choose from pre-configured markets or create new config
2. **Validate**: Run `validate-market.ts` to verify all components
3. **Deploy**: Run `deploy-vault.ts` with appropriate market
4. **Configure**: Set strategy parameters and keeper
5. **Seed**: Provide initial liquidity
6. **Enable**: Open deposits

### 10.5 Adding New Markets

To add support for a new token pair:

1. **Discover components**:
   ```bash
   TOKEN=NEW_TOKEN npx hardhat run scripts/discover-markets.ts
   ```

2. **Add to registry** (`src/markets/registry.ts`):
   ```typescript
   export const NEW_MARKET: MarketConfig = {
     id: "NEW",
     name: "Harmonia NEW",
     // ... configuration from discovery output
   };
   ```

3. **Validate configuration**:
   ```bash
   MARKET=NEW npx hardhat run scripts/validate-market.ts
   ```

4. **Deploy**:
   ```bash
   MARKET=NEW npx hardhat run scripts/deploy-vault.ts --network arbitrum
   ```

### 10.6 Token Decimal Handling

Different tokens have different decimal places, which affects price calculations:

| Token | Decimals | Decimal Adjustment vs USDC |
|-------|----------|---------------------------|
| WETH | 18 | 10^12 |
| ARB | 18 | 10^12 |
| LINK | 18 | 10^12 |
| WBTC | 8 | 10^2 |
| USDC | 6 | - |

The `MarketConfig.decimalAdjustment` field handles this automatically.

---

## Appendix A: Key Contract Addresses (Arbitrum)

### Protocol Infrastructure (shared across all markets)

```
Uniswap v3:
- Factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984
- NonfungiblePositionManager: 0xC36442b4a4522E871399CD717aBDD847Ab11FE88
- SwapRouter: 0xE592427A0AEce92De3Edee1F18E0157C05861564
- Quoter: 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6

GMX v2:
- ExchangeRouter: 0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8
- OrderVault: 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5
- DataStore: 0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8
- Reader: 0xf60becbba223EEA9495Da3f606753867eC10d139

Chainlink:
- Automation Registry: 0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1
```

### Market-Specific Addresses

```
ETH Market:
- Uniswap Pool (WETH/USDC 0.05%): 0xC6962004f452bE9203591991D15f6b388e09E8D0
- GMX Market (ETH/USD): 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336
- Chainlink Feed (ETH/USD): 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612

BTC Market:
- Uniswap Pool (WBTC/USDC 0.3%): 0xac70bD92F89e6739B3a08Db9B6081a923912f73D
- GMX Market (BTC/USD): 0x47c031236e19d024b42f8AE6780E44A573170703
- Chainlink Feed (BTC/USD): 0x6ce185860a4963106506C203335A2910525d22AD

ARB Market:
- Uniswap Pool (ARB/USDC 0.3%): 0xC6F780497A95e246EB9449f5e4770916DCd6396A
- GMX Market (ARB/USD): 0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407
- Chainlink Feed (ARB/USD): 0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6

LINK Market:
- Uniswap Pool (LINK/USDC 0.3%): 0x655B739E0b3BB00D6b74BBCd5C9169aEb0aa2e68
- GMX Market (LINK/USD): 0x7f1fa204bb700853D36994DA19F830b6Ad18455C
- Chainlink Feed (LINK/USD): 0x86E53CF1B870786351Da77A57575e79CB55812CB
```

### Tokens

```
Stablecoins:
- USDC (Native): 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
- USDC.e (Bridged): 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8

Base Tokens:
- WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
- WBTC: 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f
- ARB: 0x912CE59144191C1204E64559FE8253a0e49E6548
- LINK: 0xf97f4df75117a78c1A5a0DBb814Af92458539FB4
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
