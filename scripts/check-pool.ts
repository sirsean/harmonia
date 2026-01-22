import { ethers } from "hardhat";
import { ARBITRUM_TOKENS, ARBITRUM_PROTOCOLS } from "../src/markets/registry";

async function main() {
  const factoryAddr = ARBITRUM_PROTOCOLS.UNISWAP_V3_FACTORY;
  const factoryABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  ];

  const factory = new ethers.Contract(factoryAddr, factoryABI, ethers.provider);

  console.log("Checking Factory for WBTC/USDC pools...");

  const fees = [500, 3000, 10000];
  for (const fee of fees) {
    const poolAddr = await factory.getPool(
      ARBITRUM_TOKENS.WBTC.address,
      ARBITRUM_TOKENS.USDC.address,
      fee
    );
    console.log(`Fee ${fee} (0.0${fee / 100}%): ${poolAddr}`);

    if (poolAddr !== ethers.ZeroAddress) {
      const poolABI = ["function liquidity() view returns (uint128)"];
      const pool = new ethers.Contract(poolAddr, poolABI, ethers.provider);
      const liquidity = await pool.liquidity();
      console.log(`  Liquidity: ${liquidity}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
