# Proxy Upgradeability Plan

## Overview
We are transitioning the Harmonia protocol contracts to be upgradeable. This allows us to fix bugs and improve functionality without migrating liquidity.

## Strategy
We will use the **UUPS (Universal Upgradeable Proxy Standard)** pattern.
- **Gas Efficiency**: UUPS is more gas-efficient than Transparent proxies because the upgrade logic is in the implementation, not a separate Admin contract that checks every call.
- **Security**: Upgrade access is controlled by the implementation (inherited `Ownable`), ensuring only the owner can upgrade.

## Dependencies
- `@openzeppelin/contracts-upgradeable`
- `@openzeppelin/hardhat-upgrades`

## Contracts to Upgrade
1.  **DeltaNeutralVault**
    -   Inherit `ERC4626Upgradeable`, `ReentrancyGuardUpgradeable`, `OwnableUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`.
    -   Convert constructor to `initialize`.
    -   Implement `_authorizeUpgrade`.
2.  **HedgeManager**
    -   Inherit `OwnableUpgradeable`, `ReentrancyGuardUpgradeable`, `UUPSUpgradeable`.
    -   Convert immutable variables to storage variables (for maximum flexibility).
    -   Convert constructor to `initialize`.
    -   Implement `_authorizeUpgrade`.
3.  **LiquidityManager**
    -   Inherit `OwnableUpgradeable`, `ReentrancyGuardUpgradeable`, `UUPSUpgradeable`.
    -   Convert immutable variables to storage variables.
    -   Convert constructor to `initialize`.
    -   Implement `_authorizeUpgrade`.
4.  **RebalanceController**
    -   Inherit `OwnableUpgradeable`, `UUPSUpgradeable`.
    -   Convert constructor to `initialize`.
    -   Implement `_authorizeUpgrade`.

## Storage Layout
- We must ensure storage layout safety.
- We will use `Gap` variables (e.g., `uint256[50] private __gap;`) at the end of contracts to allow for future state variable additions without storage collision in inherited contracts (though these are mostly leaf contracts, it's good practice).
- We will rely on OpenZeppelin's upgrade safety checks.

## Steps

1.  **Install Dependencies**: Add upgradeable contract libraries.
2.  **Refactor Contracts**:
    -   Import `*Upgradeable` variants.
    -   Replace `constructor` with `function initialize(...) initializer public`.
    -   Add `__Gap_init()` calls where appropriate.
    -   Implement `_authorizeUpgrade` protected by `onlyOwner`.
3.  **Update Deployment Scripts**: Use `upgrades.deployProxy`.
4.  **Update Tests**:
    -   Tests using `new Contract(...)` must be changed to use a proxy deployment helper or fixture.
    -   Ensure `initialize` cannot be called twice.

## Roadmap
- [x] Install dependencies
- [x] Refactor `DeltaNeutralVault.sol`
- [x] Refactor `HedgeManager.sol`
- [x] Refactor `LiquidityManager.sol`
- [x] Refactor `RebalanceController.sol`
- [x] Update `hardhat.config.ts` (if needed for plugins)
- [x] Create/Update deployment scripts
- [x] Update Tests
