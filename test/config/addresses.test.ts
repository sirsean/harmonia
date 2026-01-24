import { describe, it, expect } from "vitest";
import {
  ARBITRUM_MAINNET,
  getNetworkAddresses,
  NetworkAddresses,
} from "../../src/config/addresses";

describe("Addresses Configuration", () => {
  describe("ARBITRUM_MAINNET", () => {
    it("should have all required Uniswap V3 addresses", () => {
      expect(ARBITRUM_MAINNET.uniswapV3Factory).toBeTruthy();
      expect(ARBITRUM_MAINNET.uniswapV3PositionManager).toBeTruthy();
      expect(ARBITRUM_MAINNET.uniswapV3SwapRouter).toBeTruthy();
      expect(ARBITRUM_MAINNET.uniswapV3Quoter).toBeTruthy();
      expect(ARBITRUM_MAINNET.uniswapV3EthUsdcPool).toBeTruthy();
    });

    it("should have all required GMX V2 addresses", () => {
      expect(ARBITRUM_MAINNET.gmxExchangeRouter).toBeTruthy();
      expect(ARBITRUM_MAINNET.gmxOrderVault).toBeTruthy();
      expect(ARBITRUM_MAINNET.gmxDataStore).toBeTruthy();
      expect(ARBITRUM_MAINNET.gmxReader).toBeTruthy();
      expect(ARBITRUM_MAINNET.gmxEthUsdMarket).toBeTruthy();
      expect(ARBITRUM_MAINNET.gmxReferralStorage).toBeTruthy();
      expect(ARBITRUM_MAINNET.gmxPriceApi).toBeTruthy();
    });

    it("should have Chainlink feed address", () => {
      expect(ARBITRUM_MAINNET.chainlinkEthUsdFeed).toBeTruthy();
    });

    it("should have token addresses", () => {
      expect(ARBITRUM_MAINNET.usdc).toBeTruthy();
      expect(ARBITRUM_MAINNET.weth).toBeTruthy();
    });

    it("should have valid Ethereum addresses", () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      expect(ARBITRUM_MAINNET.uniswapV3Factory).toMatch(addressRegex);
      expect(ARBITRUM_MAINNET.uniswapV3PositionManager).toMatch(addressRegex);
      expect(ARBITRUM_MAINNET.usdc).toMatch(addressRegex);
      expect(ARBITRUM_MAINNET.weth).toMatch(addressRegex);
    });

    it("should have valid URL for GMX price API", () => {
      expect(ARBITRUM_MAINNET.gmxPriceApi).toMatch(/^https?:\/\//);
    });
  });

  describe("getNetworkAddresses", () => {
    it("should return Arbitrum mainnet addresses for chain ID 42161", () => {
      const addresses = getNetworkAddresses(42161);
      expect(addresses).toEqual(ARBITRUM_MAINNET);
    });

    it("should return Arbitrum mainnet addresses for unknown chain IDs (default)", () => {
      const addresses = getNetworkAddresses(999);
      expect(addresses).toEqual(ARBITRUM_MAINNET);
    });

    it("should return addresses matching NetworkAddresses interface", () => {
      const addresses = getNetworkAddresses(42161);
      const requiredKeys: (keyof NetworkAddresses)[] = [
        "uniswapV3Factory",
        "uniswapV3PositionManager",
        "uniswapV3SwapRouter",
        "uniswapV3Quoter",
        "uniswapV3EthUsdcPool",
        "gmxExchangeRouter",
        "gmxOrderVault",
        "gmxDataStore",
        "gmxReader",
        "gmxEthUsdMarket",
        "gmxReferralStorage",
        "gmxPriceApi",
        "chainlinkEthUsdFeed",
        "usdc",
        "weth",
      ];

      for (const key of requiredKeys) {
        expect(addresses).toHaveProperty(key);
        expect(typeof addresses[key]).toBe("string");
      }
    });
  });
});
