/**
 * Full Harmonia Protocol Deployment Script
 *
 * This script deploys all Harmonia contracts in the correct order:
 * 1. DeltaNeutralVault - Main ERC-4626 vault
 * 2. LiquidityManager - Uniswap V3 position management
 * 3. HedgeManager - GMX V2 perpetual hedging
 * 4. RebalanceController - Chainlink Automation keeper
 * 5. Configure vault with all manager addresses
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum
 *
 * Required environment variables:
 *   PRIVATE_KEY - Deployer private key
 *   ARBISCAN_API_KEY - For contract verification (optional)
 */

import { ethers, network, run } from "hardhat";
import {
  getNetworkAddresses,
  DEFAULT_DEPLOYMENT_CONFIG,
  CONSTANTS,
  type DeploymentConfig,
  type NetworkAddresses,
} from "../config/addresses";

interface DeployedContracts {
  vault: string;
  liquidityManager: string;
  hedgeManager: string;
  rebalanceController: string;
}

interface DeploymentResult {
  contracts: DeployedContracts;
  config: DeploymentConfig;
  networkAddresses: NetworkAddresses;
  deployer: string;
  chainId: number;
  timestamp: number;
}

/**
 * Main deployment function
 */
async function main(): Promise<DeploymentResult> {
  console.log("\n" + "=".repeat(60));
  console.log("HARMONIA PROTOCOL DEPLOYMENT");
  console.log("=".repeat(60) + "\n");

  // Get deployer account
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log("Deployer:", deployerAddress);
  console.log("Chain ID:", chainId);
  console.log(
    "Balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployerAddress)),
    "ETH"
  );
  console.log("");

  // Get network-specific addresses
  const addresses = getNetworkAddresses(chainId);

  // Build deployment config
  const config: DeploymentConfig = {
    vaultName: DEFAULT_DEPLOYMENT_CONFIG.vaultName || "Harmonia Delta-Neutral Vault",
    vaultSymbol: DEFAULT_DEPLOYMENT_CONFIG.vaultSymbol || "hDNV",
    initialDepositCap:
      DEFAULT_DEPLOYMENT_CONFIG.initialDepositCap || BigInt(10_000) * BigInt(10 ** 6),
    poolFee: DEFAULT_DEPLOYMENT_CONFIG.poolFee || 500,
    owner: deployerAddress,
    guardian: deployerAddress, // Set guardian same as owner initially
  };

  console.log("Deployment Configuration:");
  console.log("  Vault Name:", config.vaultName);
  console.log("  Vault Symbol:", config.vaultSymbol);
  console.log("  Initial Deposit Cap:", ethers.formatUnits(config.initialDepositCap, 6), "USDC");
  console.log("  Pool Fee:", config.poolFee / 10000, "%");
  console.log("  Owner:", config.owner);
  console.log("  Guardian:", config.guardian);
  console.log("");

  // Validate addresses
  console.log("Validating external contract addresses...");
  await validateAddresses(addresses);
  console.log("All addresses validated.\n");

  // Deploy contracts
  const contracts: DeployedContracts = {
    vault: "",
    liquidityManager: "",
    hedgeManager: "",
    rebalanceController: "",
  };

  // Step 1: Deploy DeltaNeutralVault
  console.log("Step 1/5: Deploying DeltaNeutralVault...");
  const vault = await deployVault(addresses.usdc, config);
  contracts.vault = await vault.getAddress();
  console.log("  Vault deployed at:", contracts.vault);
  console.log("");

  // Step 2: Deploy LiquidityManager
  console.log("Step 2/5: Deploying LiquidityManager...");
  const liquidityManager = await deployLiquidityManager(addresses, config);
  contracts.liquidityManager = await liquidityManager.getAddress();
  console.log("  LiquidityManager deployed at:", contracts.liquidityManager);
  console.log("");

  // Step 3: Deploy HedgeManager
  console.log("Step 3/5: Deploying HedgeManager...");
  const hedgeManager = await deployHedgeManager(addresses, config);
  contracts.hedgeManager = await hedgeManager.getAddress();
  console.log("  HedgeManager deployed at:", contracts.hedgeManager);
  console.log("");

  // Step 4: Deploy RebalanceController
  console.log("Step 4/5: Deploying RebalanceController...");
  const rebalanceController = await deployRebalanceController(contracts.vault, config);
  contracts.rebalanceController = await rebalanceController.getAddress();
  console.log("  RebalanceController deployed at:", contracts.rebalanceController);
  console.log("");

  // Step 5: Configure contracts
  console.log("Step 5/5: Configuring contracts...");
  await configureContracts(vault, liquidityManager, hedgeManager, contracts, config);
  console.log("  Configuration complete.");
  console.log("");

  // Verify contracts if not on local network
  if (chainId !== 31337 && process.env.ARBISCAN_API_KEY) {
    console.log("Verifying contracts on Arbiscan...");
    await verifyContracts(contracts, addresses, config);
    console.log("  Verification complete.");
    console.log("");
  }

  // Print deployment summary
  const result: DeploymentResult = {
    contracts,
    config,
    networkAddresses: addresses,
    deployer: deployerAddress,
    chainId,
    timestamp: Math.floor(Date.now() / 1000),
  };

  printDeploymentSummary(result);

  return result;
}

/**
 * Validate that all required external addresses have code
 */
async function validateAddresses(addresses: NetworkAddresses): Promise<void> {
  const checks = [
    { name: "USDC", address: addresses.usdc },
    { name: "WETH", address: addresses.weth },
    { name: "Uniswap V3 Factory", address: addresses.uniswapV3Factory },
    {
      name: "Uniswap V3 Position Manager",
      address: addresses.uniswapV3PositionManager,
    },
    { name: "Uniswap V3 Swap Router", address: addresses.uniswapV3SwapRouter },
    { name: "GMX Exchange Router", address: addresses.gmxExchangeRouter },
    { name: "GMX ETH/USD Market", address: addresses.gmxEthUsdMarket },
    { name: "Chainlink ETH/USD Feed", address: addresses.chainlinkEthUsdFeed },
  ];

  for (const check of checks) {
    const code = await ethers.provider.getCode(check.address);
    if (code === "0x") {
      throw new Error(`No contract found at ${check.name} address: ${check.address}`);
    }
    console.log(`  ✓ ${check.name}: ${check.address}`);
  }
}

/**
 * Deploy DeltaNeutralVault
 */
async function deployVault(usdcAddress: string, config: DeploymentConfig) {
  const VaultFactory = await ethers.getContractFactory("DeltaNeutralVault");

  const vault = await VaultFactory.deploy(
    usdcAddress,
    config.vaultName,
    config.vaultSymbol,
    config.owner
  );

  await vault.waitForDeployment();
  return vault;
}

/**
 * Deploy LiquidityManager
 */
async function deployLiquidityManager(addresses: NetworkAddresses, config: DeploymentConfig) {
  const LiquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");

  const liquidityManager = await LiquidityManagerFactory.deploy(
    addresses.uniswapV3PositionManager,
    addresses.uniswapV3SwapRouter,
    addresses.uniswapV3Factory,
    addresses.weth,
    addresses.usdc,
    config.poolFee,
    config.owner
  );

  await liquidityManager.waitForDeployment();
  return liquidityManager;
}

/**
 * Deploy HedgeManager
 */
async function deployHedgeManager(addresses: NetworkAddresses, config: DeploymentConfig) {
  const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");

  const hedgeManager = await HedgeManagerFactory.deploy(
    addresses.gmxExchangeRouter,
    addresses.gmxEthUsdMarket,
    addresses.usdc,
    addresses.weth,
    addresses.chainlinkEthUsdFeed,
    config.owner
  );

  await hedgeManager.waitForDeployment();
  return hedgeManager;
}

/**
 * Deploy RebalanceController
 */
async function deployRebalanceController(vaultAddress: string, config: DeploymentConfig) {
  const RebalanceControllerFactory = await ethers.getContractFactory("RebalanceController");

  const rebalanceController = await RebalanceControllerFactory.deploy(vaultAddress, config.owner);

  await rebalanceController.waitForDeployment();
  return rebalanceController;
}

/**
 * Configure all contracts with proper relationships
 */
async function configureContracts(
  vault: Awaited<ReturnType<typeof deployVault>>,
  liquidityManager: Awaited<ReturnType<typeof deployLiquidityManager>>,
  hedgeManager: Awaited<ReturnType<typeof deployHedgeManager>>,
  contracts: DeployedContracts,
  config: DeploymentConfig
): Promise<void> {
  // Set vault in LiquidityManager
  console.log("  Setting vault in LiquidityManager...");
  const lmSetVaultTx = await liquidityManager.setVault(contracts.vault);
  await lmSetVaultTx.wait();

  // Set vault in HedgeManager
  console.log("  Setting vault in HedgeManager...");
  const hmSetVaultTx = await hedgeManager.setVault(contracts.vault);
  await hmSetVaultTx.wait();

  // Set managers in Vault
  console.log("  Setting managers in Vault...");
  const setManagersTx = await vault.setManagers(
    contracts.liquidityManager,
    contracts.hedgeManager,
    contracts.rebalanceController
  );
  await setManagersTx.wait();

  // Set guardian
  if (config.guardian && config.guardian !== config.owner) {
    console.log("  Setting guardian...");
    const setGuardianTx = await vault.setGuardian(config.guardian);
    await setGuardianTx.wait();
  }

  // Set initial deposit cap
  if (config.initialDepositCap > 0) {
    console.log("  Setting deposit cap...");
    const setCapTx = await vault.setDepositCap(config.initialDepositCap);
    await setCapTx.wait();
  }
}

/**
 * Verify contracts on Arbiscan
 */
async function verifyContracts(
  contracts: DeployedContracts,
  addresses: NetworkAddresses,
  config: DeploymentConfig
): Promise<void> {
  const verifications = [
    {
      name: "DeltaNeutralVault",
      address: contracts.vault,
      args: [addresses.usdc, config.vaultName, config.vaultSymbol, config.owner],
    },
    {
      name: "LiquidityManager",
      address: contracts.liquidityManager,
      args: [
        addresses.uniswapV3PositionManager,
        addresses.uniswapV3SwapRouter,
        addresses.uniswapV3Factory,
        addresses.weth,
        addresses.usdc,
        config.poolFee,
        config.owner,
      ],
    },
    {
      name: "HedgeManager",
      address: contracts.hedgeManager,
      args: [
        addresses.gmxExchangeRouter,
        addresses.gmxEthUsdMarket,
        addresses.usdc,
        addresses.weth,
        addresses.chainlinkEthUsdFeed,
        config.owner,
      ],
    },
    {
      name: "RebalanceController",
      address: contracts.rebalanceController,
      args: [contracts.vault, config.owner],
    },
  ];

  for (const v of verifications) {
    try {
      console.log(`  Verifying ${v.name}...`);
      await run("verify:verify", {
        address: v.address,
        constructorArguments: v.args,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("Already Verified")) {
        console.log(`  ${v.name} already verified.`);
      } else {
        console.error(`  Failed to verify ${v.name}:`, error);
      }
    }
  }
}

/**
 * Print deployment summary
 */
function printDeploymentSummary(result: DeploymentResult): void {
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60) + "\n");

  console.log("Deployed Contracts:");
  console.log("  DeltaNeutralVault:    ", result.contracts.vault);
  console.log("  LiquidityManager:     ", result.contracts.liquidityManager);
  console.log("  HedgeManager:         ", result.contracts.hedgeManager);
  console.log("  RebalanceController:  ", result.contracts.rebalanceController);
  console.log("");

  console.log("Configuration:");
  console.log("  Owner:                ", result.config.owner);
  console.log("  Guardian:             ", result.config.guardian);
  console.log(
    "  Deposit Cap:          ",
    ethers.formatUnits(result.config.initialDepositCap, 6),
    "USDC"
  );
  console.log("");

  console.log("Network Information:");
  console.log("  Chain ID:             ", result.chainId);
  console.log("  Deployer:             ", result.deployer);
  console.log("  Timestamp:            ", new Date(result.timestamp * 1000).toISOString());
  console.log("");

  console.log("Next Steps:");
  console.log("  1. Register RebalanceController with Chainlink Automation");
  console.log("  2. Fund the Automation upkeep with LINK tokens");
  console.log("  3. Set appropriate guardian address (if different from owner)");
  console.log("  4. Increase deposit cap as needed");
  console.log("  5. Transfer ownership to multisig (recommended)");
  console.log("");

  // Output JSON for programmatic use
  console.log("Deployment JSON (save this):");
  console.log(JSON.stringify(result, bigIntReplacer, 2));
}

/**
 * JSON replacer for BigInt values
 */
function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

// Execute deployment
main()
  .then((result) => {
    console.log("\nDeployment successful!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\nDeployment failed:", error);
    process.exit(1);
  });

export { main, DeploymentResult, DeployedContracts };
