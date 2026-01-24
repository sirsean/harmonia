/**
 * Configuration System Module
 *
 * Main entry point for configuration management. Provides a unified interface
 * for loading, validating, and accessing all configuration parameters.
 */

import { ethers } from "ethers";
import { NetworkAddresses, getNetworkAddresses } from "./addresses";
import {
  StrategyConfig,
  loadStrategyConfig,
  validateStrategyConfig,
  DEFAULT_STRATEGY_CONFIG,
} from "./strategy";
import { MarketConfig, getMarketConfig } from "./markets";

/**
 * Complete application configuration
 */
export interface AppConfig {
  /** Network addresses */
  addresses: NetworkAddresses;
  /** Strategy parameters */
  strategy: StrategyConfig;
  /** Market configuration */
  market: MarketConfig;
  /** Network chain ID */
  chainId: number;
}

/**
 * Configuration loading options
 */
export interface ConfigOptions {
  /** Network chain ID (defaults to 42161 for Arbitrum) */
  chainId?: number;
  /** Strategy configuration overrides */
  strategyOverrides?: Partial<StrategyConfig>;
  /** Provider for network detection (optional) */
  provider?: ethers.Provider;
}

/**
 * Load complete application configuration
 *
 * @param options Configuration loading options
 * @returns Validated application configuration
 * @throws Error if configuration is invalid
 */
export async function loadConfig(options: ConfigOptions = {}): Promise<AppConfig> {
  let chainId = options.chainId;

  // Auto-detect chain ID from provider if not provided
  if (!chainId && options.provider) {
    const network = await options.provider.getNetwork();
    chainId = Number(network.chainId);
  }

  // Default to Arbitrum mainnet
  chainId = chainId || 42161;

  // Load network addresses
  const addresses = getNetworkAddresses(chainId);

  // Load strategy configuration
  const strategy = loadStrategyConfig(options.strategyOverrides);

  // Validate strategy configuration
  validateStrategyConfig(strategy);

  // Load market configuration
  const market = getMarketConfig(addresses);

  return {
    addresses,
    strategy,
    market,
    chainId,
  };
}

/**
 * Load configuration synchronously (without provider)
 *
 * @param chainId Network chain ID (defaults to 42161)
 * @param strategyOverrides Optional strategy configuration overrides
 * @returns Validated application configuration
 * @throws Error if configuration is invalid
 */
export function loadConfigSync(
  chainId: number = 42161,
  strategyOverrides?: Partial<StrategyConfig>
): AppConfig {
  const addresses = getNetworkAddresses(chainId);
  const strategy = loadStrategyConfig(strategyOverrides);
  validateStrategyConfig(strategy);
  const market = getMarketConfig(addresses);

  return {
    addresses,
    strategy,
    market,
    chainId,
  };
}

// Re-export types and utilities for convenience
export * from "./addresses";
export * from "./strategy";
export * from "./markets";

// Re-export default configs for backward compatibility
export { DEFAULT_STRATEGY_CONFIG };
