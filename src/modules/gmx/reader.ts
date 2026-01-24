import { ethers } from "ethers";
import { GMXMarket, GMXPosition, GMXReader } from "./types";
import { GMX_READER_ABI } from "../../utils/abis";

export function createReader(address: string, provider: ethers.Provider): GMXReader {
  return new ethers.Contract(address, GMX_READER_ABI, provider) as unknown as GMXReader;
}

export async function getAccountPositions(
  reader: GMXReader,
  dataStore: string,
  account: string,
  start: number,
  end: number
): Promise<GMXPosition[]> {
  return reader.getAccountPositions(dataStore, account, start, end);
}

export function findPosition(
  positions: GMXPosition[],
  filters: { market?: string; collateralToken?: string; isLong?: boolean }
): GMXPosition | undefined {
  const market = filters.market?.toLowerCase();
  const collateralToken = filters.collateralToken?.toLowerCase();

  return positions.find((position) => {
    if (market && position.addresses.market.toLowerCase() !== market) {
      return false;
    }
    if (collateralToken && position.addresses.collateralToken.toLowerCase() !== collateralToken) {
      return false;
    }
    if (filters.isLong !== undefined && position.flags.isLong !== filters.isLong) {
      return false;
    }
    return true;
  });
}

export async function getPosition(
  reader: GMXReader,
  dataStore: string,
  account: string,
  options: {
    start?: number;
    end?: number;
    market?: string;
    collateralToken?: string;
    isLong?: boolean;
  }
): Promise<GMXPosition | undefined> {
  const start = options.start ?? 0;
  const end = options.end ?? 10;
  const positions = await getAccountPositions(reader, dataStore, account, start, end);
  return findPosition(positions, {
    market: options.market,
    collateralToken: options.collateralToken,
    isLong: options.isLong,
  });
}

export async function getMarket(
  reader: GMXReader,
  dataStore: string,
  marketKey: string
): Promise<GMXMarket> {
  return reader.getMarket(dataStore, marketKey);
}

// getPositionInfo/isPositionLiquidatable helpers intentionally omitted to avoid ABI mismatch
