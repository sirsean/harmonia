import { ethers } from "hardhat";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
  const [asset, name, symbol, vaultDecimals] = await Promise.all([
    vault.asset(),
    vault.name(),
    vault.symbol(),
    vault.decimals(),
  ]);
  const hedgeManagerAddress = await vault.hedgeManager();
  const hedgeManager = hedgeManagerAddress !== ethers.ZeroAddress
    ? await ethers.getContractAt("HedgeManager", hedgeManagerAddress)
    : null;
  const liquidityManagerAddress = await vault.liquidityManager();
  const liquidityManager = liquidityManagerAddress !== ethers.ZeroAddress
    ? await ethers.getContractAt("LiquidityManager", liquidityManagerAddress)
    : null;

  const baseToken = liquidityManager ? await liquidityManager.baseToken() : ethers.ZeroAddress;
  const quoteToken = liquidityManager ? await liquidityManager.quoteToken() : ethers.ZeroAddress;

  const [paused, cap, totalAssets, breakerEnabled, breakerTriggered, rc, ethBalance, rangeWidthMultiplier] =
    await Promise.all([
      vault.paused(),
      vault.depositCap(),
      vault.totalAssets(),
      vault.circuitBreakerEnabled(),
      vault.circuitBreakerTriggered(),
      vault.rebalanceController(),
      ethers.provider.getBalance(vaultAddress),
      vault.rangeWidthMultiplier(),
    ]);

  const execFee = hedgeManager ? await hedgeManager.getExecutionFee() : 0n;
  const collateralToken = hedgeManager ? await hedgeManager.collateralToken() : ethers.ZeroAddress;
  const collateralAllowance = collateralToken !== ethers.ZeroAddress
    ? await (await ethers.getContractAt("IERC20", collateralToken)).allowance(vaultAddress, hedgeManagerAddress)
    : 0n;
  const baseAllowance = baseToken !== ethers.ZeroAddress
    ? await (await ethers.getContractAt("IERC20", baseToken)).allowance(vaultAddress, liquidityManagerAddress)
    : 0n;
  const quoteAllowance = quoteToken !== ethers.ZeroAddress
    ? await (await ethers.getContractAt("IERC20", quoteToken)).allowance(vaultAddress, liquidityManagerAddress)
    : 0n;
  const swapRouter = liquidityManager ? await liquidityManager.swapRouter() : ethers.ZeroAddress;
  const positionManager = liquidityManager ? await liquidityManager.positionManager() : ethers.ZeroAddress;
  const quoteToRouterAllowance = quoteToken !== ethers.ZeroAddress && swapRouter !== ethers.ZeroAddress
    ? await (await ethers.getContractAt("IERC20", quoteToken)).allowance(vaultAddress, swapRouter)
    : 0n;
  const baseToRouterAllowance = baseToken !== ethers.ZeroAddress && swapRouter !== ethers.ZeroAddress
    ? await (await ethers.getContractAt("IERC20", baseToken)).allowance(vaultAddress, swapRouter)
    : 0n;
  const quoteToPMAllowance = quoteToken !== ethers.ZeroAddress && positionManager !== ethers.ZeroAddress
    ? await (await ethers.getContractAt("IERC20", quoteToken)).allowance(vaultAddress, positionManager)
    : 0n;
  const baseToPMAllowance = baseToken !== ethers.ZeroAddress && positionManager !== ethers.ZeroAddress
    ? await (await ethers.getContractAt("IERC20", baseToken)).allowance(vaultAddress, positionManager)
    : 0n;

  console.log({
    vault: vaultAddress,
    asset,
    name,
    symbol,
    vaultDecimals: vaultDecimals.toString(),
    paused,
    depositCap: cap.toString(),
    totalAssets: totalAssets.toString(),
    circuitBreakerEnabled: breakerEnabled,
    circuitBreakerTriggered: breakerTriggered,
    liquidityManager: liquidityManagerAddress,
    hedgeManager: hedgeManagerAddress,
    rebalanceController: rc,
    vaultEthBalance: ethBalance.toString(),
    hedgeExecutionFee: execFee.toString(),
    rangeWidthMultiplier: rangeWidthMultiplier.toString(),
    baseToken,
    quoteToken,
    baseAllowance: baseAllowance.toString(),
    quoteAllowance: quoteAllowance.toString(),
    swapRouter,
    positionManager,
    quoteToRouterAllowance: quoteToRouterAllowance.toString(),
    baseToRouterAllowance: baseToRouterAllowance.toString(),
    quoteToPMAllowance: quoteToPMAllowance.toString(),
    baseToPMAllowance: baseToPMAllowance.toString(),
    collateralToken,
    collateralAllowance: collateralAllowance.toString(),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
