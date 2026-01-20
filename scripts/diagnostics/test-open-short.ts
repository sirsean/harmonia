import { ethers, network } from "hardhat";
import { ARBITRUM_TOKENS } from "../../src/markets/registry";

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS || "0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6";
  const depositor = process.env.DEPOSITOR || "0x560EBafD8dB62cbdB44B50539d65b48072b98277";
  const sizeUsd = BigInt(process.env.SIZE_USD || "200"); // USD size
  const collateralUsd = BigInt(process.env.COLLATERAL_USD || "100"); // USD collateral

  const sizeDeltaUsd = sizeUsd * 10n ** 30n;
  const collateralAmount = collateralUsd * 10n ** 6n;

  await network.provider.send("hardhat_mine", ["0x1"]);
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [depositor] });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [vaultAddress] });
  await network.provider.send("hardhat_setBalance", [depositor, "0x56BC75E2D63100000"]);
  await network.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);

  const depositorSigner = await ethers.getSigner(depositor);
  const vaultSigner = await ethers.getSigner(vaultAddress);

  const usdc = await ethers.getContractAt("IERC20", ARBITRUM_TOKENS.USDC.address, depositorSigner);
  const hm = await ethers.getContractAt("HedgeManager", "0x9D81A634c269cf262192886B5cC678E00c9D96d8", vaultSigner);

  console.log("Funding vault with collateral...");
  const tx = await usdc.transfer(vaultAddress, collateralAmount);
  await tx.wait();

  const execFee = await hm.getExecutionFee();
  console.log("Calling openShort...", {
    sizeDeltaUsd: sizeDeltaUsd.toString(),
    collateralAmount: collateralAmount.toString(),
    execFee: execFee.toString(),
  });

  try {
    const openTx = await hm.openShort(sizeDeltaUsd, collateralAmount, { value: execFee });
    console.log("openShort tx:", openTx.hash);
    await openTx.wait();
    console.log("openShort succeeded.");
  } catch (error) {
    console.error("openShort failed:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
