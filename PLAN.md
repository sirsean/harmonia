# Delta-Neutral Yield Strategy: EOA-Based Implementation

## Executive Summary

This document presents the implementation plan for a delta-neutral yield strategy using an EOA (Externally Owned Account) with TypeScript scripts/programs. The system generates yield by providing concentrated liquidity on Uniswap v3 while hedging directional exposure through GMX v2 perpetual short positions on Arbitrum.

**Core Value Proposition**: Capture LP fees and potentially positive funding rates while eliminating directional price risk through continuous delta hedging.

**Why EOA-Based**: Instead of deploying complex smart contracts, we use a simple EOA wallet managed by TypeScript programs. This approach is:
- Simpler to build and iterate on
- Easier to debug and monitor
- Lower gas costs (no proxy overhead)
- Flexible for strategy adjustments
- No audit requirements for contract deployment

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

## Part 2: System Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EOA Wallet                                  │
│                   (Holds tokens and positions)                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Assets:                                                            │
│  ├── USDC (collateral and quote token)                             │
│  ├── WETH (base token for LP)                                      │
│  └── Uniswap V3 LP NFT Position                                    │
│                                                                     │
│  Positions:                                                         │
│  ├── Uniswap V3 Concentrated Liquidity Position                    │
│  └── GMX V2 Short Perpetual Position                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    TypeScript Control Layer                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  src/                                                               │
│  ├── modules/                                                       │
│  │   ├── gmx/           # GMX V2 perpetual operations              │
│  │   │   ├── reader.ts      # Read positions, prices, markets      │
│  │   │   ├── orders.ts      # Create/close orders                  │
│  │   │   └── types.ts       # GMX-specific types                   │
│  │   │                                                              │
│  │   ├── uniswap/       # Uniswap V3 LP operations                 │
│  │   │   ├── reader.ts      # Read positions, pool state           │
│  │   │   ├── liquidity.ts   # Mint/adjust/remove liquidity         │
│  │   │   ├── fees.ts        # Collect fees                         │
│  │   │   └── types.ts       # Uniswap-specific types               │
│  │   │                                                              │
│  │   ├── math/          # Core calculations (ported from Solidity) │
│  │   │   ├── delta.ts       # Delta/gamma calculations             │
│  │   │   ├── yield.ts       # APY and yield calculations           │
│  │   │   ├── ticks.ts       # Tick math utilities                  │
│  │   │   └── sqrt-price.ts  # sqrtPriceX96 conversions             │
│  │   │                                                              │
│  │   └── chainlink/     # Price feed operations                    │
│  │       ├── price.ts       # Get current prices                   │
│  │       └── types.ts       # Chainlink types                      │
│  │                                                                  │
│  ├── strategy/          # Strategy orchestration                   │
│  │   ├── monitor.ts         # Position monitoring loop             │
│  │   ├── rebalance.ts       # Delta rebalancing logic              │
│  │   ├── compound.ts        # Fee collection & reinvestment        │
│  │   └── range-adjust.ts    # LP range adjustment                  │
│  │                                                                  │
│  ├── config/            # Configuration                            │
│  │   ├── addresses.ts       # Contract addresses                   │
│  │   ├── markets.ts         # Market configurations                │
│  │   └── strategy.ts        # Strategy parameters                  │
│  │                                                                  │
│  └── utils/             # Shared utilities                         │
│      ├── provider.ts        # Ethers provider/signer               │
│      ├── logger.ts          # Logging utilities                    │
│      └── format.ts          # Number formatting                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Module Responsibilities

#### GMX Module (`src/modules/gmx/`)

Handles all GMX V2 perpetual operations:

| Function | Purpose |
|----------|---------|
| `getPosition()` | Read current short position details |
| `getPositions()` | List all positions for account |
| `createShort()` | Open new short position |
| `increaseShort()` | Increase existing short size |
| `decreaseShort()` | Decrease short size |
| `closeShort()` | Close entire short position |
| `getExecutionFee()` | Calculate required execution fee |
| `getMarketPrice()` | Get current market price |

Based on existing scripts:
- `scripts/gmx-open-short.ts`
- `scripts/gmx-close-short.ts`
- `scripts/gmx-read-position.ts`

#### Uniswap Module (`src/modules/uniswap/`)

Handles all Uniswap V3 LP operations:

| Function | Purpose |
|----------|---------|
| `getPosition()` | Read LP position details (liquidity, ticks, fees) |
| `getPoolState()` | Get current pool price and tick |
| `mintPosition()` | Create new LP position |
| `increaseLiquidity()` | Add liquidity to existing position |
| `decreaseLiquidity()` | Remove liquidity from position |
| `collectFees()` | Collect accrued trading fees |
| `closePosition()` | Remove all liquidity and collect fees |
| `adjustRange()` | Close and remint at new tick range |

#### Math Module (`src/modules/math/`)

Core calculations ported from Solidity libraries:

| Function | Purpose |
|----------|---------|
| `calculateDelta()` | LP position delta based on price zone |
| `calculateDeltaRatio()` | Delta as percentage (0-1) |
| `calculateGamma()` | Position gamma (rate of delta change) |
| `getBaseTokenAmount()` | ETH amount in position |
| `getQuoteTokenAmount()` | USDC amount in position |
| `getPositionValue()` | Total position value in USD |
| `calculateAPY()` | Annualized yield from snapshots |
| `priceToSqrtPriceX96()` | Convert price to Q96 format |
| `sqrtPriceX96ToPrice()` | Convert Q96 to human-readable |
| `tickToPrice()` | Convert tick to price |
| `priceToTick()` | Convert price to tick |

#### Strategy Module (`src/strategy/`)

Orchestrates the delta-neutral strategy:

| Component | Purpose |
|-----------|---------|
| `monitor.ts` | Main loop that checks positions and triggers actions |
| `rebalance.ts` | Adjusts GMX short to match LP delta |
| `compound.ts` | Collects fees and reinvests |
| `range-adjust.ts` | Adjusts LP range when price moves out |

---

## Part 3: Core Implementation Details

### 3.1 Delta Calculation (TypeScript)

```typescript
// src/modules/math/delta.ts

const Q96 = BigInt(2) ** BigInt(96);
const PRECISION = BigInt(10) ** BigInt(18);

interface DeltaResult {
  delta: bigint;        // Raw delta in base token units
  deltaRatio: bigint;   // Delta as ratio (0-1e18)
  zone: 'below' | 'in' | 'above';
}

/**
 * Calculate LP position delta
 * @param sqrtPriceX96 Current pool price in Q96 format
 * @param sqrtPaX96 Lower bound sqrt price
 * @param sqrtPbX96 Upper bound sqrt price
 * @param liquidity Position liquidity
 */
function calculateDelta(
  sqrtPriceX96: bigint,
  sqrtPaX96: bigint,
  sqrtPbX96: bigint,
  liquidity: bigint
): DeltaResult {
  // Below range: full ETH exposure
  if (sqrtPriceX96 <= sqrtPaX96) {
    const delta = (liquidity * Q96 * (sqrtPbX96 - sqrtPaX96)) /
                  (sqrtPaX96 * sqrtPbX96);
    return { delta, deltaRatio: PRECISION, zone: 'below' };
  }

  // Above range: no ETH exposure
  if (sqrtPriceX96 >= sqrtPbX96) {
    return { delta: 0n, deltaRatio: 0n, zone: 'above' };
  }

  // In range: partial exposure
  const delta = (liquidity * Q96 * (sqrtPbX96 - sqrtPriceX96)) /
                (sqrtPriceX96 * sqrtPbX96);

  const maxDelta = (liquidity * Q96 * (sqrtPbX96 - sqrtPaX96)) /
                   (sqrtPaX96 * sqrtPbX96);

  const deltaRatio = (delta * PRECISION) / maxDelta;

  return { delta, deltaRatio, zone: 'in' };
}
```

### 3.2 Rebalancing Logic

```typescript
// src/strategy/rebalance.ts

interface RebalanceConfig {
  deltaThreshold: bigint;      // e.g., 5e16 (5%)
  minRebalanceInterval: number; // e.g., 3600 (1 hour)
  maxSlippage: bigint;         // e.g., 1e16 (1%)
}

async function checkAndRebalance(
  config: RebalanceConfig,
  lastRebalanceTime: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);

  // Respect minimum interval
  if (now - lastRebalanceTime < config.minRebalanceInterval) {
    return false;
  }

  // Get current positions
  const lpPosition = await uniswap.getPosition();
  const shortPosition = await gmx.getPosition();

  // Calculate LP delta
  const poolState = await uniswap.getPoolState();
  const lpDelta = math.calculateDelta(
    poolState.sqrtPriceX96,
    lpPosition.sqrtPaX96,
    lpPosition.sqrtPbX96,
    lpPosition.liquidity
  );

  // Calculate current hedge (short position delta is negative)
  const hedgeDelta = -shortPosition.sizeInTokens;

  // Net delta
  const netDelta = lpDelta.delta + hedgeDelta;
  const deltaDrift = abs(netDelta) / lpDelta.delta;

  // Check if rebalance needed
  if (deltaDrift < config.deltaThreshold) {
    return false;
  }

  // Execute rebalance
  if (netDelta > 0) {
    // Increase short
    await gmx.increaseShort(netDelta);
  } else {
    // Decrease short
    await gmx.decreaseShort(-netDelta);
  }

  return true;
}
```

### 3.3 Compounding Logic

```typescript
// src/strategy/compound.ts

async function compoundFees(): Promise<void> {
  // 1. Collect LP fees
  const fees = await uniswap.collectFees();

  // 2. Calculate new LP amounts
  const poolState = await uniswap.getPoolState();
  const price = math.sqrtPriceX96ToPrice(poolState.sqrtPriceX96);

  // 3. Swap if needed to match pool ratio
  const ratio = calculatePoolRatio(price, tickLower, tickUpper);
  // ... swap logic

  // 4. Add liquidity
  await uniswap.increaseLiquidity(amount0, amount1);

  // 5. Adjust hedge for new delta
  await rebalance();
}
```

---

## Part 4: Strategy Parameters

### 4.1 Rebalancing Thresholds

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `DELTA_THRESHOLD` | 5% | Trigger rebalance when drift exceeds |
| `MIN_REBALANCE_INTERVAL` | 1 hour | Prevent excessive rebalancing |
| `MAX_REBALANCE_INTERVAL` | 24 hours | Force periodic check |
| `EMERGENCY_THRESHOLD` | 20% | Alert/pause if drift exceeds |

### 4.2 Position Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `MAX_LEVERAGE` | 3x | Maximum GMX leverage |
| `LP_RANGE_WIDTH` | ±10% | Default LP tick range |
| `MIN_POSITION_SIZE` | $1000 | Minimum viable position |
| `MAX_SLIPPAGE` | 1% | Maximum acceptable slippage |

### 4.3 Compounding Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `MIN_COMPOUND_INTERVAL` | 24 hours | Minimum time between compounds |
| `MIN_FEE_THRESHOLD` | $10 | Minimum fees to trigger compound |

---

## Part 5: Expected Economics

### 5.1 Revenue Sources

| Source | Expected Range | Notes |
|--------|---------------|-------|
| LP Fees (ETH/USDC 0.05%) | 5-15% APY | Volume dependent |
| LP Fees (ETH/USDC 0.3%) | 10-25% APY | Higher fee tier |
| Perp Funding (when receiving) | 0-20% APY | Market dependent |

### 5.2 Cost Sources

| Cost | Expected Range | Notes |
|------|---------------|-------|
| Perp Funding (when paying) | 0-30% APY | Market dependent |
| Rebalance gas | 0.1-0.5% APY | Frequency dependent |
| Swap slippage | 0.05-0.2% per rebalance | Size dependent |
| GMX borrowing fees | 0.01-0.1% per day | Utilization dependent |

### 5.3 Target Net Yield

**Conservative estimate**: 5-15% APY in normal market conditions
**Bull case**: 20-30% APY with favorable funding rates
**Bear case**: 0-5% APY with negative funding

---

## Part 6: Implementation Roadmap

### Phase 1: Core Modules (Current)

**Objective:** Build foundational modules for protocol interactions

**Deliverables:**
- [x] GMX module (reader, orders)
- [x] Uniswap module (reader, liquidity, fees)
- [x] Math module (delta, yield calculations)
- [x] Chainlink module (price feeds)
- [ ] Configuration system

**Key Files to Create:**
- `src/modules/gmx/reader.ts`
- `src/modules/gmx/orders.ts`
- `src/modules/uniswap/reader.ts`
- `src/modules/uniswap/liquidity.ts`
- `src/modules/math/delta.ts`
- `src/modules/math/yield.ts`

### Phase 2: Strategy Layer

**Objective:** Build strategy orchestration

**Deliverables:**
- [x] Position monitoring loop (`DeltaNeutralMonitor`)
    - [x] `monitor-position` CLI script (Harness)
    - [x] Multiple position support (Aggregation)
    - [x] USD value estimation for adjustments
- [x] Rebalance execution
    - [x] `RebalanceManager` implemented with collateral and slippage calculation
    - [x] `execute-rebalance` CLI script
- [ ] Compounding logic
- [ ] Range adjustment

### Phase 3: Operations

**Objective:** Build operational tooling

**Deliverables:**
- [ ] CLI commands for manual operations
- [ ] Monitoring dashboard/logs
- [ ] Alert system
- [ ] Position reporting

### Phase 4: Automation

**Objective:** Automated strategy execution

**Deliverables:**
- [ ] Cron-based monitoring
- [ ] Automated rebalancing
- [ ] Automated compounding
- [ ] Error recovery

---

## Part 7: Contract Addresses (Arbitrum)

### Protocol Infrastructure

```
Uniswap v3:
- Factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984
- NonfungiblePositionManager: 0xC36442b4a4522E871399CD717aBDD847Ab11FE88
- SwapRouter: 0xE592427A0AEce92De3Edee1F18E0157C05861564
- Quoter: 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6

GMX v2:
- ExchangeRouter: 0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41
- OrderVault: 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5
- DataStore: 0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8
- Reader: 0xf60becbba223EEA9495Da3f606753867eC10d139

Chainlink:
- ETH/USD Feed: 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
```

### Markets

```
ETH Market:
- Uniswap Pool (WETH/USDC 0.05%): 0xC6962004f452bE9203591991D15f6b388e09E8D0
- GMX Market (ETH/USD): 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336

Tokens:
- USDC (Native): 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
- WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
```

---

## Appendix A: Migration from Smart Contracts

The previous approach (tagged as `abandoned-v1`) used Solidity smart contracts:
- `DeltaNeutralVault.sol` - ERC-4626 vault
- `LiquidityManager.sol` - Uniswap V3 operations
- `HedgeManager.sol` - GMX V2 operations
- `RebalanceController.sol` - Chainlink Automation keeper

Key learnings preserved:
1. Delta calculation math (ported to TypeScript)
2. GMX V2 order creation patterns (from scripts)
3. Uniswap V3 position management patterns
4. Strategy parameters and thresholds

---

## Appendix B: References

1. Lambert, G. "Pricing Uniswap v3 LP Positions: Towards a New Options Paradigm" (2021)
2. Lambert, G. "Understanding the Value of Uniswap v3 Liquidity Positions" (2021)
3. Khakhar, A. & Chen, X. "Delta Hedging Liquidity Positions on Automated Market Makers" (2022)
4. Elsts, A. "Liquidity Math in Uniswap V3" Technical Note
5. GMX Documentation: https://docs.gmx.io/
6. Uniswap v3 Documentation: https://docs.uniswap.org/

---

*Document prepared for Sean - January 2026*
