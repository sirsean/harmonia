import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import nock from "nock";
import { describe, expect, it } from "vitest";
import { getLatestPrice } from "../../src/modules/chainlink/price";
import { ARBITRUM_MAINNET } from "../../src/config/addresses";

const cassetteDir = path.join(__dirname, "..", "cassettes");
const cassetteName = "chainlink-eth-usd.json";
const cassettePath = path.join(cassetteDir, cassetteName);

const apiKey = process.env.ALCHEMY_API_KEY;
const rpcUrlFromEnv = process.env.ALCHEMY_RPC_URL;
const hasCassette = fs.existsSync(cassettePath);
const hasRpc = Boolean(rpcUrlFromEnv || apiKey);
const shouldRun = hasCassette || hasRpc;
const shouldRecord = !hasCassette && hasRpc;

const makeRpcUrl = () => {
  if (hasCassette) {
    try {
      const raw = fs.readFileSync(cassettePath, "utf8");
      const definitions = JSON.parse(raw) as nock.Definition[];
      const first = definitions[0];
      if (first?.scope && first?.path) {
        return `${first.scope}${first.path}`;
      }
    } catch {
      return "https://arb-mainnet.g.alchemy.com/v2/REDACTED";
    }
  }

  if (rpcUrlFromEnv) {
    return rpcUrlFromEnv;
  }

  if (apiKey) {
    return `https://arb-mainnet.g.alchemy.com/v2/${apiKey}`;
  }

  return "";
};

const maybeDescribe = shouldRun ? describe : describe.skip;

maybeDescribe("chainlink integration", () => {
  it(
    "fetches ETH/USD price from Arbitrum via cassette",
    async () => {
    if (!shouldRun) {
      return;
    }

    if (!fs.existsSync(cassetteDir)) {
      fs.mkdirSync(cassetteDir, { recursive: true });
    }

    const nockBack = nock.back;
    nockBack.fixtures = cassetteDir;
    nockBack.setMode(hasCassette ? "lockdown" : "record");

    const afterRecord = (definitions: nock.Definition[]) => {
      if (!apiKey) {
        return definitions;
      }

      return definitions.map((definition) => {
        const redacted = {
          ...definition,
          scope:
            typeof definition.scope === "string"
              ? definition.scope.replace(apiKey, "REDACTED")
              : definition.scope,
        };

        if (typeof redacted.path === "string" && redacted.path.includes(apiKey)) {
          redacted.path = redacted.path.replace(apiKey, "REDACTED");
        }

        return redacted;
      });
    };

    const rpcUrl = makeRpcUrl();
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    const { nockDone } = await nockBack(cassetteName, { afterRecord });

    try {
      const result = await getLatestPrice(ARBITRUM_MAINNET.chainlinkEthUsdFeed, provider, {
        maxStaleSeconds: 24 * 60 * 60,
        nowSec: 1769101864, // Thu Jan 22 2026 17:11:04 UTC (slightly after cassette update)
      });

      expect(result.decimals).toBe(8);
      expect(result.price).toBeGreaterThan(0n);
      expect(result.priceWad).toBeGreaterThan(0n);
      expect(result.updatedAt).toBeGreaterThan(0);
    } finally {
      nockDone();
    }
    },
    20000
  );
});

if (hasCassette) {
  nock.disableNetConnect();
}

if (shouldRecord) {
  nock.enableNetConnect();
}
