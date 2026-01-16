/**
 * Network-specific contract addresses for Harmonia deployment
 *
 * This file provides backward-compatible exports and re-exports from
 * the market registry. For multi-market support, use src/markets/registry.ts.
 *
 * @see src/markets/registry.ts for market-specific configurations
 */

// Re-export from market registry for convenience
export {
  ARBITRUM_PROTOCOLS,
  ARBITRUM_TOKENS,
  MARKET_REGISTRY,
  getMarketConfig,
  getAvailableMarkets,
} from "../../src/markets/registry";

export type { MarketConfig, TokenConfig } from "../../src/markets/types";

/**
 * Legacy NetworkAddresses interface
 * @deprecated Use MarketConfig from src/markets/registry.ts for multi-market support
 */
export interface NetworkAddresses {
  // Uniswap V3
  uniswapV3Factory: string;
  uniswapV3PositionManager: string;
  uniswapV3SwapRouter: string;
  uniswapV3EthUsdcPool: string;

  // GMX V2
  gmxExchangeRouter: string;
  gmxOrderVault: string;
  gmxDataStore: string;
  gmxEthUsdMarket: string;

  // Chainlink
  chainlinkEthUsdFeed: string;
  chainlinkAutomationRegistry: string;
  chainlinkAutomationRegistrar: string;
  linkToken: string;

  // Tokens
  usdc: string;
  weth: string;
}

/**
 * Arbitrum Mainnet addresses (ETH market)
 * Chain ID: 42161
 * @deprecated Use getMarketConfig('ETH') from src/markets/registry.ts
 */
export const ARBITRUM_MAINNET: NetworkAddresses = {
  // Uniswap V3 - https://docs.uniswap.org/contracts/v3/reference/deployments
  uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  uniswapV3PositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  uniswapV3SwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  uniswapV3EthUsdcPool: "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443", // 0.05% fee tier

  // GMX V2 - https://docs.gmx.io/docs/api/contracts-v2
  gmxExchangeRouter: "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8",
  gmxOrderVault: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  gmxDataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
  gmxEthUsdMarket: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",

  // Chainlink - https://docs.chain.link/data-feeds/price-feeds/addresses
  chainlinkEthUsdFeed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  // Chainlink Automation 2.1 - https://docs.chain.link/chainlink-automation/overview/supported-networks
  chainlinkAutomationRegistry: "0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1",
  chainlinkAutomationRegistrar: "0x5a8be0b81746b42df48e6c52e2ed0c6fdd1e1c86",
  linkToken: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",

  // Tokens
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Native USDC (6 decimals)
  weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH (18 decimals)
};

/**
 * Arbitrum Sepolia Testnet addresses
 * Chain ID: 421614
 *
 * NOTE: Many addresses may differ or not exist on testnet.
 * Update these addresses before testnet deployment.
 */
export const ARBITRUM_SEPOLIA: NetworkAddresses = {
  // Uniswap V3 - May not be deployed on Sepolia
  uniswapV3Factory: "0x0000000000000000000000000000000000000000",
  uniswapV3PositionManager: "0x0000000000000000000000000000000000000000",
  uniswapV3SwapRouter: "0x0000000000000000000000000000000000000000",
  uniswapV3EthUsdcPool: "0x0000000000000000000000000000000000000000",

  // GMX V2 - May not be deployed on Sepolia
  gmxExchangeRouter: "0x0000000000000000000000000000000000000000",
  gmxOrderVault: "0x0000000000000000000000000000000000000000",
  gmxDataStore: "0x0000000000000000000000000000000000000000",
  gmxEthUsdMarket: "0x0000000000000000000000000000000000000000",

  // Chainlink Sepolia
  chainlinkEthUsdFeed: "0x0000000000000000000000000000000000000000",
  chainlinkAutomationRegistry: "0x0000000000000000000000000000000000000000",
  chainlinkAutomationRegistrar: "0x0000000000000000000000000000000000000000",
  linkToken: "0x0000000000000000000000000000000000000000",

  // Test tokens - would need to be deployed
  usdc: "0x0000000000000000000000000000000000000000",
  weth: "0x0000000000000000000000000000000000000000",
};

/**
 * Get addresses for a specific network
 * @deprecated Use getMarketConfig(marketId) from src/markets/registry.ts
 * @param chainId Network chain ID
 * @returns NetworkAddresses for the specified network (ETH market)
 */
export function getNetworkAddresses(chainId: number): NetworkAddresses {
  switch (chainId) {
    case 42161:
      return ARBITRUM_MAINNET;
    case 421614:
      return ARBITRUM_SEPOLIA;
    default:
      // For local fork testing, return mainnet addresses
      return ARBITRUM_MAINNET;
  }
}

/**
 * Deployment configuration parameters
 */
export interface DeploymentConfig {
  // Vault configuration
  vaultName: string;
  vaultSymbol: string;
  initialDepositCap: bigint;

  // Pool configuration
  poolFee: number; // Uniswap pool fee tier (500 = 0.05%)

  // Role addresses
  owner: string; // Deployer/owner address
  guardian: string; // Guardian for emergency operations
}

/**
 * Default deployment configuration for mainnet
 * @deprecated Configure per-market in deploy-all.ts
 */
export const DEFAULT_DEPLOYMENT_CONFIG: Partial<DeploymentConfig> = {
  vaultName: "Harmonia Delta-Neutral Vault",
  vaultSymbol: "hDNV",
  initialDepositCap: BigInt(10_000) * BigInt(10 ** 6), // $10,000 USDC initial cap
  poolFee: 500, // 0.05% fee tier
};

/**
 * Contract constants for reference
 */
export const CONSTANTS = {
  // Precision values
  PRECISION: BigInt(10 ** 18),
  GMX_USD_PRECISION: BigInt(10 ** 30),

  // Strategy parameters
  DELTA_THRESHOLD: BigInt(5) * BigInt(10 ** 16), // 5%
  EMERGENCY_THRESHOLD: BigInt(20) * BigInt(10 ** 16), // 20%
  MAX_LEVERAGE: BigInt(3) * BigInt(10 ** 18), // 3x
  MIN_HEDGE_RATIO: BigInt(80) * BigInt(10 ** 16), // 80%

  // Security parameters
  MAX_SINGLE_WITHDRAWAL: BigInt(25) * BigInt(10 ** 16), // 25%
  LARGE_WITHDRAWAL_COOLDOWN: 3600, // 1 hour in seconds
  LARGE_WITHDRAWAL_THRESHOLD: BigInt(10) * BigInt(10 ** 16), // 10%

  // Keeper intervals
  MIN_REBALANCE_INTERVAL: 3600, // 1 hour
  MAX_REBALANCE_INTERVAL: 86400, // 24 hours
  MIN_COMPOUND_INTERVAL: 86400, // 24 hours
  MIN_SNAPSHOT_INTERVAL: 21600, // 6 hours

  // Token decimals
  USDC_DECIMALS: 6,
  WETH_DECIMALS: 18,
  CHAINLINK_DECIMALS: 8,
};
