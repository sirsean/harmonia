import { ethers, network } from "hardhat";
import { ARBITRUM_TOKENS } from "../../src/markets/registry";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const depositor = process.env.DEPOSITOR || "0x560EBafD8dB62cbdB44B50539d65b48072b98277";
  const rawAmount = process.env.AMOUNT || "600";
  const amount = ethers.parseUnits(rawAmount, ARBITRUM_TOKENS.USDC.decimals);

  await network.provider.send("hardhat_mine", ["0x1"]);
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [depositor] });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [vaultAddress] });
  await network.provider.send("hardhat_setBalance", [depositor, "0x56BC75E2D63100000"]);
  await network.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);

  const depositorSigner = await ethers.getSigner(depositor);
  const vaultSigner = await ethers.getSigner(vaultAddress);

  const usdc = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.USDC.address, depositorSigner);
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
  const lmAddress = await vault.liquidityManager();
  const lm = await ethers.getContractAt("LiquidityManager", lmAddress, vaultSigner);
  const router = await ethers.getContractAt("ISwapRouter", await lm.swapRouter(), vaultSigner);

  console.log("Transferring USDC to vault...");
  const transferTx = await usdc.transfer(vaultAddress, amount);
  await transferTx.wait();

  const swapAmount = amount / 2n;
  console.log("Swapping USDC to WETH via router...");
  const params = {
    tokenIn: ARBITRUM_TOKENS.USDC.address,
    tokenOut: ARBITRUM_TOKENS.WETH.address,
    fee: await lm.poolFee(),
    recipient: vaultAddress,
    deadline: Math.floor(Date.now() / 1000) + 600,
    amountIn: swapAmount,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  };
  await (await usdc.connect(vaultSigner).approve(await lm.swapRouter(), swapAmount)).wait();
  const swapTx = await router.exactInputSingle(params);
  await swapTx.wait();

  const weth = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.WETH.address, vaultSigner);
  const vaultUsdc = await usdc.connect(vaultSigner).balanceOf(vaultAddress);
  const vaultWeth = await weth.balanceOf(vaultAddress);
  console.log("Vault balances:", {
    usdc: ethers.formatUnits(vaultUsdc, ARBITRUM_TOKENS.USDC.decimals),
    weth: ethers.formatUnits(vaultWeth, ARBITRUM_TOKENS.WETH.decimals),
  });

  const [tickLower, tickUpper] = await lm.getRebalanceTicks(20);
  const baseToken = await lm.baseToken();
  const quoteToken = await lm.quoteToken();
  const [token0, token1] = baseToken.toLowerCase() < quoteToken.toLowerCase()
    ? [baseToken, quoteToken]
    : [quoteToken, baseToken];

  const collateralAmount = (amount * 30n) / 100n;
  const usableUsdc = vaultUsdc > collateralAmount ? vaultUsdc - collateralAmount : 0n;
  const amount0Desired = token0.toLowerCase() === baseToken.toLowerCase() ? vaultWeth : usableUsdc;
  const amount1Desired = token1.toLowerCase() === quoteToken.toLowerCase() ? usableUsdc : vaultWeth;

  console.log("Minting position with both sides...");
  const mintTx = await lm.mintPosition(tickLower, tickUpper, amount0Desired, amount1Desired, Math.floor(Date.now() / 1000) + 600);
  await mintTx.wait();
  console.log("Mint succeeded.");

  const hmAddress = await vault.hedgeManager();
  const hm = await ethers.getContractAt("HedgeManager", hmAddress, vaultSigner);
  const lpDelta = await lm.getPositionDelta(); // base units, 1e18
  const price = await lm.getOraclePrice(); // 18 decimals
  const baseDecimals = 18n;
  let hedgeTarget = 0n;
  if (lpDelta > 0) {
    const deltaAbs = BigInt(lpDelta.toString());
    // sizeUSD (30d) = deltaAbs * price * 1e12 / 1e18
    hedgeTarget = (deltaAbs * price * 10n ** 12n) / 10n ** baseDecimals;
  }
  const requiredCollateral = (hedgeTarget * 10n ** 18n) / (2n * 10n ** 18n) / 10n ** 24n;
  const vaultUsdcAfter = await usdc.connect(vaultSigner).balanceOf(vaultAddress);
  console.log("Post-mint hedging check:", {
    lpDelta: lpDelta.toString(),
    hedgeTarget: hedgeTarget.toString(),
    requiredCollateral: requiredCollateral.toString(),
    vaultUsdcAfter: vaultUsdcAfter.toString(),
  });

  console.log("Attempting adjustHedge on fork...");
  const execFee = await hm.getExecutionFee();
  try {
    const tx = await hm.adjustHedge(hedgeTarget, { value: execFee });
    console.log("adjustHedge tx:", tx.hash);
    await tx.wait();
    console.log("adjustHedge succeeded.");
  } catch (error) {
    console.error("adjustHedge failed:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
