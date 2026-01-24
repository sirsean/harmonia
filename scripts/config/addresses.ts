/**
 * Network-specific contract addresses for Harmonia
 *
 * @deprecated This file is kept for backward compatibility.
 * Please use the new configuration system from src/config/ instead.
 *
 * This file re-exports from the centralized config module.
 */

// Re-export addresses from the new config module
export {
  NetworkAddresses,
  ARBITRUM_MAINNET,
  getNetworkAddresses,
} from "../../src/config/addresses";

// Re-export strategy params for backward compatibility
import { PRECISION, DECIMALS, DEFAULT_STRATEGY_CONFIG } from "../../src/config/strategy";

/**
 * Strategy parameters (backward compatibility)
 * @deprecated Use StrategyConfig from src/config/strategy instead
 */
export const STRATEGY_PARAMS = {
  // Precision values
  PRECISION: PRECISION.STANDARD,
  GMX_USD_PRECISION: PRECISION.GMX_USD,
  Q96: PRECISION.Q96,

  // Strategy thresholds (converted from decimal to bigint for backward compatibility)
  DELTA_THRESHOLD: BigInt(Math.floor(DEFAULT_STRATEGY_CONFIG.deltaThreshold * 1e18)),
  EMERGENCY_THRESHOLD: BigInt(Math.floor(DEFAULT_STRATEGY_CONFIG.emergencyThreshold * 1e18)),
  MAX_LEVERAGE: BigInt(Math.floor(DEFAULT_STRATEGY_CONFIG.maxLeverage * 1e18)),
  MAX_SLIPPAGE: BigInt(Math.floor(DEFAULT_STRATEGY_CONFIG.maxSlippage * 1e18)),

  // Timing parameters
  MIN_REBALANCE_INTERVAL: DEFAULT_STRATEGY_CONFIG.minRebalanceInterval,
  MAX_REBALANCE_INTERVAL: DEFAULT_STRATEGY_CONFIG.maxRebalanceInterval,
  MIN_COMPOUND_INTERVAL: DEFAULT_STRATEGY_CONFIG.minCompoundInterval,

  // Token decimals
  USDC_DECIMALS: DECIMALS.USDC,
  WETH_DECIMALS: DECIMALS.WETH,
  CHAINLINK_DECIMALS: DECIMALS.CHAINLINK,
  GMX_PRICE_DECIMALS: DECIMALS.GMX_PRICE,
};
