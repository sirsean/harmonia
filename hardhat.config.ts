import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "dotenv/config";

// Arbitrum contract addresses for reference
export const ARBITRUM_ADDRESSES = {
  // Uniswap v3
  UNISWAP_V3_FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  UNISWAP_V3_POSITION_MANAGER: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  UNISWAP_V3_SWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_V3_WETH_USDC_005_POOL: "0xC6962004f452bE9203591991D15f6b388e09E8D0",

  // GMX v2
  GMX_EXCHANGE_ROUTER: "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8",
  GMX_ORDER_VAULT: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  GMX_DATA_STORE: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
  GMX_ETH_USD_MARKET: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",

  // Chainlink
  CHAINLINK_ETH_USD_FEED: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  CHAINLINK_AUTOMATION_REGISTRY: "0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1",

  // Tokens
  USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Native USDC
  USDC_E: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // Bridged USDC.e (used in older pools)
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};

// Historical blocks for testing different market scenarios
export const HISTORICAL_BLOCKS = {
  // Block with typical market conditions - recent
  STABLE_MARKET: 420607090,
  // Block during high volatility period
  HIGH_VOLATILITY: 400000000,
  // Default block for testing - recent block
  RECENT: 420607090,
};

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";

// Default fork block - can be overridden via env var
const FORK_BLOCK_NUMBER = process.env.FORK_BLOCK_NUMBER
  ? parseInt(process.env.FORK_BLOCK_NUMBER)
  : HISTORICAL_BLOCKS.RECENT;

// Test scope - defaults to 'test' if not specified
const testDir = process.env.TEST_SCOPE || "test";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      {
        version: "0.8.19",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    ],
  },
  paths: {
    tests: `./${testDir}`,
  },
  networks: {
    hardhat: {
      // Force hardfork to bypass Ethereum mainnet block number lookup
      // (Arbitrum has much higher block numbers than Ethereum mainnet)
      hardfork: "shanghai",
      forking: ALCHEMY_API_KEY ? {
        url: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
        blockNumber: FORK_BLOCK_NUMBER,
      } : undefined,
      chainId: 42161,
      accounts: {
        count: 10,
        accountsBalance: "10000000000000000000000", // 10000 ETH
      },
    },
    arbitrum: {
      url: ALCHEMY_API_KEY
        ? `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
        : "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      accounts: PRIVATE_KEY !== "0x0000000000000000000000000000000000000000000000000000000000000001"
        ? [PRIVATE_KEY]
        : [],
    },
    arbitrumSepolia: {
      url: ALCHEMY_API_KEY
        ? `https://arb-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
        : "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts: PRIVATE_KEY !== "0x0000000000000000000000000000000000000000000000000000000000000001"
        ? [PRIVATE_KEY]
        : [],
    },
  },
  etherscan: {
    apiKey: process.env.ARBISCAN_API_KEY || "",
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },
  mocha: {
    timeout: 120000, // 2 minutes for fork tests
  },
};

export default config;
