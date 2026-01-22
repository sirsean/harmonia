import { ethers } from "ethers";

export function getPositionKey(
  account: string,
  market: string,
  collateralToken: string,
  isLong: boolean
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "bool"],
    [account, market, collateralToken, isLong]
  );
  return ethers.keccak256(encoded);
}

export function computeEntryPrice12(
  sizeInUsd: bigint,
  sizeInTokens: bigint,
  tokenDecimals: number
): bigint {
  if (sizeInTokens === 0n) {
    return 0n;
  }
  const scale = 10n ** BigInt(tokenDecimals + 12 - 30);
  return (sizeInUsd * scale) / sizeInTokens;
}

export function computePnlUsd30FromPrices(
  sizeInTokens: bigint,
  entryPrice12: bigint,
  markPrice12: bigint,
  tokenDecimals: number,
  isLong: boolean
): bigint {
  if (sizeInTokens === 0n) {
    return 0n;
  }
  const priceDelta12 = isLong ? markPrice12 - entryPrice12 : entryPrice12 - markPrice12;
  const scale = 10n ** BigInt(30 - 12);
  return (priceDelta12 * sizeInTokens * scale) / 10n ** BigInt(tokenDecimals);
}

export function computeCollateralUsd30(
  collateralAmount: bigint,
  collateralPriceRaw: bigint
): bigint {
  return collateralAmount * collateralPriceRaw;
}

export function computeLiquidationPrice12(
  entryPrice12: bigint,
  collateralUsd30: bigint,
  minCollateralUsd30: bigint,
  sizeInTokens: bigint,
  tokenDecimals: number,
  isLong: boolean
): bigint | null {
  if (sizeInTokens === 0n) {
    return null;
  }
  const scale = 10n ** BigInt(30 - 12);
  const delta =
    ((collateralUsd30 - minCollateralUsd30) * 10n ** BigInt(tokenDecimals)) /
    (sizeInTokens * scale);
  if (isLong) {
    return entryPrice12 > delta ? entryPrice12 - delta : 0n;
  }
  return entryPrice12 + delta;
}
