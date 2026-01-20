import { ethers } from "hardhat";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);

  const [liquidityManagerAddress, hedgeManagerAddress] = await Promise.all([
    vault.liquidityManager(),
    vault.hedgeManager(),
  ]);

  console.log("Vault:", vaultAddress);
  console.log("LiquidityManager:", liquidityManagerAddress);
  console.log("HedgeManager:", hedgeManagerAddress);

  if (liquidityManagerAddress !== ethers.ZeroAddress) {
    const lm = await ethers.getContractAt("LiquidityManager", liquidityManagerAddress);
    const [
      pool,
      swapRouter,
      positionManager,
      priceFeed,
      tokenId,
      tickLower,
      tickUpper,
      liquidity,
      baseToken,
      quoteToken,
      poolFee,
      twapEnabled,
      twapPeriod,
      maxTwapDeviation,
      inRange,
      poolLiquidity,
      poolSlot0,
      poolTickSpacing,
      rebalanceTicks,
      lmVault,
    ] = await Promise.all([
      lm.getPool(),
      lm.swapRouter(),
      lm.positionManager(),
      lm.priceFeed(),
      lm.tokenId(),
      lm.tickLower(),
      lm.tickUpper(),
      lm.liquidity(),
      lm.baseToken(),
      lm.quoteToken(),
      lm.poolFee(),
      lm.twapValidationEnabled(),
      lm.twapPeriod(),
      lm.maxTwapDeviation(),
      lm.isInRange(),
      (await ethers.getContractAt("IUniswapV3Pool", await lm.getPool())).liquidity(),
      (await ethers.getContractAt("IUniswapV3Pool", await lm.getPool())).slot0(),
      (await ethers.getContractAt("IUniswapV3Pool", await lm.getPool())).tickSpacing(),
      lm.getRebalanceTicks(20),
      lm.vault(),
    ]);

    console.log("\nLiquidityManager config:");
    console.log({
      pool,
      poolLiquidity: poolLiquidity.toString(),
      poolSlot0,
      poolTickSpacing: poolTickSpacing.toString(),
      swapRouter,
      positionManager,
      priceFeed,
      tokenId: tokenId.toString(),
      tickLower: tickLower.toString(),
      tickUpper: tickUpper.toString(),
      liquidity: liquidity.toString(),
      baseToken,
      quoteToken,
      poolFee: poolFee.toString(),
      twapEnabled,
      twapPeriod: twapPeriod.toString(),
      maxTwapDeviation: maxTwapDeviation.toString(),
      inRange,
      rebalanceTicks,
      vault: lmVault,
    });
  }

  if (hedgeManagerAddress !== ethers.ZeroAddress) {
    const hm = await ethers.getContractAt("HedgeManager", hedgeManagerAddress);
    const [
      market,
      exchangeRouter,
      orderVault,
      collateralToken,
      priceFeed,
      maxOracleStaleness,
      minPositionSize,
      maxLeverage,
      slippageTolerance,
      executionFee,
      positionSizeUsd,
      collateralAmount,
    ] = await Promise.all([
      hm.market(),
      hm.exchangeRouter(),
      hm.orderVault(),
      hm.collateralToken(),
      hm.priceFeed(),
      hm.maxOracleStaleness(),
      hm.minPositionSize(),
      hm.maxLeverage(),
      hm.slippageTolerance(),
      hm.getExecutionFee(),
      hm.getPositionSizeUsd(),
      hm.getCollateralAmount(),
    ]);

    const collateralAllowance = await (await ethers.getContractAt("IERC20", collateralToken)).allowance(
      hedgeManagerAddress,
      exchangeRouter
    );

    const feed = await ethers.getContractAt("IChainlinkPriceFeed", priceFeed);
    const [roundData, latestBlock] = await Promise.all([
      feed.latestRoundData(),
      ethers.provider.getBlock("latest"),
    ]);
    const updatedAt = roundData[3] as bigint;
    const blockTs = BigInt(latestBlock?.timestamp || 0);

    console.log("\nHedgeManager config:");
    console.log({
      market,
      exchangeRouter,
      orderVault,
      collateralToken,
      priceFeed,
      maxOracleStaleness: maxOracleStaleness.toString(),
      minPositionSize: minPositionSize.toString(),
      maxLeverage: maxLeverage.toString(),
      slippageTolerance: slippageTolerance.toString(),
      executionFee: executionFee.toString(),
      oracleUpdatedAt: updatedAt.toString(),
      oracleAgeSeconds: (blockTs - updatedAt).toString(),
      positionSizeUsd: positionSizeUsd.toString(),
      collateralAmount: collateralAmount.toString(),
      collateralAllowance: collateralAllowance.toString(),
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
