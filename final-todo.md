# Final Todo: No-op and Incomplete Implementations

This document lists identified "no-op" implementations, incomplete logic ("Phase" placeholders), and unused variable suppressions found in the codebase.

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
