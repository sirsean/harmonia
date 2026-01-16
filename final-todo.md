# Final Todo: No-op and Incomplete Implementations

This document lists identified "no-op" implementations, incomplete logic ("Phase" placeholders), and unused variable suppressions found in the codebase.

## Critical: Core Logic Missing in `DeltaNeutralVault.sol`

The `DeltaNeutralVault` contract is currently in "Phase 3" state where capital deployment and management logic is intentionally disabled (no-op).

### 1. `_deployCapital` (Line 525)
**Status:** **NO-OP**
**Impact:** Assets deposited into the vault remain idle in the contract and are not deployed to Uniswap V3 or GMX V2.
```solidity
function _deployCapital(uint256 assets) internal {
    // Phase 3: No-op, assets remain idle
    // Phase 4+: Will deploy to Uniswap v3 LP position
    // Phase 5+: Will also open hedge on GMX v2

    emit CapitalDeployed(assets, 0, 0);
}
```

### 2. `_unwindCapital` (Line 536)
**Status:** **NO-OP**
**Impact:** Withdrawals do not trigger unwinding of positions (since none are created).
```solidity
function _unwindCapital(uint256 assets) internal {
    // Phase 3: No-op, assets are already idle
    // Phase 4+: Will remove liquidity from Uniswap v3
    // Phase 5+: Will also close proportional hedge

    emit CapitalWithdrawn(assets, 0, 0);
}
```

### 3. `_calculateFeesInUSD` (Line 654)
**Status:** **HARDCODED ZERO**
**Impact:** Fee reporting and tracking will be incorrect (always zero).
**Code Smell:** Uses `(amount0, amount1);` to silence unused variable warnings.
```solidity
function _calculateFeesInUSD(uint256 amount0, uint256 amount1) internal pure returns (uint256) {
    // Phase 3: Return 0
    // Phase 4+: Use price oracle to convert
    (amount0, amount1); // <--- Explicit No-op statement
    return 0;
}
```

### 4. `_compoundYield` (Line 670)
**Status:** **EMPTY**
**Impact:** Calling `compound()` does nothing; yield is not reinvested.
```solidity
function _compoundYield() internal {
    // Phase 3: No-op
    // Phase 6+: Reinvest fees and funding
}
```

### 5. `collectFees` & `claimFunding`
While the functions `collectFees` and `claimFunding` in `DeltaNeutralVault` call their internal helpers, the internal helpers rely on `liquidityManager` and `hedgeManager` addresses.
*   **Note:** If `liquidityManager` and `hedgeManager` are not set (as suggested by L51-57 "to be set in Phase 4/5"), these functions will return early or return 0, effectively being no-ops.

## Mocks: Test Limitations

### 1. `contracts/test/MockGMXV2.sol`
Found multiple instances of variable silencing, indicating unimplemented mock methods.
*   L351: `(dataStore, positionKey);`
*   L381: `(dataStore);`
*   L391: `(dataStore, start, end);`
*   L401: `(dataStore, account, start, end);`

## Verified Safe

### 1. `contracts/core/RebalanceController.sol` (Line 123)
```solidity
// No-op to avoid reverting and wasting keeper gas
return;
```
This is a standard pattern for keepers to exit cleanly when no upkeep is needed.
