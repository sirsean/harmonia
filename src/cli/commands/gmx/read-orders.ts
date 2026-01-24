import { ethers } from "hardhat";
import { ARBITRUM_MAINNET } from "../../../config/addresses";
import { getSignerAndAccount } from "../base";

// Lazy load deployment files to handle missing files gracefully
function getReaderDeployment() {
  try {
    // @ts-ignore - deployment file may not exist
    return require("../../../../deployments/Reader.arbitrum.json");
  } catch {
    throw new Error(
      "Reader deployment file not found. Please ensure deployments/Reader.arbitrum.json exists."
    );
  }
}

export interface GmxReadOrdersOptions {
  account?: string;
  start?: number;
  end?: number;
}

export async function gmxReadOrders(options: GmxReadOrdersOptions = {}): Promise<void> {
  const { account } = await getSignerAndAccount(options.account);
  const start = options.start ?? 0;
  const end = options.end ?? 10;

  const readerDeployment = getReaderDeployment();
  const reader = new ethers.Contract(
    readerDeployment.address,
    readerDeployment.abi,
    ethers.provider
  );
  const orders = await reader.getAccountOrders(ARBITRUM_MAINNET.gmxDataStore, account, start, end);

  console.log("Reader:", readerDeployment.address);
  console.log("Account:", account);
  console.log(`Range: ${start}..${end}`);
  console.log("Orders:", orders.length);

  for (const info of orders) {
    const order = info.order;
    const numbers = order.numbers;
    const flags = order.flags;
    const addresses = order.addresses;

    const sizeUsd = ethers.formatUnits(numbers.sizeDeltaUsd, 30);
    const acceptablePrice = ethers.formatUnits(numbers.acceptablePrice, 30);
    const triggerPrice = ethers.formatUnits(numbers.triggerPrice, 30);

    console.log("\nOrder Key:", info.orderKey);
    console.log("  Market:", addresses.market);
    console.log("  Collateral:", addresses.initialCollateralToken);
    console.log("  Size (USD):", sizeUsd);
    console.log("  Acceptable Price:", acceptablePrice);
    console.log("  Trigger Price:", triggerPrice);
    console.log("  Order Type:", numbers.orderType?.toString?.() || order.orderType?.toString?.());
    console.log("  Is Long:", flags.isLong);
    console.log("  Updated At:", numbers.updatedAtTime?.toString?.() || "0");
    console.log("  Valid From:", numbers.validFromTime?.toString?.() || "0");
  }
}
