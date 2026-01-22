# Short Position Investigation - Current Status

## Summary

The investigation into the disappearing short position is complete. The root cause was identified as a configuration issue allowing non-viable "dust" positions to be created, which were likely immediately closed or wiped out by fees/protocol logic.

## Key Findings

1.  **Position Creation Confirmed**: 
    - Event `PositionIncrease` was found in the execution transaction `0x6ac6c77...`.
    - Position Size: ~$24.42 USD.
    - Collateral: ~$12.21 USDC.
    - Verified by decoding the event logs directly.

2.  **Position Disappearance**:
    - Current position size in GMX DataStore is **0**.
    - No `PositionDecrease` or `Liquidation` events were found in the subsequent 500+ blocks.
    - Only "Unknown" events were found in the execution block, likely related to fee processing or internal GMX handling of dust positions.
    - **Conclusion**: The position was "born dead" or immediately killed because the position size ($24) was too small relative to execution fees (~$3+) and GMX operational constraints.

3.  **Root Cause**:
    - The `HedgeManager` contract had `minPositionSize` set to **0**.
    - This allowed the `compound()` function to attempt opening a $24 position.
    - The transaction succeeded (did not revert), but the resulting position on GMX was not viable.

## Resolution

**Action Taken**:
- Updated `minPositionSize` on `HedgeManager` to **$100** (100 * 1e30).
- Script used: `scripts/diagnostics/set-min-position.ts`.
- Transaction: `0xbb87f36e3e658b7d01b58a9dcf30ea2b2773d4b0f4dce817d77c47bea15f5c9b`.

**Impact**:
- Future calls to `openShort` or `adjustHedge` with a target size < $100 will now **revert** with `PositionTooSmall`.
- This prevents the creation of wasteful dust positions that lose funds to fees.

## Side Effects & Recommendations

**Issue**: 
- With `minPositionSize` set to $100, `DeltaNeutralVault.compound()` and `deposit()` will now **revert** if the calculated hedge requirement is less than $100 (e.g., on small deposits or small compound amounts).
- This effectively sets a minimum deposit limit for the first user (or whenever the vault has no position).

**Recommended Next Step (High Priority)**:
- Upgrade `HedgeManager` or `DeltaNeutralVault` to handle small hedge requests gracefully.
- **Preferred Fix**: Modify `HedgeManager.adjustHedge` to return successfully (no-op) instead of reverting when `targetDeltaUsd < minPositionSize` and `!hasPosition()`.
- This will allow small deposits/compounds to proceed with a small unhedged exposure (which is acceptable) until the accumulated delta justifies opening a viable position.

## Diagnostic Scripts

New scripts created during this investigation:
- `scripts/diagnostics/find-liquidation.ts`: Analyzes execution logs.
- `scripts/diagnostics/investigate-position-history.ts`: Checks contract state and history.
- `scripts/diagnostics/check-gmx-position.ts`: Verifies DataStore keys and values.
- `scripts/diagnostics/find-position-close.ts`: Scans for closing events.
- `scripts/diagnostics/scan-all-events.ts`: Deep scan of event emitter.
- `scripts/diagnostics/decode-order.ts`: Decodes GMX event data.
- `scripts/diagnostics/check-min-position.ts`: Reads config.
- `scripts/diagnostics/set-min-position.ts`: Updates config.