# Vault Size Analysis

This document analyzes the theoretical and economic limits of the Delta Neutral Vault's size. It determines how large the vault can grow before it hits hard protocol limits or becomes economically inefficient.

## 1. Theoretical Hard Limits

These are constraints enforced by the underlying protocols (GMX, Uniswap) that physically prevent the vault from deploying more capital.

### 1.1 GMX V2 Max Open Interest (Short)

GMX V2 imposes a maximum Open Interest (OI) limit for each market, specifically for Longs and Shorts separately.

*   **Constraint:** `VaultHedgeSize <= AvailableShortOI`
*   **AvailableShortOI:** `MaxShortOI - CurrentShortOI`
*   **VaultHedgeSize:** The size of the short position required to hedge the Uniswap LP position. Roughly equal to the value of the non-stable asset in the LP position (plus some buffer).
*   **Formula:**
    $$ MaxVaultSize_{GMX} \approx \frac{AvailableShortOI}{HedgeRatio} $$
    *   *HedgeRatio* is typically $\approx 0.45$ for a standard setup (holding ~45% volatile asset).

### 1.2 Uniswap V3 Tick Limits (Position Size)

While Uniswap doesn't have a hard "Max TVL" cap, there are practical limits to how much liquidity can be minted in a single position due to variable data types (uint128 for liquidity), but this is practically unreachable ($2^{128}$).

## 2. Economic Soft Limits

These are levels where the vault *can* technically grow, but performance degrades significantly.

### 2.1 Uniswap Pool Dominance & Slippage

If the vault owns a large percentage of the Uniswap pool's liquidity:
1.  **Rebalancing Costs:** Adjusting the range becomes expensive due to high slippage. We are trading against our own liquidity or lack thereof.
2.  **Exit Liquidity:** Unwinding the position requires selling the underlying tokens. If the pool is thin, exit slippage is high.

*   **Metric:** Pool Dominance % = `VaultLiquidity / TotalPoolLiquidity`
*   **Soft Limit:** Typically, we want to stay under **20%** of the pool's active liquidity to ensure safe rebalancing and exits.
*   **Calculation:** We convert the target liquidity dominance into a USD value based on the current price and the vault's configured range width.

### 2.2 Yield Dilution (Uniswap)

Trading fees are finite. Adding liquidity dilutes the APR for existing LPs (including the vault itself).

### 2.3 GMX Funding Rates vs. Fee Revenue

The vault pays or receives funding on its short position.
*   **Mechanism:** In GMX V2, funding balances Long vs. Short OI.
    *   If `Longs > Shorts`, Shorts receive funding.
    *   If `Shorts > Longs`, Shorts pay funding.
*   **Trade-off:** We can tolerate paying funding as long as the **Net Yield** meets our target.
*   **Target:** `ExpectedUniswapFeeAPR - FundingCostAPR >= MinYieldAPR (5%)`
*   **Capacity:** We estimate how much additional Short OI would push the funding rate to the max acceptable level (where `FundingCostAPR = ExpectedFeeAPR - 5%`).
*   **Sensitivity:** We assume a funding sensitivity (e.g., 2% APY increase per $1M OI imbalance for deep markets) to project this capacity.

## 3. Calculating the Limits

We can define the **Maximum Effective Vault Size** as the minimum of all constraints:

$$ MaxSize = \min(Limit_{GMX\_Hard}, Limit_{PoolDominance}, Limit_{EconomicTarget}) $$

### Algorithm

1.  **Fetch Data:**
    *   **GMX:** `maxShortOI`, `openInterestShort`, `openInterestLong`.
    *   **Uniswap:** `poolLiquidity`, `poolPrice`.
2.  **Calculate GMX Headroom:**
    *   `AvailableShorts = maxShortOI - openInterestShort`
    *   `Limit_GMX = AvailableShorts / HedgeRatio`
3.  **Calculate Uniswap Dominance Cap:**
    *   Convert `Liquidity * 20%` into USD value using standard V3 formulas for the vault's specific range width.
4.  **Calculate Economic Limit (Min 5% Yield):**
    *   `FundingFlipCap = max(0, Longs - Shorts)` (Zero cost capacity).
    *   `MaxFundingCost = ExpectedFeeAPR - 5%`.
    *   `ExtraCapacity = (MaxFundingCost / FundingSensitivity) * $1M`.
    *   `Limit_Economic = (FundingFlipCap + ExtraCapacity) / HedgeRatio`.

## 4. Findings & Analysis Tool

A script has been implemented at `scripts/analyze-vault-size.ts` to calculate these limits in real-time.

### Key Findings (Jan 2026):
- **ETH Market (Arbitrum):**
  - **Dominance Limit:** ~$9.5M (20% of Uniswap Pool).
  - **Economic Limit:** ~$13.8M (Yield remains >5%).
  - **Conclusion:** Uniswap liquidity is the primary constraint. **Max Recommended Size: ~$9.5M**.

- **BTC Market (Arbitrum):**
  - **Pool Update:** Switched to 0.05% WBTC/USDC pool which has significantly deeper liquidity.
  - **Dominance Limit:** Improved to **~$2.06M** (up from $26k).
  - **Economic Limit:** ~$6.1M.
  - **Conclusion:** Uniswap liquidity is the primary constraint. **Max Recommended Size: ~$2.06M**.

### Usage
To run the analysis:
```bash
MARKET=ETH npx hardhat run scripts/analyze-vault-size.ts --network arbitrum
MARKET=BTC npx hardhat run scripts/analyze-vault-size.ts --network arbitrum
```
