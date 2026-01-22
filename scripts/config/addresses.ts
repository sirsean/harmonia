/**
 * Network-specific contract addresses for Harmonia
 *
 * This file contains all external protocol addresses needed for the
 * EOA-based delta-neutral strategy on Arbitrum.
 */

/**
 * Network addresses for Arbitrum
 */
export interface NetworkAddresses {
  // Uniswap V3
  uniswapV3Factory: string;
  uniswapV3PositionManager: string;
  uniswapV3SwapRouter: string;
  uniswapV3Quoter: string;
  uniswapV3EthUsdcPool: string;

  // GMX V2
  gmxExchangeRouter: string;
  gmxOrderVault: string;
  gmxDataStore: string;
  gmxReader: string;
  gmxEthUsdMarket: string;

  // Chainlink
  chainlinkEthUsdFeed: string;

  // Tokens
  usdc: string;
  weth: string;
}

/**
 * Arbitrum Mainnet addresses (ETH market)
 * Chain ID: 42161
 */
export const ARBITRUM_MAINNET: NetworkAddresses = {
  // Uniswap V3 - https://docs.uniswap.org/contracts/v3/reference/deployments
  uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  uniswapV3PositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  uniswapV3SwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  uniswapV3Quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
  uniswapV3EthUsdcPool: "0xC6962004f452bE9203591991D15f6b388e09E8D0", // 0.05% fee tier, native USDC

  // GMX V2 - https://docs.gmx.io/docs/api/contracts-v2
  gmxExchangeRouter: "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8",
  gmxOrderVault: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  gmxDataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
  gmxReader: "0xf60becbba223EEA9495Da3f606753867eC10d139",
  gmxEthUsdMarket: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",

  // Chainlink - https://docs.chain.link/data-feeds/price-feeds/addresses
  chainlinkEthUsdFeed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",

  // Tokens
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Native USDC (6 decimals)
  weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH (18 decimals)
};

/**
 * Get addresses for a specific network
 * @param chainId Network chain ID
 * @returns NetworkAddresses for the specified network
 */
export function getNetworkAddresses(chainId: number): NetworkAddresses {
  switch (chainId) {
    case 42161:
      return ARBITRUM_MAINNET;
    default:
      // For local fork testing, return mainnet addresses
      return ARBITRUM_MAINNET;
  }
}

/**
 * Strategy parameters
 */
export const STRATEGY_PARAMS = {
  // Precision values
  PRECISION: BigInt(10 ** 18),
  GMX_USD_PRECISION: BigInt(10 ** 30),
  Q96: BigInt(2) ** BigInt(96),

  // Strategy thresholds
  DELTA_THRESHOLD: BigInt(5) * BigInt(10 ** 16), // 5%
  EMERGENCY_THRESHOLD: BigInt(20) * BigInt(10 ** 16), // 20%
  MAX_LEVERAGE: BigInt(3) * BigInt(10 ** 18), // 3x
  MAX_SLIPPAGE: BigInt(1) * BigInt(10 ** 16), // 1%

  // Timing parameters
  MIN_REBALANCE_INTERVAL: 3600, // 1 hour
  MAX_REBALANCE_INTERVAL: 86400, // 24 hours
  MIN_COMPOUND_INTERVAL: 86400, // 24 hours

  // Token decimals
  USDC_DECIMALS: 6,
  WETH_DECIMALS: 18,
  CHAINLINK_DECIMALS: 8,
  GMX_PRICE_DECIMALS: 12,
};
