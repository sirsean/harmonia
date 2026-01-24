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

function getEventEmitterDeployment() {
  try {
    // @ts-ignore - deployment file may not exist
    return require("../../../../deployments/EventEmitter.arbitrum.json");
  } catch {
    throw new Error(
      "EventEmitter deployment file not found. Please ensure deployments/EventEmitter.arbitrum.json exists."
    );
  }
}

type EventLogData = {
  addressItems?: { items: Array<{ key: string; value: string }> };
  uintItems?: { items: Array<{ key: string; value: bigint }> };
  intItems?: { items: Array<{ key: string; value: bigint }> };
  boolItems?: { items: Array<{ key: string; value: boolean }> };
  bytes32Items?: { items: Array<{ key: string; value: string }> };
};

export interface GmxReadOrderOptions {
  account?: string;
  orderKey: string;
  txHash?: string;
}

export async function gmxReadOrder(options: GmxReadOrderOptions): Promise<void> {
  await getSignerAndAccount(options.account); // Ensure we have a provider

  let resolvedOrderKey = options.orderKey;

  if (!resolvedOrderKey && options.txHash) {
    resolvedOrderKey = await findOrderKeyFromTx(options.txHash);
  }

  if (!resolvedOrderKey) {
    throw new Error("Provide orderKey or txHash.");
  }

  if (options.txHash) {
    await printEventLogsFromTx(options.txHash);
  }

  const readerDeployment = getReaderDeployment();
  const reader = new ethers.Contract(
    readerDeployment.address,
    readerDeployment.abi,
    ethers.provider
  );
  const order = await reader.getOrder(ARBITRUM_MAINNET.gmxDataStore, resolvedOrderKey);

  const numbers = order.numbers;
  const flags = order.flags;
  const addresses = order.addresses;

  console.log("Order Key:", resolvedOrderKey);
  console.log("Market:", addresses.market);
  console.log("Collateral:", addresses.initialCollateralToken);
  console.log("Size (USD):", ethers.formatUnits(numbers.sizeDeltaUsd, 30));
  console.log("Acceptable Price:", ethers.formatUnits(numbers.acceptablePrice, 30));
  console.log("Trigger Price:", ethers.formatUnits(numbers.triggerPrice, 30));
  console.log("Execution Fee (ETH):", ethers.formatEther(numbers.executionFee));
  console.log("Order Type:", numbers.orderType.toString());
  console.log("Is Long:", flags.isLong);
  console.log("Updated At:", numbers.updatedAtTime.toString());
  console.log("Valid From:", numbers.validFromTime.toString());
}

async function findOrderKeyFromTx(txHash: string): Promise<string> {
  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error("No receipt for tx: " + txHash);
  }

  const eventEmitterDeployment = getEventEmitterDeployment();
  const emitterAddr = eventEmitterDeployment.address.toLowerCase();
  const iface = new ethers.Interface(eventEmitterDeployment.abi);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== emitterAddr) continue;
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }

    if (!parsed) continue;

    const eventName = parsed.args.eventName as string;
    if (eventName !== "OrderCreated") continue;

    const eventData = parsed.args.eventData as EventLogData;
    const bytes32Items = eventData?.bytes32Items?.items || [];
    const uintItems = eventData?.uintItems?.items || [];

    if (uintItems.length > 0) {
      const map = new Map(uintItems.map((item) => [item.key, item.value]));
      const acceptable = map.get("acceptablePrice");
      const trigger = map.get("triggerPrice");
      const size = map.get("sizeDeltaUsd");
      const execFee = map.get("executionFee");

      if (acceptable)
        console.log("OrderCreated acceptablePrice:", ethers.formatUnits(acceptable, 30));
      if (trigger) console.log("OrderCreated triggerPrice:", ethers.formatUnits(trigger, 30));
      if (size) console.log("OrderCreated sizeDeltaUsd:", ethers.formatUnits(size, 30));
      if (execFee) console.log("OrderCreated executionFee (ETH):", ethers.formatEther(execFee));
    }

    for (const item of bytes32Items) {
      if (item.key === "orderKey" || item.key === "key") {
        return item.value;
      }
    }
  }

  throw new Error("OrderCreated event not found for tx: " + txHash);
}

async function printEventLogsFromTx(txHash: string): Promise<void> {
  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error("No receipt for tx: " + txHash);
  }

  const eventEmitterDeployment = getEventEmitterDeployment();
  const emitterAddr = eventEmitterDeployment.address.toLowerCase();
  const iface = new ethers.Interface(eventEmitterDeployment.abi);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== emitterAddr) continue;
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }

    if (!parsed) continue;

    const eventName = parsed.args.eventName as string;
    const eventData = parsed.args.eventData as EventLogData;
    console.log("\nEvent:", eventName);
    printItems("address", eventData?.addressItems?.items || []);
    printItems("uint", eventData?.uintItems?.items || []);
    printItems("int", eventData?.intItems?.items || []);
    printItems("bool", eventData?.boolItems?.items || []);
    printItems("bytes32", eventData?.bytes32Items?.items || []);
  }
}

function printItems(kind: string, items: Array<{ key: string; value: any }>) {
  if (items.length === 0) return;
  console.log(`${kind} items:`);
  for (const item of items) {
    let value = item.value;
    if (kind === "uint") {
      const key = item.key;
      if (key.toLowerCase().includes("price") || key.toLowerCase().includes("usd")) {
        try {
          value = `${ethers.formatUnits(item.value as bigint, 30)} (${item.value.toString()})`;
        } catch {
          value = item.value.toString();
        }
      } else {
        value = item.value.toString();
      }
    } else if (typeof value === "bigint") {
      value = value.toString();
    }
    console.log(`  ${item.key}: ${value}`);
  }
}
