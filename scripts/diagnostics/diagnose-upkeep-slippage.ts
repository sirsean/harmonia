import { ethers } from "hardhat";
import { sqrtPriceX96ToPrice } from "../../src/markets/types";

const DEFAULT_VAULT = "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
const PRECISION = 10n ** 18n;

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function toNumberSafe(value: bigint, decimals: number): number {
  return Number(ethers.formatUnits(value, decimals));
}

function scaleTo12(price: bigint, decimals: number): bigint {
  if (decimals === 12) return price;
  if (decimals < 12) {
    return price * 10n ** BigInt(12 - decimals);
  }
  return price / 10n ** BigInt(decimals - 12);
}

async function resolveAddresses() {
  const controllerEnv = process.env.REBALANCE_CONTROLLER || process.env.CONTROLLER_ADDRESS;
  const vaultEnv = process.env.VAULT_ADDRESS || process.env.VAULT;
  const vaultAddress = vaultEnv || DEFAULT_VAULT;

  if (controllerEnv) {
    return { vaultAddress, controllerAddress: controllerEnv };
  }

  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
  const controllerAddress = await vault.rebalanceController();
  return { vaultAddress, controllerAddress };
}

async function main() {
  const { controllerAddress } = await resolveAddresses();
  const controller = await ethers.getContractAt("RebalanceController", controllerAddress);
  const vaultAddress = await controller.vault();
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);

  const [liquidityManagerAddress, hedgeManagerAddress] = await Promise.all([
    vault.liquidityManager(),
    vault.hedgeManager(),
  ]);

  if (liquidityManagerAddress === ethers.ZeroAddress || hedgeManagerAddress === ethers.ZeroAddress) {
    console.log("Missing manager address.");
    console.log("LiquidityManager:", liquidityManagerAddress);
    console.log("HedgeManager:", hedgeManagerAddress);
    return;
  }

  const lm = await ethers.getContractAt("LiquidityManager", liquidityManagerAddress);
  const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);

  const [lpDelta, oraclePrice18, baseToken, poolAddress] = await Promise.all([
    lm.getPositionDelta(),
    lm.getOraclePrice(),
    lm.baseToken(),
    lm.getPool(),
  ]);

  const baseDecimals = Number(
    await (await ethers.getContractAt("IERC20Metadata", baseToken)).decimals()
  );
  const deltaAbs = lpDelta >= 0n ? lpDelta : -lpDelta;

  let targetHedgeUsd = 0n;
  if (lpDelta > 0n) {
    if (baseDecimals <= 12) {
      targetHedgeUsd = deltaAbs * oraclePrice18 * 10n ** BigInt(12 - baseDecimals);
    } else {
      targetHedgeUsd = (deltaAbs * oraclePrice18) / 10n ** BigInt(baseDecimals - 12);
    }
  }

  const currentHedgeUsd = await hm.getPositionSizeUsd();

  const action =
    targetHedgeUsd > currentHedgeUsd
      ? "increase"
      : targetHedgeUsd < currentHedgeUsd
      ? "decrease"
      : "none";

  const [priceFeed, maxOracleStaleness, slippageTolerance] = await Promise.all([
    hm.priceFeed(),
    hm.maxOracleStaleness(),
    hm.slippageTolerance(),
  ]);

  const feed = await ethers.getContractAt("IChainlinkPriceFeed", priceFeed);
  const [feedDecimalsRaw, roundData, latestBlock] = await Promise.all([
    feed.decimals(),
    feed.latestRoundData(),
    ethers.provider.getBlock("latest"),
  ]);
  const feedDecimals = Number(feedDecimalsRaw);
  const answer = BigInt(roundData[1]);
  const updatedAt = BigInt(roundData[3]);
  const blockTs = BigInt(latestBlock?.timestamp ?? 0);

  const price12 = scaleTo12(answer, feedDecimals);
  let acceptablePrice = price12;
  if (action === "increase") {
    acceptablePrice = (price12 * (PRECISION - slippageTolerance)) / PRECISION;
  } else if (action === "decrease") {
    acceptablePrice = (price12 * (PRECISION + slippageTolerance)) / PRECISION;
  }

  const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddress);
  const [token0, token1, slot0] = await Promise.all([pool.token0(), pool.token1(), pool.slot0()]);
  const token0Decimals = Number(
    await (await ethers.getContractAt("IERC20Metadata", token0)).decimals()
  );
  const token1Decimals = Number(
    await (await ethers.getContractAt("IERC20Metadata", token1)).decimals()
  );
  const baseIsToken0 = baseToken.toLowerCase() === token0.toLowerCase();
  const uniswapPrice = sqrtPriceX96ToPrice(
    slot0[0],
    token0Decimals,
    token1Decimals,
    baseIsToken0
  );
  const chainlinkPrice = toNumberSafe(answer, feedDecimals);
  const priceDeviation =
    Math.abs(chainlinkPrice - uniswapPrice) / ((chainlinkPrice + uniswapPrice) / 2);

  console.log("=== Upkeep Slippage Diagnostics ===");
  console.log("Controller:", controllerAddress);
  console.log("Vault:", vaultAddress);
  console.log("LiquidityManager:", liquidityManagerAddress);
  console.log("HedgeManager:", hedgeManagerAddress);
  console.log("");
  console.log("LP delta:", lpDelta.toString());
  console.log("Oracle price (LM, 18d):", ethers.formatUnits(oraclePrice18, 18));
  console.log("Target hedge USD (30d):", targetHedgeUsd.toString());
  console.log("Current hedge USD (30d):", currentHedgeUsd.toString());
  console.log("Action:", action);
  console.log("");
  console.log("Chainlink price:", chainlinkPrice.toFixed(4), "(feed decimals:", feedDecimals, ")");
  console.log("Chainlink price (12d):", ethers.formatUnits(price12, 12));
  console.log("Slippage tolerance:", ethers.formatUnits(slippageTolerance, 16), "%");
  console.log("Acceptable price (12d):", ethers.formatUnits(acceptablePrice, 12));
  console.log("Oracle updated at:", updatedAt.toString());
  console.log("Oracle age (sec):", (blockTs - updatedAt).toString());
  console.log("Max oracle staleness (sec):", maxOracleStaleness.toString());
  console.log("");
  console.log("Uniswap price:", uniswapPrice.toFixed(4));
  console.log("Chainlink vs Uniswap deviation:", formatPercent(priceDeviation));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
