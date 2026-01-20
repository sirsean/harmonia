import { ethers, network } from "hardhat";
import { ARBITRUM_TOKENS } from "../../src/markets/registry";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const depositor = process.env.DEPOSITOR || "0x560EBafD8dB62cbdB44B50539d65b48072b98277";
  const rawAmount = process.env.DEPOSIT_AMOUNT || "600";
  const decimals = ARBITRUM_TOKENS.USDC.decimals;
  const amount = ethers.parseUnits(rawAmount, decimals);
  const usdcAddress = ARBITRUM_TOKENS.USDC.address;

  // Mine a block to move off the fork block (avoids hardfork history issues).
  await network.provider.send("hardhat_mine", ["0x1"]);

  // Impersonate depositor on fork
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [depositor],
  });
  await network.provider.send("hardhat_setBalance", [
    depositor,
    "0x56BC75E2D63100000", // 100 ETH
  ]);

  const signer = await ethers.getSigner(depositor);
  const usdc = await ethers.getContractAt("IERC20", usdcAddress, signer);
  const vault = await ethers.getContractAt("DeltaNeutralVault", vaultAddress, signer);

  const balance = await usdc.balanceOf(depositor);
  const allowance = await usdc.allowance(depositor, vaultAddress);

  console.log("Depositor:", depositor);
  console.log("USDC balance:", ethers.formatUnits(balance, decimals));
  console.log("Allowance:", ethers.formatUnits(allowance, decimals));

  if (balance < amount) {
    throw new Error("Insufficient USDC balance on fork for trace.");
  }

  if (allowance < amount) {
    console.log("Approving vault for USDC...");
    const approveTx = await usdc.approve(vaultAddress, amount);
    await approveTx.wait();
  }

  const data = vault.interface.encodeFunctionData("deposit", [amount, depositor]);
  const txRequest = {
    from: depositor,
    to: vaultAddress,
    data,
    gas: "0x7A1200", // 8,000,000
    value: "0x0",
  };

  const useCallTracer = process.env.CALL_TRACER === "true";
  const trace = await network.provider.send("debug_traceCall", [
    txRequest,
    "latest",
    useCallTracer
      ? { tracer: "callTracer" }
      : { disableStorage: true, disableStack: false, enableMemory: false },
  ]);

  console.log("Trace error:", trace?.error);
  if (trace?.returnValue) {
    console.log("Return value:", trace.returnValue);
  }
  if (useCallTracer) {
    console.log("Call trace:", JSON.stringify(trace, null, 2));
    return;
  }

  const logs = trace?.structLogs as Array<{ op: string; pc: number; depth: number; stack?: string[] }> | undefined;
  if (logs && logs.length > 0) {
    const last = logs[logs.length - 1];
    const lastRevertIndex = [...logs].reverse().findIndex((l) => l.op === "REVERT" || l.op === "INVALID");
    if (lastRevertIndex !== -1) {
      const idx = logs.length - 1 - lastRevertIndex;
      const entry = logs[idx];
      console.log("Last REVERT/INVALID op:", entry);
      if (entry.op === "REVERT" && entry.stack && (entry as any).memory) {
        const mem = (entry as any).memory as string[];
        const bytes = Buffer.concat(mem.map((w) => Buffer.from(w, "hex")));
        const offsetFirst = BigInt("0x" + entry.stack[0]);
        const sizeFirst = BigInt("0x" + entry.stack[1]);
        const sliceFirst = bytes.subarray(Number(offsetFirst), Number(offsetFirst + sizeFirst));
        console.log("Revert data (stack[0..1]):", "0x" + sliceFirst.toString("hex"));

        const offsetLast = BigInt("0x" + entry.stack[entry.stack.length - 1]);
        const sizeLast = BigInt("0x" + entry.stack[entry.stack.length - 2]);
        const sliceLast = bytes.subarray(Number(offsetLast), Number(offsetLast + sizeLast));
        console.log("Revert data (stack[last]):", "0x" + sliceLast.toString("hex"));
      }
      const slice = logs.slice(Math.max(0, idx - 5), idx + 5);
      console.log("Trace tail:", slice);

      // Try to identify the last CALL before the revert.
      const callOps = new Set(["CALL", "DELEGATECALL", "STATICCALL", "CALLCODE"]);
      for (let i = idx; i >= 0; i--) {
        const op = logs[i];
        if (callOps.has(op.op) && op.stack) {
          const stack = op.stack;
          const toTopFirst = stack.length > 1 ? stack[1] : undefined;
          const toTopLast = stack.length > 2 ? stack[stack.length - 2] : undefined;
          const fmt = (v?: string) =>
            v ? "0x" + v.slice(-40) : undefined;
          console.log("Last CALL op:", op.op, "to candidates:", fmt(toTopFirst), fmt(toTopLast));
          break;
        }
      }
    } else {
      console.log("Trace last op:", last);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
