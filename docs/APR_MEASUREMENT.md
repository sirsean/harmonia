# APR Measurement Strategy

## Problem Statement

Since Harmonia has a maximum position size and doesn't auto-compound, we cannot simply track position value growth over time to measure APR. We need alternative methods to accurately measure the strategy's yield.

## Approach 1: Fee-Based APR (Recommended) ⭐

**Concept**: Track cumulative fees earned minus costs, normalized by position size and time.

### Formula
```
APR = (Net Yield / Average Position Size) × (365 days / Time Period in days)
```

Where:
- **Net Yield** = Total Fees Collected - Total Costs Incurred
- **Total Fees Collected** = Uniswap trading fees collected
- **Total Costs Incurred** = GMX funding fees + Gas costs
- **Average Position Size** = Average NAV over the measurement period

### Advantages
- ✅ Directly measures what the strategy earns (fees)
- ✅ Accounts for all costs (funding fees, gas)
- ✅ Independent of position size changes
- ✅ Easy to understand and communicate
- ✅ Works even when position size is constant

### Implementation
1. Track fees collected when `collectFees()` is called
2. Track GMX funding fees from position snapshots
3. Track gas costs from operations
4. Calculate net yield over time periods
5. Normalize by average position size

## Approach 2: NAV-Based APR (with Cash Flow Tracking)

**Concept**: Track NAV changes, but account for withdrawals/deposits and external cash flows.

### Formula
```
APR = ((End NAV - Start NAV - Net Cash Flows) / Start NAV) × (365 / Time Period)
```

Where:
- **Net Cash Flows** = Deposits - Withdrawals - Fees Collected (external)

### Advantages
- ✅ Captures all value changes
- ✅ Works if you track all cash flows

### Disadvantages
- ❌ Requires tracking all deposits/withdrawals
- ❌ More complex to implement correctly
- ❌ Can be misleading if position size changes significantly

## Approach 3: Realized Yield Tracking

**Concept**: Track actual cash flows (fees collected, costs paid) as they occur.

### Formula
```
APR = (Cumulative Net Cash Flows / Average Position Size) × (365 / Time Period)
```

### Advantages
- ✅ Based on actual realized cash flows
- ✅ Very transparent

### Disadvantages
- ❌ Doesn't account for unrealized fees
- ❌ Requires careful tracking of all operations

## Recommended Implementation: Fee-Based APR

### Data Requirements

1. **Fees Collected** (already tracked)
   - When: When `collectFees()` is called
   - Where: `strategy_metrics.total_fees_collected_usd`
   - Also: Track per-collection event in `fee_collection_history` table

2. **GMX Funding Fees** (partially tracked)
   - When: On each monitoring snapshot
   - Where: `monitoring_snapshots` (via `gmx.pendingFunding`)
   - Need: Track cumulative funding fees paid over time

3. **Gas Costs** (already tracked)
   - When: On each operation
   - Where: `operation_history.gas_cost_usd` and `strategy_metrics.total_gas_spent_usd`

4. **Position Size** (already tracked)
   - When: On each monitoring snapshot
   - Where: `monitoring_snapshots.total_nav_usd` and `nav_history`

### Calculation Methods

#### Method 1: Period-Based APR
Calculate APR for specific time periods (daily, weekly, monthly):
```typescript
function calculatePeriodAPR(
  startTime: number,
  endTime: number,
  feesCollected: bigint,
  costsIncurred: bigint,
  averageNav: bigint
): bigint {
  const netYield = feesCollected - costsIncurred;
  const days = (endTime - startTime) / (1000 * 60 * 60 * 24);
  const apr = (netYield * 365n * PRECISION) / (averageNav * BigInt(Math.floor(days)));
  return apr;
}
```

#### Method 2: Rolling APR
Calculate APR over rolling windows (7-day, 30-day, 90-day):
```typescript
function calculateRollingAPR(
  windowDays: number,
  currentTime: number,
  // ... data from database
): bigint {
  const startTime = currentTime - (windowDays * 24 * 60 * 60 * 1000);
  // Query fees, costs, NAV for the window
  // Calculate APR
}
```

#### Method 3: Lifetime APR
Calculate APR since strategy inception:
```typescript
function calculateLifetimeAPR(
  account: string,
  // ... data from database
): bigint {
  // Get first snapshot timestamp
  // Get current metrics
  // Calculate APR over entire period
}
```

### Database Schema Additions

```sql
-- Track individual fee collection events
CREATE TABLE IF NOT EXISTS fee_collection_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  account TEXT NOT NULL,
  token_id TEXT NOT NULL,
  fees_collected_usd TEXT NOT NULL,
  fees_amount0 TEXT,
  fees_amount1 TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Track GMX funding fee snapshots
CREATE TABLE IF NOT EXISTS funding_fee_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  account TEXT NOT NULL,
  snapshot_id INTEGER,
  funding_fee_amount_usd TEXT NOT NULL,
  funding_fee_per_size TEXT NOT NULL,
  position_size_tokens TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (snapshot_id) REFERENCES monitoring_snapshots(id)
);

-- APR calculation cache (for performance)
CREATE TABLE IF NOT EXISTS apr_calculations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  account TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK(period_type IN ('daily', 'weekly', 'monthly', 'rolling_7d', 'rolling_30d', 'rolling_90d', 'lifetime')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  fees_collected_usd TEXT NOT NULL,
  costs_incurred_usd TEXT NOT NULL,
  net_yield_usd TEXT NOT NULL,
  average_nav_usd TEXT NOT NULL,
  apr_bps INTEGER NOT NULL, -- APR in basis points (1e18 precision)
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

### Reporting

Provide APR metrics in:
1. **CLI Command**: `npm run cli -- report apr --period 7d`
2. **Dashboard**: Show current APR, rolling averages
3. **Daily Reports**: Include APR in daily summary reports

### Example Output

```
APR Metrics (Last 30 Days)
===========================
Period: 2025-01-01 to 2025-01-28 (27 days)

Fees Collected:     $1,234.56
GMX Funding Fees:   -$45.67
Gas Costs:          -$12.34
Net Yield:          $1,176.55

Average NAV:        $100,000.00
Period APR:         15.89%
Annualized APR:     15.89%

Rolling APRs:
  Last 7 days:      12.34%
  Last 30 days:     15.89%
  Last 90 days:     14.56%
  Lifetime:         16.23%
```

## Implementation Priority

1. **Phase 1**: Track fee collections and funding fees in database
2. **Phase 2**: Implement APR calculation functions
3. **Phase 3**: Add APR reporting to CLI and dashboard
4. **Phase 4**: Add APR to daily reports

## Notes

- Use 30 decimals for USD values (consistent with GMX)
- Track funding fees as negative yield (costs)
- Gas costs should be included in net yield calculation
- Average NAV should be calculated from snapshots, not just start/end values
- Consider using time-weighted average NAV for more accuracy
