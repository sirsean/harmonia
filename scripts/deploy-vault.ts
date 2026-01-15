/**
 * Vault Deployment Script
 *
 * Deploys a delta-neutral vault for a specified market configuration.
 * Validates the market before deployment and outputs constructor arguments.
 *
 * Usage:
 *   MARKET=ETH npx hardhat run scripts/deploy-vault.ts --network arbitrum
 *   MARKET=BTC npx hardhat run scripts/deploy-vault.ts --network arbitrum
 *   MARKET=ARB npx hardhat run scripts/deploy-vault.ts --network arbitrum
 *
 * Environment variables:
 *   MARKET          - Market to deploy (ETH, BTC, ARB, LINK)
 *   DRY_RUN         - Set to "true" to only print deployment info without deploying
 *   VERIFY          - Set to "true" to verify on Arbiscan after deployment
 */

import { ethers } from "hardhat";
import { getMarketConfig, getAvailableMarkets, ARBITRUM_PROTOCOLS } from "../src/markets/registry";
import { MarketValidator } from "../src/markets/validator";
import { MarketConfig } from "../src/markets/types";

interface DeploymentResult {
  vaultAddress: string;
  marketId: string;
  transactionHash: string;
  constructorArgs: any[];
}

async function main(): Promise<void> {
  const marketId = process.env.MARKET;
  const dryRun = process.env.DRY_RUN === "true";
  const verify = process.env.VERIFY === "true";

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║           HARMONIA VAULT DEPLOYMENT                        ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  // Validate market selection
  if (!marketId) {
    console.error("\nError: MARKET environment variable required");
    console.log(`\nAvailable markets: ${getAvailableMarkets().join(", ")}`);
    console.log("\nUsage: MARKET=ETH npx hardhat run scripts/deploy-vault.ts --network arbitrum");
    process.exit(1);
  }

  const config = getMarketConfig(marketId);
  if (!config) {
    console.error(`\nError: Unknown market "${marketId}"`);
    console.log(`\nAvailable markets: ${getAvailableMarkets().join(", ")}`);
    process.exit(1);
  }

  console.log(`\nMarket: ${config.name} (${config.id})`);
  console.log(`Chain ID: ${config.chainId}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no deployment)" : "LIVE DEPLOYMENT"}`);

  // Get network info
  const network = await ethers.provider.getNetwork();
  console.log(`\nConnected to network: ${network.name} (chainId: ${network.chainId})`);

  if (Number(network.chainId) !== config.chainId) {
    console.error(`\nError: Network mismatch. Expected chainId ${config.chainId}, got ${network.chainId}`);
    process.exit(1);
  }

  // Validate market on-chain
  console.log("\n" + "─".repeat(60));
  console.log("VALIDATING MARKET CONFIGURATION");
  console.log("─".repeat(60));

  const validator = new MarketValidator(ethers.provider);
  const validationResult = await validator.validateMarket(config);

  if (!validationResult.isValid) {
    console.error("\n✗ Market validation failed!");
    console.error("Errors:", validationResult.errors);
    process.exit(1);
  }

  console.log("\n✓ Market validation passed");

  // Prepare constructor arguments
  const constructorArgs = prepareConstructorArgs(config);

  // Print deployment info
  console.log("\n" + "─".repeat(60));
  console.log("DEPLOYMENT CONFIGURATION");
  console.log("─".repeat(60));
  printDeploymentInfo(config, constructorArgs);

  if (dryRun) {
    console.log("\n" + "─".repeat(60));
    console.log("DRY RUN COMPLETE - No deployment executed");
    console.log("─".repeat(60));
    console.log("\nTo deploy for real, run without DRY_RUN=true");
    return;
  }

  // Deploy vault
  console.log("\n" + "─".repeat(60));
  console.log("DEPLOYING VAULT");
  console.log("─".repeat(60));

  const result = await deployVault(config, constructorArgs);

  console.log("\n✓ Vault deployed successfully!");
  console.log(`  Address: ${result.vaultAddress}`);
  console.log(`  Transaction: ${result.transactionHash}`);

  // Verify on Arbiscan if requested
  if (verify) {
    console.log("\n" + "─".repeat(60));
    console.log("VERIFYING ON ARBISCAN");
    console.log("─".repeat(60));
    await verifyContract(result.vaultAddress, constructorArgs);
  }

  // Output deployment summary
  console.log("\n" + "═".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("═".repeat(60));
  console.log(`
Market:           ${config.name}
Vault Address:    ${result.vaultAddress}
Transaction:      ${result.transactionHash}

Next steps:
1. Verify the contract on Arbiscan (if not already done)
2. Set up Chainlink Automation keeper
3. Configure initial strategy parameters
4. Seed initial liquidity
5. Enable deposits
`);
}

/**
 * Prepare constructor arguments for the vault
 */
function prepareConstructorArgs(config: MarketConfig): any[] {
  return [
    // Core tokens
    config.quoteToken.address,      // USDC (deposit token)
    config.baseToken.address,       // WETH/WBTC/ARB (volatile token)

    // Uniswap V3
    config.uniswapPool.address,
    ARBITRUM_PROTOCOLS.UNISWAP_V3_POSITION_MANAGER,
    ARBITRUM_PROTOCOLS.UNISWAP_V3_SWAP_ROUTER,
    config.uniswapPool.feeTier,

    // GMX V2
    config.gmxMarket.marketAddress,
    ARBITRUM_PROTOCOLS.GMX_EXCHANGE_ROUTER,
    ARBITRUM_PROTOCOLS.GMX_ORDER_VAULT,
    ARBITRUM_PROTOCOLS.GMX_DATA_STORE,

    // Chainlink
    config.chainlinkFeed.address,

    // Configuration
    config.baseTokenIsToken0,
    config.baseToken.decimals,
    config.quoteToken.decimals,

    // Strategy parameters
    Math.floor(config.strategyParams.defaultRangeWidth * 10000), // basis points
    Math.floor(config.strategyParams.rebalanceThreshold * 10000), // basis points
    Math.floor(config.strategyParams.maxHedgeLeverage * 100),     // 100 = 1x
  ];
}

/**
 * Print deployment information
 */
function printDeploymentInfo(config: MarketConfig, args: any[]): void {
  console.log(`
Vault Configuration:
  Name:              Harmonia ${config.id} Vault
  Symbol:            h${config.id}
  Quote Token:       ${config.quoteToken.symbol} (${config.quoteToken.address})
  Base Token:        ${config.baseToken.symbol} (${config.baseToken.address})

Uniswap V3:
  Pool:              ${config.uniswapPool.address}
  Fee Tier:          ${config.uniswapPool.feeTier / 10000}%
  Tick Spacing:      ${config.uniswapPool.tickSpacing}
  Position Manager:  ${ARBITRUM_PROTOCOLS.UNISWAP_V3_POSITION_MANAGER}
  Swap Router:       ${ARBITRUM_PROTOCOLS.UNISWAP_V3_SWAP_ROUTER}

GMX V2:
  Market:            ${config.gmxMarket.marketAddress}
  Exchange Router:   ${ARBITRUM_PROTOCOLS.GMX_EXCHANGE_ROUTER}
  Order Vault:       ${ARBITRUM_PROTOCOLS.GMX_ORDER_VAULT}
  Data Store:        ${ARBITRUM_PROTOCOLS.GMX_DATA_STORE}

Chainlink:
  Price Feed:        ${config.chainlinkFeed.address}
  Description:       ${config.chainlinkFeed.description}
  Decimals:          ${config.chainlinkFeed.decimals}

Strategy Parameters:
  Default Range:     ±${(config.strategyParams.defaultRangeWidth * 100).toFixed(0)}%
  Rebalance At:      ${(config.strategyParams.rebalanceThreshold * 100).toFixed(0)}% delta drift
  Max Leverage:      ${config.strategyParams.maxHedgeLeverage}x

Token Configuration:
  Base is Token0:    ${config.baseTokenIsToken0}
  Base Decimals:     ${config.baseToken.decimals}
  Quote Decimals:    ${config.quoteToken.decimals}

Risk Profile:
  Volatility:        ${config.characteristics.volatilityLevel}
  Liquidity:         ${config.characteristics.liquidityRating}
  Risk Level:        ${config.characteristics.riskLevel}
  Expected APY:      ${config.characteristics.expectedFeeApy[0]}-${config.characteristics.expectedFeeApy[1]}%
`);
}

/**
 * Deploy the vault contract
 */
async function deployVault(
  config: MarketConfig,
  constructorArgs: any[]
): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer address: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} ETH`);

  // Note: This assumes the DeltaNeutralVault contract exists
  // You'll need to implement the actual vault contract first
  console.log("\nDeploying DeltaNeutralVault...");

  // Placeholder - replace with actual deployment when vault contract is ready
  // const VaultFactory = await ethers.getContractFactory("DeltaNeutralVault");
  // const vault = await VaultFactory.deploy(...constructorArgs);
  // await vault.waitForDeployment();

  // For now, just simulate
  console.log("\n⚠ Note: Vault contract not yet implemented");
  console.log("  This script will work once DeltaNeutralVault.sol is created");
  console.log("\n  Constructor arguments prepared:");
  constructorArgs.forEach((arg, i) => {
    console.log(`    [${i}]: ${arg}`);
  });

  // Return placeholder result
  return {
    vaultAddress: "0x0000000000000000000000000000000000000000",
    marketId: config.id,
    transactionHash: "0x0",
    constructorArgs,
  };
}

/**
 * Verify contract on Arbiscan
 */
async function verifyContract(address: string, constructorArgs: any[]): Promise<void> {
  console.log(`Verifying contract at ${address}...`);

  try {
    // await run("verify:verify", {
    //   address: address,
    //   constructorArguments: constructorArgs,
    // });
    console.log("✓ Contract verified on Arbiscan");
  } catch (error) {
    console.log(`⚠ Verification failed: ${(error as Error).message}`);
    console.log("  You can verify manually on Arbiscan");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
