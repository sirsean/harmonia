import { ethers } from "hardhat";
import eventEmitterDeployment from "../deployments/EventEmitter.arbitrum.json";

type EventLogData = {
  addressItems?: { items: Array<{ key: string; value: string }> };
  uintItems?: { items: Array<{ key: string; value: bigint }> };
  boolItems?: { items: Array<{ key: string; value: boolean }> };
  bytes32Items?: { items: Array<{ key: string; value: string }> };
};

function getItem<T>(items: Array<{ key: string; value: T }>, key: string): T | undefined {
  const found = items.find((item) => item.key === key);
  return found?.value;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const account = (process.env.ACCOUNT || "").toLowerCase();
  const blocksBack = Number(process.env.BLOCKS_BACK || "200");
  const chunkSize = Number(process.env.CHUNK_SIZE || "10");

  const provider = ethers.provider;
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - blocksBack);

  console.log("EventEmitter:", eventEmitterDeployment.address);
  console.log("Account filter:", account || "none");
  console.log(`Blocks: ${fromBlock}..${latestBlock}`);

  const logs: Array<{ data: string; topics: string[]; address: string; blockNumber: number }> = [];
  for (let start = fromBlock; start <= latestBlock; start += chunkSize) {
    const end = Math.min(latestBlock, start + chunkSize - 1);
    const chunk = await provider.getLogs({
      address: eventEmitterDeployment.address,
      fromBlock: start,
      toBlock: end,
    });
    logs.push(...chunk);
  }

  const iface = new ethers.Interface(eventEmitterDeployment.abi);
  const orders: Array<{
    orderKey: string;
    market: string;
    isLong: boolean;
    acceptablePrice: string;
    sizeUsd: string;
    blockNumber: number;
  }> = [];

  for (const log of logs) {
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }

    const eventName = parsed.args.eventName as string;
    if (eventName !== "OrderCreated") continue;

    const eventData = parsed.args.eventData as EventLogData;
    const addressItems = eventData.addressItems?.items || [];
    const uintItems = eventData.uintItems?.items || [];
    const boolItems = eventData.boolItems?.items || [];
    const bytes32Items = eventData.bytes32Items?.items || [];

    const orderAccount = getItem(addressItems, "account");
    if (account && (!orderAccount || orderAccount.toLowerCase() !== account)) continue;

    const orderKey = getItem(bytes32Items, "key") || "0x";
    const market = getItem(addressItems, "market") || "0x";
    const acceptable = getItem(uintItems, "acceptablePrice") || 0n;
    const sizeUsd = getItem(uintItems, "sizeDeltaUsd") || 0n;
    const isLong = getItem(boolItems, "isLong") || false;

    const acceptableRaw = acceptable.toString();
    const acceptable30 = ethers.formatUnits(acceptable, 30);
    const acceptable18 = ethers.formatUnits(acceptable, 18);
    const acceptable12 = ethers.formatUnits(acceptable, 12);
    const acceptable6 = ethers.formatUnits(acceptable, 6);

    orders.push({
      orderKey,
      market,
      isLong,
      acceptablePrice: acceptable30,
      acceptableRaw,
      acceptable18,
      acceptable12,
      acceptable6,
      sizeUsd: ethers.formatUnits(sizeUsd, 30),
      blockNumber: log.blockNumber,
    });
  }

  console.log("Orders found:", orders.length);
  for (const order of orders) {
    console.log("\nOrder Key:", order.orderKey);
    console.log("  Market:", order.market);
    console.log("  Is Long:", order.isLong);
    console.log("  Size (USD):", order.sizeUsd);
    console.log("  Acceptable Price:", order.acceptablePrice);
    console.log("  Acceptable Raw:", order.acceptableRaw);
    console.log("  Acceptable (18d):", order.acceptable18);
    console.log("  Acceptable (12d):", order.acceptable12);
    console.log("  Acceptable (6d):", order.acceptable6);
    console.log("  Block:", order.blockNumber);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
