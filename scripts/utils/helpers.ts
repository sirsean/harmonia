/**
 * Re-export shared utilities from src/utils
 * This maintains backward compatibility for scripts while using the centralized implementation.
 */
export { toBigInt } from "../../src/utils/helpers";

/**
 * Get signer and account address
 * Common pattern used across many scripts
 *
 * Requires hardhat to be available in the calling context
 *
 * @returns Object with signer and account address
 */
export async function getSignerAndAccount(): Promise<{
  signer: any; // ethers.Signer but avoiding hardhat import
  account: string;
}> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ethers } = require("hardhat");
  const [signer] = await ethers.getSigners();
  const account = await signer.getAddress();
  return { signer, account };
}
