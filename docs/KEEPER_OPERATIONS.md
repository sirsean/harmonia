# Chainlink Automation Keeper Operations

This guide explains how to set up, manage, and monitor Chainlink Automation for the Harmonia delta-neutral vault.

## Table of Contents

1. [Overview](#overview)
2. [Registering the Keeper](#registering-the-keeper)
3. [Funding the Upkeep](#funding-the-upkeep)
4. [Monitoring Operations](#monitoring-operations)
5. [Upkeep Types](#upkeep-types)
6. [Troubleshooting](#troubleshooting)
7. [Manual Operations](#manual-operations)

---

## Overview

The Harmonia protocol uses Chainlink Automation (formerly Chainlink Keepers) to automatically maintain the delta-neutral position. The `RebalanceController` contract implements the `AutomationCompatibleInterface` to enable:

1. **Rebalancing**: Adjusting the hedge when delta drifts
2. **Compounding**: Reinvesting collected yield
3. **Snapshots**: Recording yield metrics on-chain

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 Chainlink Automation                     │
│                      Network                             │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              RebalanceController                         │
│                                                          │
│  checkUpkeep() ─────► Evaluate conditions                │
│  performUpkeep() ───► Execute maintenance                │
│                                                          │
│  Upkeep Types:                                           │
│  ├── Rebalance: Adjust hedge position                    │
│  ├── Compound: Reinvest yield                            │
│  └── Snapshot: Record metrics                            │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│               DeltaNeutralVault                          │
│                                                          │
│  rebalance() ───► Adjust LP and hedge                    │
│  compound() ────► Reinvest fees/funding                  │
└─────────────────────────────────────────────────────────┘
```

---

## Registering the Keeper

### Prerequisites

- Deployed `RebalanceController` contract address
- LINK tokens for funding (recommend 50+ LINK to start)
- Arbitrum wallet with ETH for gas

### Option 1: Using Chainlink Automation UI

1. Go to [Chainlink Automation](https://automation.chain.link/)
2. Connect your wallet to Arbitrum
3. Click "Register new Upkeep"
4. Select "Custom logic"
5. Enter the following details:

| Field            | Value                            |
| ---------------- | -------------------------------- |
| Upkeep name      | Harmonia Delta-Neutral Keeper    |
| Contract address | Your RebalanceController address |
| Gas limit        | 500,000                          |
| Starting balance | 50 LINK (minimum recommended)    |
| Admin address    | Your admin wallet                |

6. Confirm the registration transaction

### Option 2: Programmatic Registration

```javascript
import { ethers } from "ethers";

const AUTOMATION_REGISTRAR = "0x5a8be0b81746b42df48e6c52e2ed0c6fdd1e1c86";
const LINK_TOKEN = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";

// Registrar interface
const registrarABI = [
  "function registerUpkeep(tuple(string name, bytes encryptedEmail, address upkeepContract, uint32 gasLimit, address adminAddress, uint8 triggerType, bytes checkData, bytes triggerConfig, bytes offchainConfig, uint96 amount) requestParams) returns (uint256)",
];

// LINK token interface
const linkABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferAndCall(address to, uint256 value, bytes data) returns (bool)",
];

async function registerKeeper(
  signer,
  rebalanceControllerAddress,
  adminAddress,
  linkAmount // in LINK tokens (e.g., 50)
) {
  const registrar = new ethers.Contract(AUTOMATION_REGISTRAR, registrarABI, signer);
  const link = new ethers.Contract(LINK_TOKEN, linkABI, signer);

  const params = {
    name: "Harmonia Delta-Neutral Keeper",
    encryptedEmail: "0x",
    upkeepContract: rebalanceControllerAddress,
    gasLimit: 500000,
    adminAddress: adminAddress,
    triggerType: 0, // Conditional upkeep
    checkData: "0x",
    triggerConfig: "0x",
    offchainConfig: "0x",
    amount: ethers.parseUnits(linkAmount.toString(), 18),
  };

  // Encode registration params
  const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(string,bytes,address,uint32,address,uint8,bytes,bytes,bytes,uint96)"],
    [Object.values(params)]
  );

  // Approve and register via transferAndCall
  const amount = ethers.parseUnits(linkAmount.toString(), 18);
  console.log("Approving LINK...");
  await (await link.approve(AUTOMATION_REGISTRAR, amount)).wait();

  console.log("Registering upkeep...");
  const tx = await link.transferAndCall(AUTOMATION_REGISTRAR, amount, encodedParams);
  const receipt = await tx.wait();

  // Parse upkeep ID from events
  console.log("Keeper registered! Transaction:", receipt.hash);

  return receipt;
}
```

---

## Funding the Upkeep

### Checking Balance

```javascript
const AUTOMATION_REGISTRY = "0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1";

const registryABI = [
  "function getUpkeep(uint256 id) view returns (tuple(address target, uint32 performGas, bytes checkData, uint96 balance, address admin, uint64 maxValidBlocknumber, uint32 lastPerformedBlockNumber, uint96 amountSpent, bool paused, bytes offchainConfig))",
];

async function checkUpkeepBalance(provider, upkeepId) {
  const registry = new ethers.Contract(AUTOMATION_REGISTRY, registryABI, provider);
  const upkeep = await registry.getUpkeep(upkeepId);

  console.log("Balance:", ethers.formatUnits(upkeep.balance, 18), "LINK");
  console.log("Amount Spent:", ethers.formatUnits(upkeep.amountSpent, 18), "LINK");
  console.log("Paused:", upkeep.paused);

  return upkeep;
}
```

### Adding Funds

```javascript
const registryABI = ["function addFunds(uint256 id, uint96 amount) external"];

async function addFundsToUpkeep(signer, upkeepId, linkAmount) {
  const registry = new ethers.Contract(AUTOMATION_REGISTRY, registryABI, signer);
  const link = new ethers.Contract(LINK_TOKEN, linkABI, signer);

  const amount = ethers.parseUnits(linkAmount.toString(), 18);

  // Approve LINK to registry
  await (await link.approve(AUTOMATION_REGISTRY, amount)).wait();

  // Add funds
  const tx = await registry.addFunds(upkeepId, amount);
  await tx.wait();

  console.log("Added", linkAmount, "LINK to upkeep", upkeepId);
}
```

### Recommended Funding Levels

| Condition         | Recommended Balance |
| ----------------- | ------------------- |
| Minimum           | 10 LINK             |
| Normal Operation  | 50 LINK             |
| High Volatility   | 100+ LINK           |
| Low Balance Alert | < 20 LINK           |

---

## Monitoring Operations

### Event Monitoring

Monitor `UpkeepPerformed` events from the RebalanceController:

```javascript
const rebalanceControllerABI = [
  "event UpkeepPerformed(uint8 indexed upkeepType, int256 deltaRatio, uint256 timestamp)",
  "event SnapshotRecorded(uint256 totalAssets, uint256 totalFeesCollected, int256 totalFundingReceived, uint256 timestamp)",
];

async function monitorUpkeeps(provider, controllerAddress) {
  const controller = new ethers.Contract(controllerAddress, rebalanceControllerABI, provider);

  // Listen for upkeep events
  controller.on("UpkeepPerformed", (upkeepType, deltaRatio, timestamp) => {
    const types = ["None", "Rebalance", "Compound", "Snapshot"];
    console.log(`[${new Date(Number(timestamp) * 1000).toISOString()}]`);
    console.log(`  Upkeep Type: ${types[upkeepType]}`);
    console.log(`  Delta Ratio: ${ethers.formatUnits(deltaRatio, 16)}%`);
  });

  controller.on("SnapshotRecorded", (assets, fees, funding, timestamp) => {
    console.log(`[${new Date(Number(timestamp) * 1000).toISOString()}] Snapshot`);
    console.log(`  Total Assets: ${ethers.formatUnits(assets, 6)} USDC`);
    console.log(`  Total Fees: ${ethers.formatUnits(fees, 6)} USDC`);
    console.log(`  Total Funding: ${ethers.formatUnits(funding, 6)} USDC`);
  });

  console.log("Monitoring upkeep events...");
}
```

### Dashboard Metrics

Key metrics to track:

| Metric               | Source                      | Alert Threshold |
| -------------------- | --------------------------- | --------------- |
| LINK Balance         | Registry.getUpkeep()        | < 20 LINK       |
| Delta Ratio          | Vault.getDeltaRatio()       | > 10%           |
| Time Since Rebalance | Vault.lastRebalanceTime()   | > 24 hours      |
| Upkeep Paused        | Registry.getUpkeep().paused | true            |

### Checking Upkeep Status

```javascript
async function checkKeeperHealth(provider, controllerAddress, upkeepId) {
  const controller = new ethers.Contract(
    controllerAddress,
    [
      "function checkUpkeep(bytes) view returns (bool, bytes)",
      "function lastCompoundTime() view returns (uint256)",
      "function lastSnapshotTime() view returns (uint256)",
      "function vault() view returns (address)",
    ],
    provider
  );

  const vaultAddress = await controller.vault();
  const vault = new ethers.Contract(
    vaultAddress,
    [
      "function getDeltaRatio() view returns (int256)",
      "function lastRebalanceTime() view returns (uint256)",
      "function deltaThreshold() view returns (uint256)",
    ],
    provider
  );

  const [upkeepNeeded, performData] = await controller.checkUpkeep("0x");
  const deltaRatio = await vault.getDeltaRatio();
  const lastRebalance = await vault.lastRebalanceTime();
  const threshold = await vault.deltaThreshold();

  console.log("=== Keeper Health Check ===");
  console.log("Upkeep Needed:", upkeepNeeded);
  console.log("Delta Ratio:", ethers.formatUnits(deltaRatio, 16), "%");
  console.log("Threshold:", ethers.formatUnits(threshold, 16), "%");
  console.log("Last Rebalance:", new Date(Number(lastRebalance) * 1000).toISOString());
  console.log(
    "Time Since:",
    Math.floor((Date.now() / 1000 - Number(lastRebalance)) / 3600),
    "hours"
  );

  return { upkeepNeeded, deltaRatio, lastRebalance };
}
```

---

## Upkeep Types

### 1. Rebalance (Priority 1)

**Trigger Conditions:**

- Delta ratio exceeds 5% threshold AND minimum 1 hour since last rebalance
- OR maximum 24 hours since last rebalance (safety backstop)

**Actions:**

- Calls `vault.rebalance(targetHedgeSize)`
- Adjusts GMX short position to match LP delta
- Emits `UpkeepPerformed(Rebalance, deltaRatio, timestamp)`

**Intervals:**

- Minimum: 1 hour
- Maximum: 24 hours

### 2. Compound (Priority 2)

**Trigger Conditions:**

- At least 24 hours since last compound
- No higher-priority upkeep needed

**Actions:**

- Calls `vault.compound()`
- Reinvests collected fees and funding
- Emits `UpkeepPerformed(Compound, deltaRatio, timestamp)`

**Interval:** 24 hours minimum

### 3. Snapshot (Priority 3)

**Trigger Conditions:**

- At least 6 hours since last snapshot
- No higher-priority upkeep needed

**Actions:**

- Records yield metrics on-chain via events
- Emits `SnapshotRecorded(totalAssets, fees, funding, timestamp)`

**Interval:** 6 hours minimum

---

## Troubleshooting

### Upkeep Not Executing

**Symptoms:** No `UpkeepPerformed` events despite conditions being met

**Checks:**

1. Verify LINK balance is sufficient
2. Check if upkeep is paused in registry
3. Verify gas limit is adequate (recommend 500,000)
4. Check checkUpkeep returns true

```javascript
// Diagnose upkeep issues
async function diagnoseUpkeep(provider, controllerAddress) {
  const controller = new ethers.Contract(
    controllerAddress,
    ["function checkUpkeep(bytes) view returns (bool, bytes)"],
    provider
  );

  try {
    const [needed, data] = await controller.checkUpkeep("0x");
    console.log("checkUpkeep succeeded");
    console.log("Upkeep needed:", needed);
    console.log("Perform data:", data);
  } catch (error) {
    console.error("checkUpkeep failed:", error.message);
  }
}
```

### Rebalance Failing

**Symptoms:** `UpkeepPerformed(Rebalance)` events but delta not correcting

**Possible Causes:**

1. GMX order execution delays (orders are async)
2. Insufficient collateral for hedge adjustment
3. Slippage exceeding tolerance

**Resolution:**

- Monitor GMX order events
- Check HedgeManager.lastOrderKey() for pending orders
- Consider adjusting slippage tolerance

### High Gas Usage

**Symptoms:** LINK balance depleting faster than expected

**Checks:**

1. Review gas used per upkeep
2. Check if rebalances are happening too frequently
3. Verify no infinite loop conditions

---

## Manual Operations

If Chainlink Automation fails, manual operations can be performed:

### Manual Rebalance

```javascript
async function manualRebalance(signer, controllerAddress) {
  const controller = new ethers.Contract(
    controllerAddress,
    ["function performUpkeep(bytes) external"],
    signer
  );

  // performData is ignored, just needs to be valid bytes
  const tx = await controller.performUpkeep("0x");
  await tx.wait();

  console.log("Manual rebalance executed");
}
```

### Direct Vault Rebalance (Owner Only)

```javascript
async function directRebalance(signer, vaultAddress) {
  const vault = new ethers.Contract(
    vaultAddress,
    ["function rebalance(uint256 targetHedgeSize) external"],
    signer
  );

  // Pass 0 to let vault determine target
  const tx = await vault.rebalance(0);
  await tx.wait();

  console.log("Direct vault rebalance executed");
}
```

### Pause/Unpause Upkeep

```javascript
async function pauseUpkeep(signer, upkeepId) {
  const registry = new ethers.Contract(
    AUTOMATION_REGISTRY,
    ["function pauseUpkeep(uint256 id) external", "function unpauseUpkeep(uint256 id) external"],
    signer
  );

  await registry.pauseUpkeep(upkeepId);
  console.log("Upkeep paused");
}

async function unpauseUpkeep(signer, upkeepId) {
  const registry = new ethers.Contract(
    AUTOMATION_REGISTRY,
    ["function pauseUpkeep(uint256 id) external", "function unpauseUpkeep(uint256 id) external"],
    signer
  );

  await registry.unpauseUpkeep(upkeepId);
  console.log("Upkeep unpaused");
}
```

---

## Chainlink Automation Addresses (Arbitrum)

| Contract                 | Address                                      |
| ------------------------ | -------------------------------------------- |
| Automation Registry v2.1 | `0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1` |
| Automation Registrar     | `0x5a8be0b81746b42df48e6c52e2ed0c6fdd1e1c86` |
| LINK Token               | `0xf97f4df75117a78c1A5a0DBb814Af92458539FB4` |

---

## Recommended Configuration

| Parameter       | Value     | Rationale                           |
| --------------- | --------- | ----------------------------------- |
| Gas Limit       | 500,000   | Sufficient for rebalance operations |
| Check Gas Limit | 5,000,000 | Allow complex condition checking    |
| Min Balance     | 50 LINK   | 1-2 weeks of normal operation       |
| Alert Threshold | 20 LINK   | ~1 week buffer                      |

---

## Operational Checklist

### Daily

- [ ] Verify LINK balance is adequate
- [ ] Check recent UpkeepPerformed events
- [ ] Monitor delta ratio stays within threshold

### Weekly

- [ ] Review gas consumption trends
- [ ] Analyze rebalance frequency
- [ ] Top up LINK if below 50

### Monthly

- [ ] Audit upkeep execution history
- [ ] Review and optimize gas limits if needed
- [ ] Verify all events are being indexed
