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
```

### Compile Contracts

```bash
npm install
npm run compile
```

---

## Contract Overview

Harmonia consists of four main contracts that work together:

| Contract                | Purpose                             | Dependencies           |
| ----------------------- | ----------------------------------- | ---------------------- |
| **DeltaNeutralVault**   | ERC-4626 vault for user deposits    | USDC token             |
| **LiquidityManager**    | Uniswap V3 LP position management   | Uniswap V3, WETH, USDC |
| **HedgeManager**        | GMX V2 perpetual short positions    | GMX V2, Chainlink      |
| **RebalanceController** | Automated rebalancing via Chainlink | Vault                  |

### Contract Relationships

```
┌─────────────────────────────────────────────────────────────┐
│                    DeltaNeutralVault                        │
│                    (ERC-4626 Vault)                         │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Liquidity   │  │   Hedge      │  │    Rebalance      │  │
│  │  Manager    │  │   Manager    │  │    Controller     │  │
│  └──────┬──────┘  └──────┬───────┘  └─────────┬─────────┘  │
└─────────┼────────────────┼────────────────────┼────────────┘
          │                │                    │
          ▼                ▼                    ▼
    ┌──────────┐    ┌──────────┐        ┌──────────────┐
    │Uniswap V3│    │  GMX V2  │        │  Chainlink   │
    │   Pool   │    │ Exchange │        │  Automation  │
    └──────────┘    └──────────┘        └──────────────┘
```

---

## Constructor Arguments

### DeltaNeutralVault

```solidity
constructor(
    IERC20 _asset,        // USDC address
    string memory _name,   // Vault token name
    string memory _symbol, // Vault token symbol
    address _owner         // Initial owner address
)
```

| Parameter | Type    | Description                    | Mainnet Value                                |
| --------- | ------- | ------------------------------ | -------------------------------------------- |
| `_asset`  | address | Underlying asset (USDC)        | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| `_name`   | string  | ERC-20 name for vault shares   | `"Harmonia Delta-Neutral Vault"`             |
| `_symbol` | string  | ERC-20 symbol for vault shares | `"hDNV"`                                     |
| `_owner`  | address | Owner with admin privileges    | Deployer address                             |

### LiquidityManager

```solidity
constructor(
    address _positionManager, // Uniswap V3 NFT Position Manager
    address _swapRouter,      // Uniswap V3 Swap Router
    address _factory,         // Uniswap V3 Factory
    address _baseToken,       // Base token (WETH)
    address _quoteToken,      // Quote token (USDC)
    uint24 _poolFee,          // Pool fee tier
    address _owner            // Initial owner address
)
```

| Parameter          | Type    | Description                 | Mainnet Value                                |
| ------------------ | ------- | --------------------------- | -------------------------------------------- |
| `_positionManager` | address | Uniswap V3 Position Manager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| `_swapRouter`      | address | Uniswap V3 Swap Router      | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |
| `_factory`         | address | Uniswap V3 Factory          | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| `_baseToken`       | address | WETH address                | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| `_quoteToken`      | address | USDC address                | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| `_poolFee`         | uint24  | Pool fee tier (500 = 0.05%) | `500`                                        |
| `_owner`           | address | Owner with admin privileges | Deployer address                             |

### HedgeManager

```solidity
constructor(
    address _exchangeRouter,   // GMX V2 Exchange Router
    address _market,           // GMX V2 market address
    address _collateralToken,  // Collateral token (USDC)
    address _indexToken,       // Index token (WETH)
    address _priceFeed,        // Chainlink price feed
    address _owner             // Initial owner address
)
```

| Parameter          | Type    | Description                 | Mainnet Value                                |
| ------------------ | ------- | --------------------------- | -------------------------------------------- |
| `_exchangeRouter`  | address | GMX V2 Exchange Router      | `0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8` |
| `_market`          | address | GMX ETH/USD Market          | `0x70d95587d40A2caf56bd97485aB3Eec10Bee6336` |
| `_collateralToken` | address | USDC address                | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| `_indexToken`      | address | WETH address                | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| `_priceFeed`       | address | Chainlink ETH/USD feed      | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` |
| `_owner`           | address | Owner with admin privileges | Deployer address                             |

### RebalanceController

```solidity
constructor(
    address _vault,  // DeltaNeutralVault address
    address _owner   // Initial owner address
)
```

| Parameter | Type    | Description                 | Mainnet Value          |
| --------- | ------- | --------------------------- | ---------------------- |
| `_vault`  | address | DeltaNeutralVault contract  | Deployed vault address |
| `_owner`  | address | Owner with admin privileges | Deployer address       |

---

## Deployment Steps

### Multi-Market Deployment

Harmonia supports multiple token markets. Before deploying, validate your target market:

```bash
# Validate ETH market configuration (recommended first step)
MARKET=ETH npx hardhat run scripts/validate-market.ts --network arbitrum

# Available markets: ETH, BTC, ARB, LINK
# You can also discover new markets:
TOKEN=GMX npx hardhat run scripts/discover-markets.ts --network arbitrum
```

**Expected validation output for ETH:**
```
[Price Consistency]
  ℹ Chainlink price: $3306.26
  ℹ Uniswap price: $3306.19
  ℹ Price deviation: 0.00%
  ✓ Price sources are consistent

Overall: ✓ VALID
```

### Deploying harmETH (Step-by-Step Walkthrough)

This walkthrough deploys the primary ETH delta-neutral vault.

**1. Validate market configuration:**
```bash
MARKET=ETH npx hardhat run scripts/validate-market.ts --network arbitrum
```

**2. Deploy all contracts:**
```bash
MARKET=ETH npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum
```

**3. Verify deployment succeeded:**
- Check Arbiscan for all four deployed contracts
- Verify constructor arguments match expected values
- Confirm manager addresses are correctly linked

### Option 1: Automated Deployment Script (Recommended)

```bash
# Deploy all contracts for a specific market
MARKET=ETH npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum

# Or for other markets:
MARKET=BTC npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum
```

The script will:

1. Load market configuration from `src/markets/registry.ts`
2. Deploy all four contracts in order with correct addresses
3. Configure contract relationships
4. Set initial deposit cap ($10,000 USDC)
5. Output deployment addresses and verification commands

### Option 2: Manual Deployment

#### Step 1: Deploy DeltaNeutralVault

```bash
npx hardhat verify --network arbitrum VAULT_ADDRESS \
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" \
  "Harmonia Delta-Neutral Vault" \
  "hDNV" \
  "DEPLOYER_ADDRESS"
```

#### Step 2: Deploy LiquidityManager

```bash
npx hardhat verify --network arbitrum LM_ADDRESS \
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" \
  "0xE592427A0AEce92De3Edee1F18E0157C05861564" \
  "0x1F98431c8aD98523631AE4a59f267346ea31F984" \
  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" \
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" \
  500 \
  "DEPLOYER_ADDRESS"
```

#### Step 3: Deploy HedgeManager

```bash
npx hardhat verify --network arbitrum HM_ADDRESS \
  "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8" \
  "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336" \
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" \
  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" \
  "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612" \
  "DEPLOYER_ADDRESS"
```

#### Step 4: Deploy RebalanceController

```bash
npx hardhat verify --network arbitrum RC_ADDRESS \
  "VAULT_ADDRESS" \
  "DEPLOYER_ADDRESS"
```

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

### 4. Register Chainlink Automation

See [KEEPER_OPERATIONS.md](./KEEPER_OPERATIONS.md) for detailed instructions.

### 5. Transfer Ownership (Recommended)

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
