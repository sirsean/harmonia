# Harmonia Deployment Guide

This guide provides complete instructions for deploying the Harmonia delta-neutral vault protocol to Arbitrum.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Contract Overview](#contract-overview)
3. [Constructor Arguments](#constructor-arguments)
4. [Deployment Steps](#deployment-steps)
5. [Post-Deployment Configuration](#post-deployment-configuration)
6. [Contract Verification](#contract-verification)
7. [Security Checklist](#security-checklist)

---

## Prerequisites

### Required Software

- Node.js v18+
- npm or yarn
- Git

### Required Accounts

- **Deployer Wallet**: EOA with ETH for gas (recommend 0.5+ ETH on Arbitrum)
- **Arbiscan API Key**: For contract verification
- **Alchemy API Key**: For reliable RPC access

### Environment Setup

Create a `.env` file in the project root:

```bash
# Required for deployment
PRIVATE_KEY=your_deployer_private_key

# Required for contract verification
ARBISCAN_API_KEY=your_arbiscan_api_key

# Required for RPC access
ALCHEMY_API_KEY=your_alchemy_api_key

# Optional Configuration
PROTOCOL_FEE_BPS=100             # 1% (default 100)
TREASURY_ADDRESS=0x...           # Fee recipient (default deployer)
```

### Compile Contracts

```bash
npm install
npm run compile
```

---

## Contract Overview

Harmonia consists of four main contracts that work together. All core contracts are deployed as **UUPS (Universal Upgradeable Proxy Standard)** proxies, allowing for logic updates and bug fixes without migrating liquidity.

| Contract                | Purpose                             | Dependencies           | Upgrade Pattern |
| ----------------------- | ----------------------------------- | ---------------------- | --------------- |
| **DeltaNeutralVault**   | ERC-4626 vault for user deposits    | USDC token             | UUPS            |
| **LiquidityManager**    | Uniswap V3 LP position management   | Uniswap V3, WETH, USDC | UUPS            |
| **HedgeManager**        | GMX V2 perpetual short positions    | GMX V2, Chainlink      | UUPS            |
| **RebalanceController** | Automated rebalancing via Chainlink | Vault                  | UUPS            |

---

## Initializer Parameters

Since contracts use the UUPS proxy pattern, parameters are passed to an `initialize` function instead of a constructor.

### DeltaNeutralVault

```solidity
function initialize(
    IERC20 _asset,        // USDC address
    string memory _name,   // Vault token name
    string memory _symbol, // Vault token symbol
    address _owner         // Initial owner address
)
```

### LiquidityManager

```solidity
function initialize(
    address _positionManager, // Uniswap V3 NFT Position Manager
    address _swapRouter,      // Uniswap V3 Swap Router
    address _factory,         // Uniswap V3 Factory
    address _baseToken,       // Base token (WETH)
    address _quoteToken,      // Quote token (USDC)
    uint24 _poolFee,          // Pool fee tier
    address _owner            // Initial owner address
)
```

### HedgeManager

```solidity
function initialize(
    address _exchangeRouter,   // GMX V2 Exchange Router
    address _market,           // GMX V2 market address
    address _collateralToken,  // Collateral token (USDC)
    address _indexToken,       // Index token (WETH)
    address _priceFeed,        // Chainlink price feed
    address _owner             // Initial owner address
)
```

### RebalanceController

```solidity
function initialize(
    address _vault,  // DeltaNeutralVault address
    address _owner   // Initial owner address
)
```

---

## Deployment Steps

### Option 1: Automated Deployment Script (Recommended)

```bash
# Deploy all contracts for a specific market
MARKET=ETH npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum
```

The script uses `@openzeppelin/hardhat-upgrades` to deploy UUPS proxies for all core contracts.

### Option 2: Manual Deployment via Hardhat Upgrades

To deploy manually using the upgrades plugin:

```javascript
const { upgrades, ethers } = require("hardhat");

// Example for DeltaNeutralVault
const Vault = await ethers.getContractFactory("DeltaNeutralVault");
const vault = await upgrades.deployProxy(Vault, [
  USDC_ADDRESS,
  "Harmonia Vault",
  "hUSDC",
  OWNER_ADDRESS
], { kind: 'uups' });
await vault.waitForDeployment();
```

---

## Upgrading Contracts

To upgrade a contract's logic:

1. Update the Solidity code in the implementation contract.
2. If this is the first upgrade from this repo checkout, register the existing proxy:

```bash
CONTRACT=DeltaNeutralVault PROXY_ADDRESS=0x... \
  npx hardhat run scripts/upgrade/force-import.ts --network arbitrum
```

3. Run the UUPS upgrade helper (recommended):

```bash
# Prepare an upgrade (deploy implementation + emit calldata)
CONTRACT=DeltaNeutralVault PROXY_ADDRESS=0x... MODE=prepare \
  npx hardhat run scripts/upgrade/upgrade-proxy.ts --network arbitrum

# Execute an upgrade directly (EOA owner)
CONTRACT=DeltaNeutralVault PROXY_ADDRESS=0x... MODE=upgrade \
  npx hardhat run scripts/upgrade/upgrade-proxy.ts --network arbitrum
```

If the new implementation needs an initializer, pass it explicitly:

```bash
CONTRACT=DeltaNeutralVault PROXY_ADDRESS=0x... MODE=upgrade \
  INIT_FUNCTION=initializeV2 INIT_ARGS='[123, "0x..."]' \
  npx hardhat run scripts/upgrade/upgrade-proxy.ts --network arbitrum
```

**Note**: Only the contract owner can authorize an upgrade; when using an EOA, run with `MODE=upgrade`.

After an upgrade, copy the generated `.openzeppelin/<network>.json` manifest into `deployments/` with a timestamped name (e.g., `upgrade-manifest.arbitrum-one.2026-01-20T02-29-54Z.json`) to preserve history, and keep `.openzeppelin/` ignored to avoid test issues.

You can use the helper script to archive the manifest:

```bash
npx hardhat run scripts/upgrade/archive-manifest.ts --network arbitrum
```

If upgrading HedgeManager, verify the GMX ExchangeRouter address and ensure the underlying `router()` is approved for collateral transfers (handled in the latest implementation).

---

## Post-Deployment Configuration

After deployment, the following configuration steps are required:

### 1. Link Managers to Vault

```javascript
// Set vault address in LiquidityManager
await liquidityManager.setVault(vaultAddress);

// Set vault address in HedgeManager
await hedgeManager.setVault(vaultAddress);

// Set all managers in Vault
await vault.setManagers(liquidityManagerAddress, hedgeManagerAddress, rebalanceControllerAddress);
```

### 2. Set Guardian Address

The guardian can trigger emergency operations:

```javascript
await vault.setGuardian(guardianAddress);
```

**Recommendation**: Use a different address than the owner for defense-in-depth.

### 3. Set Initial Deposit Cap

Start with a conservative cap and increase as the system proves stable:

```javascript
// Set 10,000 USDC initial cap
await vault.setDepositCap(ethers.parseUnits("10000", 6));
```

### 4. Configure Protocol Fee (Optional)

If not set during deployment:

```javascript
// Set 1% fee and treasury address
await vault.setProtocolFee(100);
await vault.setTreasury(treasuryAddress);
```

### 5. Register Chainlink Automation

See [KEEPER_OPERATIONS.md](./KEEPER_OPERATIONS.md) for detailed instructions.

### 6. Transfer Ownership (Recommended)

For production deployments, transfer ownership to a multisig:

```javascript
await vault.transferOwnership(multisigAddress);
await liquidityManager.transferOwnership(multisigAddress);
await hedgeManager.transferOwnership(multisigAddress);
await rebalanceController.transferOwnership(multisigAddress);
```

---

## Contract Verification

Verify all contracts on Arbiscan for transparency:

```bash
# Automatic verification during deployment
ARBISCAN_API_KEY=your_key npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum

# Manual verification
npx hardhat verify --network arbitrum CONTRACT_ADDRESS CONSTRUCTOR_ARGS...
```

---

## Security Checklist

Before going live, verify:

### Deployment Verification

- [ ] All contracts deployed successfully
- [ ] All contracts verified on Arbiscan
- [ ] Constructor arguments match expected values
- [ ] Contract relationships properly configured

### Access Control

- [ ] Owner address is correct
- [ ] Guardian address is set (different from owner)
- [ ] Ownership transferred to multisig (for production)

### Configuration

- [ ] Deposit cap is set appropriately
- [ ] Slippage tolerances are reasonable (default values recommended)
- [ ] Chainlink Automation is registered and funded

### Testing

- [ ] Small test deposit successful
- [ ] Small test withdrawal successful
- [ ] Rebalance controller checkUpkeep returns correctly

### Monitoring

- [ ] Set up alerts for CircuitBreakerTriggered events
- [ ] Set up alerts for large withdrawals
- [ ] Monitor Chainlink Automation upkeep balance

---

## Mainnet Addresses Reference

### External Protocols (Arbitrum Mainnet)

| Protocol       | Contract             | Address                                      |
| -------------- | -------------------- | -------------------------------------------- |
| **Uniswap V3** | Factory              | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
|                | Position Manager     | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
|                | Swap Router          | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |
|                | WETH/USDC 0.05% Pool | `0xC6962004f452bE9203591991D15f6b388e09E8D0` |
| **GMX V2**     | Exchange Router      | `0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8` |
|                | Order Vault          | `0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5` |
|                | Data Store           | `0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8` |
|                | ETH/USD Market       | `0x70d95587d40A2caf56bd97485aB3Eec10Bee6336` |
| **Chainlink**  | ETH/USD Feed         | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` |
|                | Automation Registry  | `0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1` |
|                | LINK Token           | `0xf97f4df75117a78c1A5a0DBb814Af92458539FB4` |
| **Tokens**     | USDC (Native)        | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
|                | USDC.e (Bridged)     | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` |
|                | WETH                 | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |

**Note:** Harmonia uses **native USDC** (`0xaf88...`) for all markets. This is the same USDC used by GMX V2, ensuring consistency between the LP pool and hedge market. Do not use bridged USDC.e for new deployments.

### Market-Specific Addresses

For complete market configurations including BTC, ARB, and LINK markets, see:
- `src/markets/registry.ts` - Programmatic market configurations
- `PLAN.md` Appendix A - Reference addresses for all markets

---

## Troubleshooting

### Common Issues

**"No contract found at address"**

- Ensure you're deploying to the correct network
- Verify the external protocol addresses are correct for your network

**"Transaction reverted"**

- Check deployer has sufficient ETH for gas
- Verify constructor arguments are valid (non-zero addresses)

**"Already verified"**

- Contract was previously verified; this is not an error

**"Contract verification failed"**

- Wait a few blocks and retry
- Ensure ARBISCAN_API_KEY is valid
- Check constructor arguments match exactly

### Getting Help

- GitHub Issues: https://github.com/sirsean/harmonia/issues
- Documentation: See other files in `/docs`
