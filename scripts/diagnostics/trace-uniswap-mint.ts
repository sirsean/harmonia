import { ethers, network } from "hardhat";
import { ARBITRUM_TOKENS } from "../../src/markets/registry";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const lmAddress = process.env.LIQUIDITY_MANAGER || "0x0aa77E5CE038c878A5d2704A6C18b53cD7d855De";
  const depositor = process.env.DEPOSITOR || "0x560EBafD8dB62cbdB44B50539d65b48072b98277";
  const rawAmount = process.env.AMOUNT || "600";
  const amount = ethers.parseUnits(rawAmount, ARBITRUM_TOKENS.USDC.decimals);

  await network.provider.send("hardhat_mine", ["0x1"]);
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [depositor] });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [lmAddress] });
  await network.provider.send("hardhat_setBalance", [depositor, "0x56BC75E2D63100000"]);
  await network.provider.send("hardhat_setBalance", [lmAddress, "0x56BC75E2D63100000"]);

  const depositorSigner = await ethers.getSigner(depositor);
  const lm = await ethers.getContractAt("LiquidityManager", lmAddress);
  const pmAddress = await lm.positionManager();
  const pm = await ethers.getContractAt("INonfungiblePositionManager", pmAddress);
  const usdc = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.USDC.address, depositorSigner);

  console.log("Transferring USDC to LM (via vault then transferFrom)...");
  const transferTx = await usdc.transfer(vaultAddress, amount);
  await transferTx.wait();

  // Move USDC from vault to LM to ensure balance
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [vaultAddress] });
  await network.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
  const lmSigner = await ethers.getSigner(lmAddress);
  const usdcFromLm = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.USDC.address, lmSigner);
  await usdcFromLm.transferFrom(vaultAddress, lmAddress, amount);

  const [tickLower, tickUpper] = await lm.getRebalanceTicks(20);
  const baseToken = await lm.baseToken();
  const quoteToken = await lm.quoteToken();
  const [token0, token1] = baseToken.toLowerCase() < quoteToken.toLowerCase()
    ? [baseToken, quoteToken]
    : [quoteToken, baseToken];
  const fee = await lm.poolFee();
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const params = {
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired: token0.toLowerCase() === quoteToken.toLowerCase() ? amount : 0,
    amount1Desired: token1.toLowerCase() === quoteToken.toLowerCase() ? amount : 0,
    amount0Min: 0,
    amount1Min: 0,
    recipient: lmAddress,
    deadline,
  };

  const data = pm.interface.encodeFunctionData("mint", [params]);
  const txRequest = {
    from: lmAddress,
    to: pmAddress,
    data,
    gas: "0x7A1200",
    value: "0x0",
  };

  const trace = await network.provider.send("debug_traceCall", [
    txRequest,
    "latest",
    { disableStorage: true, disableStack: false, enableMemory: false },
  ]);
  console.log("Trace error:", trace?.error);
  const logs = trace?.structLogs as Array<{ op: string; stack?: string[]; memory?: string[] }> | undefined;
  if (logs) {
    const lastRevertIndex = [...logs].reverse().findIndex((l) => l.op === "REVERT" || l.op === "INVALID");
    if (lastRevertIndex !== -1) {
      const idx = logs.length - 1 - lastRevertIndex;
      const entry = logs[idx];
      console.log("Last REVERT/INVALID op:", entry);
      if (entry.op === "REVERT" && entry.stack && entry.memory) {
        const bytes = Buffer.concat(entry.memory.map((w) => Buffer.from(w, "hex")));
        const offsetFirst = BigInt("0x" + entry.stack[0]);
        const sizeFirst = BigInt("0x" + entry.stack[1]);
        const sliceFirst = bytes.subarray(Number(offsetFirst), Number(offsetFirst + sizeFirst));
        console.log("Revert data (stack[0..1]):", "0x" + sliceFirst.toString("hex"));
        const offsetLast = BigInt("0x" + entry.stack[entry.stack.length - 1]);
        const sizeLast = BigInt("0x" + entry.stack[entry.stack.length - 2]);
        const sliceLast = bytes.subarray(Number(offsetLast), Number(offsetLast + sizeLast));
        console.log("Revert data (stack[last]):", "0x" + sliceLast.toString("hex"));
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
