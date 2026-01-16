# Harmonia User Guide

This guide explains how to interact with the Harmonia delta-neutral vault as a depositor.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Depositing](#depositing)
4. [Withdrawing](#withdrawing)
5. [Checking Your Position](#checking-your-position)
6. [Understanding Vault Shares](#understanding-vault-shares)
7. [Important Considerations](#important-considerations)
8. [Common Operations](#common-operations)

---

## Overview

Harmonia is an ERC-4626 compliant vault that implements a delta-neutral yield strategy. When you deposit USDC:

1. Your USDC is deployed into a Uniswap V3 liquidity position
2. A corresponding short hedge is opened on GMX V2
3. The combination targets zero net exposure to ETH price movements
4. You earn yield from:
   - Uniswap V3 trading fees
   - GMX funding payments (when shorts receive funding)

In return for your deposit, you receive vault shares (hDNV tokens) that represent your proportional ownership of the vault.

---

## Prerequisites

### What You Need

- **USDC**: Native USDC on Arbitrum (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`)
- **ETH**: For gas fees (typically 0.001-0.01 ETH per transaction)
- **Wallet**: Any EVM-compatible wallet (MetaMask, WalletConnect, etc.)

### Network Configuration

Ensure your wallet is connected to Arbitrum One:

| Setting         | Value                        |
| --------------- | ---------------------------- |
| Network Name    | Arbitrum One                 |
| RPC URL         | https://arb1.arbitrum.io/rpc |
| Chain ID        | 42161                        |
| Currency Symbol | ETH                          |
| Block Explorer  | https://arbiscan.io          |

---

## Depositing

### Step 1: Approve USDC Spending

Before depositing, you must approve the vault to spend your USDC:

```javascript
// Using ethers.js
const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);

// Approve vault to spend your USDC
const depositAmount = ethers.parseUnits("1000", 6); // 1000 USDC
await usdc.approve(await vault.getAddress(), depositAmount);
```

### Step 2: Deposit USDC

After approval, deposit your USDC:

```javascript
// Deposit and receive shares
const shares = await vault.deposit(depositAmount, yourAddress);
```

### Alternative: Mint Exact Shares

If you want a specific number of shares:

```javascript
// Calculate assets needed for desired shares
const desiredShares = ethers.parseUnits("1000", 18);
const assetsNeeded = await vault.previewMint(desiredShares);

// Approve and mint
await usdc.approve(await vault.getAddress(), assetsNeeded);
await vault.mint(desiredShares, yourAddress);
```

### Deposit Limits

- **Deposit Cap**: The vault has a maximum total deposit limit
- **Check Available**: `vault.depositCap() - vault.totalAssets()`
- Deposits exceeding the cap will revert

---

## Withdrawing

### Standard Withdrawal

Withdraw a specific amount of USDC:

```javascript
// Withdraw 500 USDC
const withdrawAmount = ethers.parseUnits("500", 6);
const sharesNeeded = await vault.previewWithdraw(withdrawAmount);

// Execute withdrawal
await vault.withdraw(withdrawAmount, yourAddress, yourAddress);
```

### Redeem All Shares

To exit your entire position:

```javascript
// Get your share balance
const shares = await vault.balanceOf(yourAddress);

// Redeem all shares for USDC
await vault.redeem(shares, yourAddress, yourAddress);
```

### Withdrawal Restrictions

The vault implements protective withdrawal limits:

| Restriction                   | Limit               | Description                                                  |
| ----------------------------- | ------------------- | ------------------------------------------------------------ |
| **Max Single Withdrawal**     | 25% of total assets | No single withdrawal can exceed 25% of vault TVL             |
| **Large Withdrawal Cooldown** | 1 hour              | Withdrawals >10% of TVL require 1-hour cooldown between them |
| **Circuit Breaker**           | Blocks withdrawals  | If triggered, only owner/guardian can withdraw (can be disabled by owner) |

---

## Checking Your Position

### View Your Shares

```javascript
// Your vault share balance
const shares = await vault.balanceOf(yourAddress);
console.log("Shares:", ethers.formatUnits(shares, 18));
```

### Calculate Your USDC Value

```javascript
// Convert shares to USDC value
const assetsValue = await vault.convertToAssets(shares);
console.log("USDC Value:", ethers.formatUnits(assetsValue, 6));
```

### Preview Withdrawal

```javascript
// How many shares needed to withdraw X USDC?
const usdcAmount = ethers.parseUnits("1000", 6);
const sharesNeeded = await vault.previewWithdraw(usdcAmount);

// How much USDC for X shares?
const sharesAmount = ethers.parseUnits("1000", 18);
const usdcReceived = await vault.previewRedeem(sharesAmount);
```

### Check Vault Status

```javascript
// Total assets in vault
const totalAssets = await vault.totalAssets();

// Total shares outstanding
const totalSupply = await vault.totalSupply();

// Current share price (assets per share)
const sharePrice = totalSupply > 0 ? (totalAssets * 10n ** 18n) / totalSupply : 10n ** 18n;

// Deposit cap remaining
const depositCap = await vault.depositCap();
const remaining = depositCap - totalAssets;
```

---

## Understanding Vault Shares

### Share Value Mechanics

Vault shares represent proportional ownership:

```
Your Share of Vault = Your Shares / Total Shares
Your USDC Value = Your Share of Vault × Total Assets
```

### How Share Value Changes

Share value increases when:

- Uniswap fees are collected
- GMX funding payments are received (positive funding)
- Any yield is compounded back into the vault

Share value decreases when:

- GMX funding payments are negative
- Impermanent loss exceeds fees collected
- Emergency situations cause losses

### Share Price Formula

```
Share Price = Total Assets / Total Shares
```

Where Total Assets = Idle USDC + LP Position Value + Hedge Position Value

---

## Important Considerations

### Risks

1. **Smart Contract Risk**: Bugs in Harmonia or dependent protocols
2. **Oracle Risk**: Price feed failures could trigger unwanted behaviors
3. **Protocol Risk**: Changes to Uniswap V3 or GMX V2
4. **Liquidity Risk**: Large withdrawals may face slippage
5. **Funding Rate Risk**: Negative GMX funding reduces yield

### Timing Considerations

- **Deposits**: Best during low volatility periods
- **Withdrawals**: Large withdrawals may require position unwinding
- **Rebalancing**: Automatic via Chainlink keepers

### Gas Costs

| Operation | Typical Gas | ~Cost at 0.1 gwei |
| --------- | ----------- | ----------------- |
| Approve   | 50,000      | ~0.000005 ETH     |
| Deposit   | 300,000     | ~0.00003 ETH      |
| Withdraw  | 400,000     | ~0.00004 ETH      |
| Redeem    | 400,000     | ~0.00004 ETH      |

---

## Common Operations

### Full Workflow: Deposit

```javascript
import { ethers } from "ethers";

// Setup
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

const VAULT_ADDRESS = "0x..."; // Your vault address
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  [
    "function deposit(uint256 assets, address receiver) returns (uint256)",
    "function totalAssets() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function convertToAssets(uint256) view returns (uint256)",
  ],
  signer
);

const usdc = new ethers.Contract(
  USDC_ADDRESS,
  [
    "function approve(address, uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ],
  signer
);

// Check USDC balance
const usdcBalance = await usdc.balanceOf(signer.address);
console.log("USDC Balance:", ethers.formatUnits(usdcBalance, 6));

// Deposit 100 USDC
const depositAmount = ethers.parseUnits("100", 6);

// Approve
console.log("Approving USDC...");
const approveTx = await usdc.approve(VAULT_ADDRESS, depositAmount);
await approveTx.wait();

// Deposit
console.log("Depositing...");
const depositTx = await vault.deposit(depositAmount, signer.address);
const receipt = await depositTx.wait();

// Check new balance
const shares = await vault.balanceOf(signer.address);
const value = await vault.convertToAssets(shares);
console.log("Shares received:", ethers.formatUnits(shares, 18));
console.log("Current value:", ethers.formatUnits(value, 6), "USDC");
```

### Full Workflow: Withdraw

```javascript
// Setup (same as above)

// Get current position
const shares = await vault.balanceOf(signer.address);
const currentValue = await vault.convertToAssets(shares);
console.log("Current position:", ethers.formatUnits(currentValue, 6), "USDC");

// Withdraw 50 USDC
const withdrawAmount = ethers.parseUnits("50", 6);

console.log("Withdrawing...");
const withdrawTx = await vault.withdraw(
  withdrawAmount,
  signer.address, // receiver
  signer.address // owner (must be you or approved)
);
await withdrawTx.wait();

// Check updated position
const newShares = await vault.balanceOf(signer.address);
const newValue = await vault.convertToAssets(newShares);
console.log("Remaining position:", ethers.formatUnits(newValue, 6), "USDC");
```

### Check Vault Health

```javascript
// Check if vault is operating normally
const isPaused = await vault.paused();
const circuitBreaker = await vault.circuitBreakerTriggered();
const deltaRatio = await vault.getDeltaRatio();

console.log("Paused:", isPaused);
console.log("Circuit Breaker:", circuitBreaker);
console.log("Delta Ratio:", ethers.formatUnits(deltaRatio, 16), "%");

if (isPaused || circuitBreaker) {
  console.log("WARNING: Vault is not operating normally");
}
```

---

## Contract Addresses

After deployment, the following addresses will be available:

| Contract            | Address              |
| ------------------- | -------------------- |
| DeltaNeutralVault   | TBD after deployment |
| LiquidityManager    | TBD after deployment |
| HedgeManager        | TBD after deployment |
| RebalanceController | TBD after deployment |

### External Dependencies

| Token/Contract | Address                                      |
| -------------- | -------------------------------------------- |
| USDC (Native)  | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| WETH           | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |

---

## FAQ

### How do I know if my deposit was successful?

Check your vault share balance using `vault.balanceOf(yourAddress)`. If you have shares, your deposit succeeded.

### Why can't I withdraw all my funds at once?

To protect all depositors, single withdrawals are limited to 25% of total vault assets. This prevents any single actor from draining the vault.

### What happens during a circuit breaker?

If the vault's delta exceeds safety thresholds, the circuit breaker activates. During this time:

- New deposits are paused
- Regular users cannot withdraw
- Owner/guardian can still execute emergency operations

*Note: The owner can disable the circuit breaker enforcement to allow withdrawals even during an emergency.*

### How often is the vault rebalanced?

The Chainlink Automation keeper checks for rebalancing opportunities based on:

- Delta drift exceeding 5%
- Time since last rebalance (1-24 hours)
- Yield compounding opportunities (daily)

### Can I transfer my vault shares?

Yes, hDNV tokens are standard ERC-20 tokens and can be transferred to any address.
