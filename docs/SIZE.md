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
    *   *HedgeRatio* is typically $\approx 0.5$ for a full range position (holding 50% volatile asset), or varies for concentrated positions. For a standard setup, if we deposit \$100, we might need to hedge \$50 of ETH. So $MaxVaultSize \approx 2 \times AvailableShortOI$.

### 1.2 Uniswap V3 Tick Limits (Position Size)

While Uniswap doesn't have a hard "Max TVL" cap, there are practical limits to how much liquidity can be minted in a single position due to variable data types (uint128 for liquidity), but this is practically unreachable ($2^{128}$). 

## 2. Economic Soft Limits

These are levels where the vault *can* technically grow, but performance degrades significantly.

### 2.1 Uniswap Pool Dominance & Slippage

If the vault owns a large percentage of the Uniswap pool's liquidity:
1.  **Rebalancing Costs:** Adjusting the range becomes expensive due to high slippage. We are trading against our own liquidity or lack thereof.
2.  **Exit Liquidity:** Unwinding the position requires selling the underlying tokens. If the pool is thin, exit slippage is high.

*   **Metric:** Pool Dominance % = `VaultLiquidity / TotalPoolLiquidity`
*   **Soft Limit:** Typically, we want to stay under **10-20%** of the pool's TVL to ensure safe rebalancing and exits.

### 2.2 Yield Dilution (Uniswap)

Trading fees are finite. Adding liquidity dilutes the APR for existing LPs (including the vault itself).

*   **Formula:**
    $$ ProjectedAPR = \frac{AnnualizedFees}{CurrentPoolTVL + VaultAddedTVL} $$
*   **Analysis:** We can calculate the `VaultAddedTVL` at which `ProjectedAPR` drops below our `TargetAPR` (hurdle rate).

### 2.3 GMX Funding Rates

The vault pays or receives funding on its short position.
*   **Mechanism:** In GMX V2, funding balances Long vs. Short OI.
    *   If `Longs > Shorts`, Shorts receive funding.
    *   If `Shorts > Longs`, Shorts pay funding.
*   **Risk:** As the vault increases Short OI, it pushes the `Short/Long` ratio higher. If the vault is too large, it might flip the funding rate from positive (receiving) to negative (paying), destroying the strategy's yield.
*   **Soft Limit:** The size at which `FundingRate` becomes negative or drops below a threshold.

## 3. Calculating the Limits

We can define the **Maximum Effective Vault Size** as the minimum of all constraints:

$$ MaxSize = \min(Limit_{GMX\_Hard}, Limit_{PoolDominance}, Limit_{YieldDilution}, Limit_{FundingFlip}) $$

### Algorithm

1.  **Fetch Data:**
    *   **GMX:** `maxShortOI`, `openInterestShort`, `openInterestLong`.
    *   **Uniswap:** `poolLiquidity`, `poolFeeGrowth`, `volume24h` (estimated).
2.  **Calculate GMX Headroom:**
    *   `AvailableShorts = maxShortOI - openInterestShort`
    *   `Limit_GMX = AvailableShorts / HedgeRatio`
3.  **Calculate Uniswap Dominance Cap:**
    *   `Limit_Dominance = poolLiquidity * MaxDominancePercent / (1 - MaxDominancePercent)`
4.  **Simulate Funding Impact:**
    *   Estimate how adding $X$ short OI changes the funding rate. Find $X$ where funding becomes prohibitive.

## 4. Implementation Plan

We will create a script `scripts/analyze-vault-size.ts` that:
1.  Takes a target market (e.g., WETH/USDC).
2.  Queries current chain state.
3.  Outputs:
    *   Current Vault Size (if deployed).
    *   Maximum theoretical size (GMX limit).
    *   Recommended maximum size (Dominance limit).
    *   Projected Yield curve at different sizes ($100k, $1M, $10M).

## 5. Future Work: On-Chain Enforcement

Eventually, `DeltaNeutralVault.sol` could enforce `depositCap` dynamically based on these metrics, or `SecurityModule` could block deposits if limits are reached.

## 6. Findings & Analysis Tool

A script has been implemented at `scripts/analyze-vault-size.ts` to calculate these limits in real-time.

### Key Findings (Jan 2026):
- **GMX Data Store Keys:** GMX V2 uses ABI-encoded keys for Open Interest. The correct key derivation is `keccak256(abi.encode(keccak256(abi.encode("OPEN_INTEREST")), market, collateral, isLong))`. 
- **ETH Market (Arbitrum):**
  - **GMX Hard Limit:** Currently unlimited (0 returned by DataStore).
  - **Funding Flip Limit:** Shorts are currently ~$2.8M vs Longs ~$5.4M. This leaves ~$2.5M of short capacity before flipping to negative funding.
  - **Vault Capacity:** With a ~45% hedge ratio, the vault can grow to **~$5.6M** before paying funding costs.
- **BTC Market (Arbitrum):**
  - **Funding Flip:** Shorts (~$7.9M) already exceed Longs (~$7.4M).
  - **Implication:** New vaults would immediately pay funding costs, making the strategy less attractive unless Uniswap yields are very high.

### Usage
To run the analysis:
```bash
MARKET=ETH npx hardhat run scripts/analyze-vault-size.ts --network arbitrum
MARKET=BTC npx hardhat run scripts/analyze-vault-size.ts --network arbitrum
```