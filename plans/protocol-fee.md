# Protocol Fee Implementation Plan

## Objective
Implement a configurable protocol fee mechanism where a percentage of the yield/profit is taken during compounding and assigned to a designated beneficiary (treasury) while remaining invested in the vault.

## Goals
1.  **Configurable Fee**: Ability to set a fee in basis points (BPS).
2.  **Beneficiary Assignment**: Fee is credited to a treasury address.
3.  **Reinvestment**: The fee assets remain in the vault strategy (compounded) but ownership is transferred to the treasury via share minting.
4.  **Safety**: Max fee limits and valid address checks.

## Architecture

### `DeltaNeutralVault.sol`

#### State Variables
- `uint256 public protocolFeeBps`: The fee percentage in basis points (e.g., 1000 = 10%).
- `address public treasury`: The recipient of the fee shares.
- `uint256 public constant MAX_PROTOCOL_FEE_BPS = 5000`: Maximum allowed fee (50%).

#### Events
- `ProtocolFeeUpdated(uint256 oldFee, uint256 newFee)`
- `TreasuryUpdated(address oldTreasury, address newTreasury)`
- `ProtocolFeeCollected(uint256 assets, uint256 sharesMinted)`

#### Functions
- `setProtocolFee(uint256 _protocolFeeBps)`: Admin only.
- `setTreasury(address _treasury)`: Admin only.
- `_compoundYield()`: Updated to calculate fee, mint shares to treasury, and deploy capital.

### Logic Flow in `_compoundYield`
1.  Get current idle assets (`balanceOf(this)`).
2.  If `idle > 0` and `protocolFeeBps > 0` and `treasury != address(0)`:
    a. Calculate `feeAssets = (idle * protocolFeeBps) / 10000`.
    b. Calculate `feeShares` equivalent to `feeAssets` using `convertToShares(feeAssets)`.
    c. Mint `feeShares` to `treasury`.
    d. Emit `ProtocolFeeCollected`.
3.  Call `_deployCapital(idle)`. (Note: We deploy the full `idle` amount, including the fee part, because the treasury now owns shares backed by those assets).

## Testing
- **Unit Tests**:
    - Verify fee setting (admin only, bounds check).
    - Verify treasury setting.
    - Verify `compound` correctly mints shares to treasury.
    - Verify dilution effect (share price should adjust slightly or total supply increase).
    - Verify no fee taken if set to 0.

## Security Considerations
- **Max Fee**: Prevent malicious admin from taking 100%.
- **Dilution**: Minting shares dilutes existing holders. This is the intended mechanism for "taking a cut" of the yield that has already accrued to the pool.
- **Treasury Address**: Ensure non-zero address.

