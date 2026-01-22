export interface GMXTokenPriceRaw {
  tokenAddress: string;
  tokenSymbol?: string;
  minPrice: string;
  maxPrice: string;
  updatedAt?: number;
  timestamp?: number;
}

export interface GMXTokenPrice {
  tokenAddress: string;
  tokenSymbol?: string;
  minPrice: bigint;
  maxPrice: bigint;
  updatedAt?: number;
  timestamp?: number;
}

export const DEFAULT_GMX_PRICE_API = "https://arbitrum-api.gmxinfra.io/prices/tickers";

export function normalizeTokenPrice(raw: GMXTokenPriceRaw): GMXTokenPrice {
  return {
    tokenAddress: raw.tokenAddress,
    tokenSymbol: raw.tokenSymbol,
    minPrice: BigInt(raw.minPrice),
    maxPrice: BigInt(raw.maxPrice),
    updatedAt: raw.updatedAt,
    timestamp: raw.timestamp,
  };
}

export async function fetchTokenPrices(apiUrl = DEFAULT_GMX_PRICE_API): Promise<GMXTokenPrice[]> {
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch GMX prices: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as GMXTokenPriceRaw[];
  return data.map(normalizeTokenPrice);
}

export function findTokenPrice(prices: GMXTokenPrice[], tokenAddress: string): GMXTokenPrice {
  const match = prices.find(
    (price) => price.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
  );
  if (!match) {
    throw new Error(`GMX price not found for token ${tokenAddress}`);
  }
  return match;
}

export function averagePrice(price: GMXTokenPrice): bigint {
  return (price.minPrice + price.maxPrice) / 2n;
}

export function scalePriceTo30(priceRaw: bigint, tokenDecimals: number): bigint {
  return priceRaw * 10n ** BigInt(tokenDecimals);
}

export function price30ToPrice12(price30: bigint): bigint {
  return price30 / 10n ** 18n;
}
