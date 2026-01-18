# Contract Administration Guide

This guide documents all administrative functions, roles, and operational procedures for managing the Harmonia protocol.

## Table of Contents

1. [Role Overview](#role-overview)
2. [DeltaNeutralVault Administration](#deltaneutralvault-administration)
3. [LiquidityManager Administration](#liquiditymanager-administration)
4. [HedgeManager Administration](#hedgemanager-administration)
5. [RebalanceController Administration](#rebalancecontroller-administration)
6. [Emergency Procedures](#emergency-procedures)
7. [Ownership Transfer](#ownership-transfer)
8. [Upgrading Contract Logic](#upgrading-contract-logic)
9. [Security Best Practices](#security-best-practices)

---

## Role Overview

### Roles by Contract

| Contract                | Role                 | Capabilities                                              |
| ----------------------- | -------------------- | --------------------------------------------------------- |
| **DeltaNeutralVault**   | Owner                | Full admin control, set managers, set caps, pause/unpause, **Upgrade Logic** |
|                         | Guardian             | Trigger circuit breaker, emergency unwind                 |
|                         | Rebalance Controller | Call rebalance()                                          |
| **LiquidityManager**    | Owner                | Set vault, update slippage, configure TWAP, **Upgrade Logic** |
|                         | Vault                | Execute LP operations                                     |
| **HedgeManager**        | Owner                | Set vault, update slippage, set execution fee, **Upgrade Logic** |
|                         | Vault                | Execute hedge operations                                  |
| **RebalanceController** | Owner                | Standard Ownable functions, **Upgrade Logic**             |

### Role Hierarchy

```
                    ┌──────────────┐
                    │    Owner     │
                    │  (Multisig)  │
                    └──────┬───────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
    ┌──────────────┐ ┌──────────┐ ┌───────────────────┐
    │   Guardian   │ │  Vault   │ │ RebalanceController│
    │ (Hot Wallet) │ │          │ │   (Automation)     │
    └──────────────┘ └──────────┘ └───────────────────┘
```

### Recommended Role Assignments

| Role                | Recommended Setup                      |
| ------------------- | -------------------------------------- |
| Owner               | Gnosis Safe multisig (3/5 or similar)  |
| Guardian            | Hot wallet for fast emergency response |
| RebalanceController | Chainlink Automation (automated)       |

---

## DeltaNeutralVault Administration

### setManagers

Links the vault to its manager contracts.

```solidity
function setManagers(
    address _liquidityManager,
    address _hedgeManager,
    address _rebalanceController
) external onlyOwner
```

**Usage:**

```javascript
await vault.setManagers(liquidityManagerAddress, hedgeManagerAddress, rebalanceControllerAddress);
```

**When to Use:**

- Initial deployment configuration
- Upgrading manager contracts

**Risks:**

- Setting wrong addresses breaks vault functionality
- Always verify addresses before calling

---

### setDepositCap

Sets maximum TVL for the vault.

```solidity
function setDepositCap(uint256 _depositCap) external onlyOwner
```

**Usage:**

```javascript
// Set 100,000 USDC cap
await vault.setDepositCap(ethers.parseUnits("100000", 6));

// Remove cap (set to 0)
await vault.setDepositCap(0);
```

**When to Use:**

- Initial deployment: Start conservative
- Gradual scaling: Increase as system proves stable
- Risk mitigation: Decrease during uncertain conditions

**Recommended Progression:**

1. Launch: $10,000
2. Week 1: $50,000
3. Month 1: $250,000
4. Ongoing: Evaluate based on performance

---

### setDeltaThreshold

Sets the delta drift threshold for triggering rebalances.

```solidity
function setDeltaThreshold(uint256 _deltaThreshold) external onlyOwner
```

**Usage:**

```javascript
// Set 5% threshold (5e16)
await vault.setDeltaThreshold(ethers.parseUnits("5", 16));
```

**When to Use:**

- Optimize rebalance frequency
- Adjust sensitivity to market volatility

**Constraints:**

- Default: 5% (5e16)

---

### setCircuitBreakerEnabled
Enables or disables the circuit breaker enforcement mechanism.

```solidity
function setCircuitBreakerEnabled(bool _enabled) external onlyOwner
```

**Usage:**

```javascript
// Disable circuit breaker (allow withdrawals during emergency)
await vault.setCircuitBreakerEnabled(false);

// Enable circuit breaker (default)
await vault.setCircuitBreakerEnabled(true);
```

**When to Use:**

- Allow users to exit during an emergency without owner intervention
- Disable safety checks for testing/debugging
- Permanently remove "training wheels" when protocol matures

**Risks:**

- Disabling removes a critical safety layer
- Should only be disabled if you want to prioritize liquidity over solvency protection

---

### setGuardian

Assigns the guardian role for emergency operations.

```solidity
function setGuardian(address _guardian) external onlyOwner
```

**Usage:**

```javascript
await vault.setGuardian(guardianAddress);
```

**When to Use:**

- Initial deployment
- Rotating guardian keys
- Emergency response preparation

**Best Practices:**

- Use different address than owner
- Use hot wallet for fast response
- Consider redundant guardians via multisig

---

### setProtocolFee

Sets the protocol fee percentage collected from yield.

```solidity
function setProtocolFee(uint256 _protocolFeeBps) external onlyOwner
```

**Usage:**

```javascript
// Set 1% fee (100 bps)
await vault.setProtocolFee(100);

// Disable fee
await vault.setProtocolFee(0);
```

**When to Use:**

- Adjusting revenue model
- Reducing fees to incentivize growth
- Increasing fees during high profitability

**Constraints:**

- Maximum: 50% (5000 bps)
- Default: 0% (if not set)

---

### setTreasury

Sets the recipient address for protocol fees.

```solidity
function setTreasury(address _treasury) external onlyOwner
```

**Usage:**

```javascript
await vault.setTreasury(treasuryAddress);
```

**When to Use:**

- Initial configuration
- Changing fee recipient (e.g. to new multisig)

**Note:**

- Fee shares are minted directly to this address during compounding.

---

### pause / unpause

Emergency halt of vault operations.

```solidity
function pause() external onlyOwner
function unpause() external onlyOwner
```

**Usage:**

```javascript
// Halt deposits
await vault.pause();

// Resume operations
await vault.unpause();
```

**When to Use:**

- Detected vulnerability
- Protocol dependency issues
- Market extreme conditions

**Effects of Pause:**

- Deposits blocked
- Minting blocked
- Withdrawals still work (for user safety)

---

### resetCircuitBreaker

Resets the circuit breaker after emergency resolution.

```solidity
function resetCircuitBreaker() external onlyOwner
```

**Usage:**

```javascript
// Only works if delta is below threshold
await vault.resetCircuitBreaker();
```

**Prerequisites:**

- Delta ratio must be ≤ 5% (DELTA_THRESHOLD)
- Owner must verify safe conditions

**Process:**

1. Identify and fix root cause
2. Wait for delta to normalize
3. Reset circuit breaker
4. Unpause if needed

---

## LiquidityManager Administration

### setVault

Links the manager to its controlling vault.

```solidity
function setVault(address _vault) external onlyOwner
```

**Usage:**

```javascript
await liquidityManager.setVault(vaultAddress);
```

**When to Use:**

- Initial deployment only
- Cannot be changed after operations begin (practically)

---

### setSlippageTolerance

Adjusts maximum allowed slippage for LP operations.

```solidity
function setSlippageTolerance(uint256 _slippageTolerance) external onlyOwner
```

**Usage:**

```javascript
// Set 0.3% slippage (3e15)
await liquidityManager.setSlippageTolerance(3n * 10n ** 15n);
```

**Constraints:**

- Maximum: 1% (1e16)
- Default: 0.5% (5e15)

**When to Adjust:**

- High volatility: Increase temporarily
- Normal conditions: Use default
- Optimization: Lower if consistently succeeding

---

### setTWAPValidation

Enables/disables TWAP price validation.

```solidity
function setTWAPValidation(bool _enabled) external onlyOwner
```

**Usage:**

```javascript
// Enable TWAP validation
await liquidityManager.setTWAPValidation(true);

// Disable
await liquidityManager.setTWAPValidation(false);
```

**When to Enable:**

- Production deployments
- Additional manipulation protection needed

**When to Disable:**

- Testing
- Pool has insufficient observation history

---

### setPriceFeed

Sets Chainlink price feed for validation.

```solidity
function setPriceFeed(address _priceFeed) external onlyOwner
```

**Usage:**

```javascript
// ETH/USD feed on Arbitrum
await liquidityManager.setPriceFeed("0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612");
```

**Purpose:**

- Cross-validate Uniswap prices
- Detect manipulation attempts

---

## HedgeManager Administration

### setVault

Links the manager to its controlling vault.

```solidity
function setVault(address _vault) external onlyOwner
```

**Usage:**

```javascript
await hedgeManager.setVault(vaultAddress);
```

---

### setSlippageTolerance

Adjusts maximum allowed slippage for GMX operations.

```solidity
function setSlippageTolerance(uint256 _slippageTolerance) external onlyOwner
```

**Usage:**

```javascript
// Set 2% slippage (2e16)
await hedgeManager.setSlippageTolerance(2n * 10n ** 16n);
```

**Constraints:**

- Maximum: 5% (5e16)
- Default: 1% (1e16)

**When to Adjust:**

- Volatile markets: Increase temporarily
- Large position sizes: May need higher tolerance
- Normal conditions: Use default

---

### setExecutionFeeOverride

Overrides default GMX execution fee.

```solidity
function setExecutionFeeOverride(uint256 _fee) external onlyOwner
```

**Usage:**

```javascript
// Set custom execution fee (in ETH)
await hedgeManager.setExecutionFeeOverride(ethers.parseEther("0.002"));

// Reset to default (0)
await hedgeManager.setExecutionFeeOverride(0);
```

**When to Adjust:**

- GMX network congestion
- Order failures due to low fee
- Gas price spikes

---

## RebalanceController Administration

The RebalanceController inherits from Ownable but has no special admin functions beyond standard ownership.

### transferOwnership

```javascript
await rebalanceController.transferOwnership(newOwnerAddress);
```

---

## Emergency Procedures

### Circuit Breaker Trigger

**Automatic Trigger:**
The circuit breaker automatically triggers when delta ratio exceeds 20% during rebalance attempts.

**Manual Trigger:**

```javascript
// Owner or Guardian can trigger
await vault.triggerCircuitBreaker();
```

**Effects:**

- Vault paused
- Withdrawals blocked for non-privileged users
- Owner/Guardian can still withdraw

---

### Emergency Unwind

Closes all positions and converts to USDC.

```solidity
function emergencyUnwind() external
```

**Usage:**

```javascript
// Owner or Guardian only
await vault.emergencyUnwind();
```

**Actions:**

1. Pauses vault
2. Triggers circuit breaker
3. Closes LP position
4. Closes hedge position
5. All assets converted to USDC

**When to Use:**

- Critical vulnerability discovered
- External protocol failure
- Extreme market conditions

**Recovery:**

1. Assess damage
2. Fix root cause
3. Redeploy if needed
4. Users withdraw remaining assets

---

### Emergency Response Checklist

**Immediate (0-5 minutes):**

- [ ] Trigger circuit breaker
- [ ] Assess situation

**Short-term (5-30 minutes):**

- [ ] Pause vault if not already
- [ ] Evaluate if emergency unwind needed
- [ ] Communicate with users

**Recovery (30+ minutes):**

- [ ] Identify root cause
- [ ] Implement fix
- [ ] Test fix
- [ ] Reset circuit breaker
- [ ] Unpause vault

---

## Ownership Transfer

### Recommended Process

1. **Deploy Multisig**

   ```javascript
   // Example: Gnosis Safe with 3/5 signers
   const multisig = "0x...";
   ```

2. **Transfer Each Contract**

   ```javascript
   await vault.transferOwnership(multisig);
   await liquidityManager.transferOwnership(multisig);
   await hedgeManager.transferOwnership(multisig);
   await rebalanceController.transferOwnership(multisig);
   ```

3. **Verify Transfers**

   ```javascript
   console.log("Vault owner:", await vault.owner());
   console.log("LM owner:", await liquidityManager.owner());
   console.log("HM owner:", await hedgeManager.owner());
   console.log("RC owner:", await rebalanceController.owner());
   ```

4. **Test Multisig Operations**
   - Execute a test transaction (e.g., setDepositCap)
   - Verify all signers can participate

### Two-Step Transfer (Safer)

If using OpenZeppelin's Ownable2Step:

```javascript
// Step 1: Initiate transfer
await contract.transferOwnership(newOwner);

// Step 2: New owner accepts
await contract.connect(newOwnerSigner).acceptOwnership();
```

---

## Upgrading Contract Logic

Harmonia core contracts use the **UUPS (Universal Upgradeable Proxy Standard)** pattern. Unlike Transparent proxies, the upgrade logic resides in the implementation contract itself, making it more gas-efficient.

### Authorization

Only the **Owner** of the contract can authorize an upgrade. The `_authorizeUpgrade` function is protected by the `onlyOwner` modifier in all core contracts.

### Upgrade Process via Hardhat

The recommended way to upgrade implementation logic is using the OpenZeppelin Hardhat Upgrades plugin:

1. **Develop New Implementation**: Create a new version of the contract (e.g., `DeltaNeutralVaultV2.sol`).
2. **Validate Upgrade**: Ensure the new implementation is upgrade-compatible (no storage layout changes, etc.).
3. **Execute Upgrade**:

```javascript
const { upgrades, ethers } = require("hardhat");

const PROXY_ADDRESS = "0x..."; // The address of the existing proxy
const VaultV2 = await ethers.getContractFactory("DeltaNeutralVaultV2");

console.log("Upgrading vault...");
await upgrades.upgradeProxy(PROXY_ADDRESS, VaultV2);
console.log("Vault upgraded successfully");
```

### Manual Upgrade

If not using the plugin, the owner can call `upgradeToAndCall(newImplementation, data)` directly on the proxy.

### Risks

- **Storage Collisions**: Never change the order or type of existing state variables. Use the provided `__gap` variables if adding state to base contracts.
- **Initialization**: New versions might require new initialization logic. Use the `reinitializer` modifier for V2+ initialization functions.

---

## Security Best Practices

### Access Control

1. **Use Multisig for Owner**
   - Minimum 3/5 configuration
   - Geographic distribution of signers
   - Mix of hardware and software wallets

2. **Separate Guardian from Owner**
   - Hot wallet for fast response
   - Limited capabilities
   - Can be rotated quickly

3. **Monitor Admin Transactions**
   - Set up alerts for owner calls
   - Review all parameter changes

### Operational Security

1. **Parameter Changes**
   - Double-check values before submission
   - Use simulation tools when possible
   - Document all changes

2. **Regular Audits**
   - Review access patterns monthly
   - Rotate guardian keys quarterly
   - Annual security review

3. **Incident Response**
   - Maintain runbook for emergencies
   - Practice drills quarterly
   - Clear escalation paths

### Contract Constants Reference

These values are immutable and cannot be changed:

| Constant                   | Value  | Description             |
| -------------------------- | ------ | ----------------------- |
| EMERGENCY_THRESHOLD        | 20%    | Circuit breaker trigger |
| MAX_LEVERAGE               | 3x     | Maximum GMX leverage    |
| MIN_HEDGE_RATIO            | 80%    | Minimum hedge coverage  |
| MAX_SINGLE_WITHDRAWAL      | 25%    | Per-withdrawal limit    |
| LARGE_WITHDRAWAL_COOLDOWN  | 1 hour | Cooldown period         |
| LARGE_WITHDRAWAL_THRESHOLD | 10%    | Cooldown trigger        |

---

## Function Reference Quick Look

### DeltaNeutralVault (Owner)

| Function                     | Purpose                     |
| ---------------------------- | --------------------------- |
| `setManagers()`              | Configure manager contracts |
| `setDepositCap()`            | Set TVL limit               |
| `setDeltaThreshold()`        | Set rebalance threshold     |
| `setCircuitBreakerEnabled()` | Toggle circuit breaker      |
| `setGuardian()`              | Assign guardian role        |
| `pause()`               | Halt deposits               |
| `unpause()`             | Resume deposits             |
| `resetCircuitBreaker()` | Reset after emergency       |
| `transferOwnership()`   | Transfer owner role         |
| `upgradeToAndCall()`    | Upgrade contract logic      |

### DeltaNeutralVault (Guardian)

| Function                  | Purpose               |
| ------------------------- | --------------------- |
| `triggerCircuitBreaker()` | Manual emergency stop |
| `emergencyUnwind()`       | Close all positions   |

### LiquidityManager (Owner)

| Function                 | Purpose             |
| ------------------------ | ------------------- |
| `setVault()`             | Link to vault       |
| `setSlippageTolerance()` | Adjust LP slippage  |
| `setTWAPValidation()`    | Toggle TWAP check   |
| `setPriceFeed()`         | Set Chainlink feed  |
| `transferOwnership()`    | Transfer owner role |
| `upgradeToAndCall()`     | Upgrade logic       |

### HedgeManager (Owner)

| Function                    | Purpose             |
| --------------------------- | ------------------- |
| `setVault()`                | Link to vault       |
| `setSlippageTolerance()`    | Adjust GMX slippage |
| `setExecutionFeeOverride()` | Override GMX fee    |
| `transferOwnership()`       | Transfer owner role |
| `upgradeToAndCall()`        | Upgrade logic       |

### RebalanceController (Owner)

| Function                | Purpose             |
| ----------------------- | ------------------- |
| `transferOwnership()`   | Transfer owner role |
| `upgradeToAndCall()`    | Upgrade logic       |
