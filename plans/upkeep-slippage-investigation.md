# Upkeep slippage investigation (2026-01-20)

## Context
- Chainlink Automation `checkUpkeep` returns `true` and `Rebalance`.
- `performUpkeep` dry-run reverts with: `Price slippage check`.
- We added diagnostic scripts to inspect upkeep and slippage inputs.

## Contracts involved
- RebalanceController: `0xC6c1aC4e3fbDfbFA2d5554C77A081BaE178aac86`
- Vault: `0xc04B2CA460b3D6B6408D609DD3E6E55C9c734DC6`
- LiquidityManager: `0x0aa77E5CE038c878A5d2704A6C18b53cD7d855De`
- HedgeManager: `0x9D81A634c269cf262192886B5cC678E00c9D96d8`

## Scripts added
- `scripts/diagnostics/check-upkeep.ts`
  - Calls `checkUpkeep`, decodes upkeep type, prints timing + thresholds.
- `scripts/diagnostics/perform-upkeep.ts`
  - `DRY_RUN=1` uses `performUpkeep.staticCall` and reports revert.
- `scripts/diagnostics/diagnose-upkeep-slippage.ts`
  - Computes target hedge size and prints Chainlink/Uniswap price, slippage tolerance, acceptable price.

## Commands + output (key lines)
- `npx hardhat run scripts/diagnostics/check-upkeep.ts --network arbitrum`
  - Upkeep needed: `true`
  - Upkeep type: `Rebalance`
  - Delta ratio: `83.6587%` (threshold `5%`)
  - Time since rebalance: `~20h 39m`

- `DRY_RUN=1 npx hardhat run scripts/diagnostics/perform-upkeep.ts --network arbitrum`
  - Revert: `execution reverted: Price slippage check`

- `npx hardhat run scripts/diagnostics/diagnose-upkeep-slippage.ts --network arbitrum`
  - Action: `increase` short
  - Target hedge USD (30d): `401780294324550100152000000000000` (~$401,780)
  - Current hedge USD: `0`
  - Chainlink price: `3033.12`
  - Slippage tolerance: `1.0%`
  - Acceptable price (12d): `3002.7888`
  - Chainlink vs Uniswap deviation: `0.07%`

## Interpretation
- Rebalance path attempts a large GMX short increase with 1% slippage tolerance.
- Price sources are consistent, so revert likely from GMX price impact/slippage checks for size.

## Next actions to test
1) Increase `HedgeManager.slippageTolerance` (max 5%) and re-run dry-run.
2) Reduce target size by chunking hedge adjustments into smaller orders.
3) Inspect GMX price impact / limits for the ETH-USDC market at this size.
4) Confirm vault has enough USDC collateral to post for the hedge increase.

## Notes
- `performUpkeep` uses the same target sizing as `_executeRebalance` in `DeltaNeutralVault`.
- Slippage logic is inside `HedgeManager._createOrder` (acceptable price vs Chainlink price).
