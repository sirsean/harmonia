import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "dotenv/config";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";

const config: HardhatUserConfig = {
  // Minimal solidity config - we don't compile contracts but hardhat needs this
  solidity: "0.8.24",
  networks: {
    hardhat: {
      forking: ALCHEMY_API_KEY
        ? {
            url: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
          }
        : undefined,
      chainId: 42161,
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
  },
};

export default config;
