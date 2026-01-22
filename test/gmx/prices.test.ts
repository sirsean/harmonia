import { describe, expect, it, vi } from "vitest";
import {
  averagePrice,
  fetchTokenPrices,
  findTokenPrice,
  normalizeTokenPrice,
  price30ToPrice12,
  scalePriceTo30,
} from "../../src/modules/gmx/prices";

const raw = {
  tokenAddress: "0xToken",
  tokenSymbol: "TEST",
  minPrice: "100",
  maxPrice: "120",
  updatedAt: 1,
  timestamp: 2,
};

describe("gmx prices", () => {
  it("normalizes token prices", () => {
    const result = normalizeTokenPrice(raw);
    expect(result.minPrice).toBe(100n);
    expect(result.maxPrice).toBe(120n);
  });

  it("finds token prices by address", () => {
    const prices = [normalizeTokenPrice(raw)];
    const found = findTokenPrice(prices, "0xToken");
    expect(found.tokenSymbol).toBe("TEST");
  });

  it("averages min/max", () => {
    const price = normalizeTokenPrice(raw);
    expect(averagePrice(price)).toBe(110n);
  });

  it("scales prices to 30 decimals", () => {
    expect(scalePriceTo30(100n, 6)).toBe(100n * 10n ** 6n);
  });

  it("converts price30 to price12", () => {
    expect(price30ToPrice12(100n * 10n ** 18n)).toBe(100n);
  });

  it("fetches token prices", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [raw],
    });
    const original = global.fetch;
    global.fetch = mockFetch as typeof fetch;

    try {
      const prices = await fetchTokenPrices("https://example.com");
      expect(prices[0].minPrice).toBe(100n);
      expect(mockFetch).toHaveBeenCalledWith("https://example.com");
    } finally {
      global.fetch = original;
    }
  });
});
