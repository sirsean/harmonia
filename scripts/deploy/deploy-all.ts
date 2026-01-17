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
 *   MARKET=ETH npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum
 *   MARKET=BTC npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum
 *   MARKET=ARB npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum
 *
 * Required environment variables:
 *   MARKET - Market to deploy (ETH, BTC, ARB, LINK)
 *   PRIVATE_KEY - Deployer private key
 *   ARBISCAN_API_KEY - For contract verification (optional)
 *   DRY_RUN - Set to "true" to validate without deploying (optional)
 */

import { ethers, run, upgrades, network } from "hardhat";
import {
  getMarketConfig,
  getAvailableMarkets,
  ARBITRUM_PROTOCOLS,
  MarketConfig,
} from "../../src/markets/registry";
import { MarketValidator } from "../../src/markets/validator";
import { CONSTANTS } from "../config/addresses";

// ... (I need to find the interface)

/**
 * Main deployment function
 */
async function main(): Promise<DeploymentResult> {
  const marketId = process.env.MARKET;
  const dryRun = process.env.DRY_RUN === "true";

  // Workaround for "No known hardfork" error on Arbitrum fork
  if (network.name === "hardhat" || network.name === "localhost") {
    await network.provider.send("hardhat_mine", ["0x1"]);
  }

  console.log("\n" + "=".repeat(60));
  console.log("HARMONIA PROTOCOL DEPLOYMENT (UPGRADEABLE)");
  console.log("=".repeat(60) + "\n");

  // Validate market selection
  if (!marketId) {
    console.error("Error: MARKET environment variable required");
    console.log(`\nAvailable markets: ${getAvailableMarkets().join(", ")}`);
    console.log("\nUsage: MARKET=ETH npx hardhat run scripts/deploy/deploy-all.ts --network arbitrum");
    process.exit(1);
  }

  const market = getMarketConfig(marketId);
  if (!market) {
    console.error(`Error: Unknown market "${marketId}"`);
    console.log(`\nAvailable markets: ${getAvailableMarkets().join(", ")}`);
    process.exit(1);
  }

  console.log(`Market: ${market.name} (${market.id})`);
  console.log(`Mode: ${dryRun ? "DRY RUN (validation only)" : "LIVE DEPLOYMENT"}`);
  console.log("");

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

  // Validate chain ID matches market
  if (chainId !== market.chainId && chainId !== 31337) {
    console.error(`Error: Network mismatch. Market expects chainId ${market.chainId}, got ${chainId}`);
    process.exit(1);
  }

  // Build deployment config
  const config: DeploymentConfig = {
    vaultName: `Harmonia ${market.id} Vault`,
    vaultSymbol: `h${market.id}`,
    initialDepositCap: BigInt(10_000) * BigInt(10 ** market.quoteToken.decimals), // $10k initial cap
    poolFee: market.uniswapPool.feeTier,
    owner: deployerAddress,
    guardian: deployerAddress, // Set guardian same as owner initially
    protocolFeeBps: process.env.PROTOCOL_FEE_BPS ? parseInt(process.env.PROTOCOL_FEE_BPS) : 1000, // Default 10%
    treasury: process.env.TREASURY_ADDRESS || deployerAddress, // Default to deployer
  };

  console.log("Deployment Configuration:");
  console.log("  Vault Name:", config.vaultName);
  console.log("  Vault Symbol:", config.vaultSymbol);
  console.log("  Initial Deposit Cap:", ethers.formatUnits(config.initialDepositCap, market.quoteToken.decimals), market.quoteToken.symbol);
  console.log("  Pool Fee:", config.poolFee / 10000, "%");
  console.log("  Owner:", config.owner);
  console.log("  Guardian:", config.guardian);
  console.log("  Protocol Fee:", config.protocolFeeBps / 100, "%");
  console.log("  Treasury:", config.treasury);
  console.log("");

  console.log("Market Configuration:");
  console.log("  Base Token:", market.baseToken.symbol, `(${market.baseToken.address})`);
  console.log("  Quote Token:", market.quoteToken.symbol, `(${market.quoteToken.address})`);
  console.log("  Uniswap Pool:", market.uniswapPool.address);
  console.log("  GMX Market:", market.gmxMarket.marketAddress);
  console.log("  Chainlink Feed:", market.chainlinkFeed.address);
  console.log("");

  // Validate market on-chain
  console.log("Validating market configuration on-chain...");
  const validator = new MarketValidator(ethers.provider);
  const validationResult = await validator.validateMarket(market);

  if (validationResult.warnings.length > 0) {
    console.log("\nValidation Warnings:");
    validationResult.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }

  if (validationResult.errors.length > 0) {
    console.error("\n✗ Market validation failed with errors!");
    console.error("Errors:", validationResult.errors);
    process.exit(1);
  }

  if (!validationResult.isValid && !dryRun) {
    console.error("\n✗ Market validation failed (invalid state)!");
    process.exit(1);
  }

  console.log("✓ Market validation passed (or acceptable for dry run).\n");

  // If dry run, stop here
  if (dryRun) {
    console.log("=".repeat(60));
    console.log("DRY RUN COMPLETE - No contracts deployed");
    console.log("=".repeat(60));
    console.log("\nTo deploy for real, run without DRY_RUN=true");
    process.exit(0);
  }

  // Deploy contracts
  const contracts: DeployedContracts = {
    vault: "",
    liquidityManager: "",
    hedgeManager: "",
    rebalanceController: "",
  };

  // Step 1: Deploy DeltaNeutralVault
  console.log("Step 1/5: Deploying DeltaNeutralVault (Proxy)...");
  const vault = await deployVault(market.quoteToken.address, config);
  contracts.vault = await vault.getAddress();
  console.log("  Vault deployed at:", contracts.vault);
  console.log("");

  // Step 2: Deploy LiquidityManager
  console.log("Step 2/5: Deploying LiquidityManager (Proxy)...");
  const liquidityManager = await deployLiquidityManager(market, config);
  contracts.liquidityManager = await liquidityManager.getAddress();
  console.log("  LiquidityManager deployed at:", contracts.liquidityManager);
  console.log("");

  // Step 3: Deploy HedgeManager
  console.log("Step 3/5: Deploying HedgeManager (Proxy)...");
  const hedgeManager = await deployHedgeManager(market, config);
  contracts.hedgeManager = await hedgeManager.getAddress();
  console.log("  HedgeManager deployed at:", contracts.hedgeManager);
  console.log("");

  // Step 4: Deploy RebalanceController
  console.log("Step 4/5: Deploying RebalanceController (Proxy)...");
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
    await verifyContracts(contracts, market, config);
    console.log("  Verification complete.");
    console.log("");
  }

  // Print deployment summary
  const result: DeploymentResult = {
    contracts,
    config,
    market,
    deployer: deployerAddress,
    chainId,
    timestamp: Math.floor(Date.now() / 1000),
  };

  printDeploymentSummary(result);

  return result;
}

/**
 * Deploy DeltaNeutralVault
 */
async function deployVault(quoteTokenAddress: string, config: DeploymentConfig) {
  const VaultFactory = await ethers.getContractFactory("DeltaNeutralVault");

  const vault = await upgrades.deployProxy(VaultFactory, [
    quoteTokenAddress,
    config.vaultName,
    config.vaultSymbol,
    config.owner
  ], { kind: 'uups' });

  await vault.waitForDeployment();
  return vault;
}

/**
 * Deploy LiquidityManager
 */
async function deployLiquidityManager(market: MarketConfig, config: DeploymentConfig) {
  const LiquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");

  const liquidityManager = await upgrades.deployProxy(LiquidityManagerFactory, [
    ARBITRUM_PROTOCOLS.UNISWAP_V3_POSITION_MANAGER,
    ARBITRUM_PROTOCOLS.UNISWAP_V3_SWAP_ROUTER,
    ARBITRUM_PROTOCOLS.UNISWAP_V3_FACTORY,
    market.baseToken.address,
    market.quoteToken.address,
    config.poolFee,
    config.owner
  ], { kind: 'uups' });

  await liquidityManager.waitForDeployment();
  return liquidityManager;
}

/**
 * Deploy HedgeManager
 */
async function deployHedgeManager(market: MarketConfig, config: DeploymentConfig) {
  const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");

  const hedgeManager = await upgrades.deployProxy(HedgeManagerFactory, [
    ARBITRUM_PROTOCOLS.GMX_EXCHANGE_ROUTER,
    market.gmxMarket.marketAddress,
    market.quoteToken.address,
    market.baseToken.address,
    market.chainlinkFeed.address,
    config.owner
  ], { kind: 'uups' });

  await hedgeManager.waitForDeployment();
  return hedgeManager;
}

/**
 * Deploy RebalanceController
 */
async function deployRebalanceController(vaultAddress: string, config: DeploymentConfig) {
  const RebalanceControllerFactory = await ethers.getContractFactory("RebalanceController");

  const rebalanceController = await upgrades.deployProxy(RebalanceControllerFactory, [
    vaultAddress, 
    config.owner
  ], { kind: 'uups' });

  await rebalanceController.waitForDeployment();
  return rebalanceController;
}

/**
 * Configure all contracts with proper relationships
 */
async function configureContracts(
  vault: any,
  liquidityManager: any,
  hedgeManager: any,
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

  // Set protocol fee
  if (config.protocolFeeBps > 0) {
    console.log("  Setting protocol fee...");
    const setFeeTx = await vault.setProtocolFee(config.protocolFeeBps);
    await setFeeTx.wait();
  }

  // Set treasury
  if (config.treasury && config.treasury !== ethers.ZeroAddress) {
    console.log("  Setting treasury...");
    const setTreasuryTx = await vault.setTreasury(config.treasury);
    await setTreasuryTx.wait();
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
  market: MarketConfig,
  config: DeploymentConfig
): Promise<void> {
  console.log("Waiting 30 seconds for block explorer indexing...");
  await new Promise((resolve) => setTimeout(resolve, 30000));

  const verifications = [
    { name: "DeltaNeutralVault", address: contracts.vault },
    { name: "LiquidityManager", address: contracts.liquidityManager },
    { name: "HedgeManager", address: contracts.hedgeManager },
    { name: "RebalanceController", address: contracts.rebalanceController },
  ];

  for (const v of verifications) {
    try {
      console.log(`  Verifying ${v.name} at ${v.address}...`);
      // For proxies, we verify the proxy address. The hardhat-upgrades plugin
      // detects the proxy and verifies the implementation automatically.
      await run("verify:verify", {
        address: v.address,
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

  console.log("Market:", result.market.name);
  console.log("");

  console.log("Deployed Contracts:");
  console.log("  DeltaNeutralVault:    ", result.contracts.vault);
  console.log("  LiquidityManager:     ", result.contracts.liquidityManager);
  console.log("  HedgeManager:         ", result.contracts.hedgeManager);
  console.log("  RebalanceController:  ", result.contracts.rebalanceController);
  console.log("");

  console.log("Market Addresses Used:");
  console.log("  Base Token:           ", result.market.baseToken.symbol, `(${result.market.baseToken.address})`);
  console.log("  Quote Token:          ", result.market.quoteToken.symbol, `(${result.market.quoteToken.address})`);
  console.log("  Uniswap Pool:         ", result.market.uniswapPool.address);
  console.log("  GMX Market:           ", result.market.gmxMarket.marketAddress);
  console.log("  Chainlink Feed:       ", result.market.chainlinkFeed.address);
  console.log("");

  console.log("Configuration:");
  console.log("  Owner:                ", result.config.owner);
  console.log("  Guardian:             ", result.config.guardian);
  console.log(
    "  Deposit Cap:          ",
    ethers.formatUnits(result.config.initialDepositCap, result.market.quoteToken.decimals),
    result.market.quoteToken.symbol
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
  .then(() => {
    console.log("\nDeployment successful!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\nDeployment failed:", error);
    process.exit(1);
  });

export { main, DeploymentResult, DeployedContracts };
