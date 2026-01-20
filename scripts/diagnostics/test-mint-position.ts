import { ethers, network } from "hardhat";
import { ARBITRUM_TOKENS } from "../../src/markets/registry";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const depositor = process.env.DEPOSITOR || "0x560EBafD8dB62cbdB44B50539d65b48072b98277";
  const rawAmount = process.env.DEPOSIT_AMOUNT || "600";
  const amount = ethers.parseUnits(rawAmount, ARBITRUM_TOKENS.USDC.decimals);

  // Mine a block to move off fork block.
  await network.provider.send("hardhat_mine", ["0x1"]);

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [depositor],
  });
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [vaultAddress],
  });
  await network.provider.send("hardhat_setBalance", [depositor, "0x56BC75E2D63100000"]);
  await network.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);

  const depositorSigner = await ethers.getSigner(depositor);
  const vaultSigner = await ethers.getSigner(vaultAddress);

  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress);
  const lmAddress = await vault.liquidityManager();
  const lm = await ethers.getContractAt("LiquidityManager", lmAddress, vaultSigner);

  const usdc = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.USDC.address, depositorSigner);

  console.log("Transfer USDC to vault...");
  const tx = await usdc.transfer(vaultAddress, amount);
  await tx.wait();

  const [tickLower, tickUpper] = await lm.getRebalanceTicks(20);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  console.log("Tracing mintPosition...");
  const data = lm.interface.encodeFunctionData("mintPosition", [
    tickLower,
    tickUpper,
    0,
    amount,
    deadline,
  ]);
  const txRequest = {
    from: vaultAddress,
    to: lmAddress,
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
  const logs = trace?.structLogs as Array<{ op: string; pc: number; depth: number; stack?: string[]; memory?: string[] }> | undefined;
  if (logs) {
    const lastRevertIndex = [...logs].reverse().findIndex((l) => l.op === "REVERT" || l.op === "INVALID");
    if (lastRevertIndex !== -1) {
      const idx = logs.length - 1 - lastRevertIndex;
      const entry = logs[idx];
      console.log("Last REVERT/INVALID op:", entry);
      if (entry.op === "REVERT" && entry.stack && entry.memory) {
        const bytes = Buffer.concat(entry.memory.map((w) => Buffer.from(w, "hex")));
        const offset = BigInt("0x" + entry.stack[0]);
        const size = BigInt("0x" + entry.stack[1]);
        const slice = bytes.subarray(Number(offset), Number(offset + size));
        console.log("Revert data (derived):", "0x" + slice.toString("hex"));
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
