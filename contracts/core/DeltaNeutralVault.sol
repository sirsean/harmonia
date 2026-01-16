// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ILiquidityManager} from "../interfaces/ILiquidityManager.sol";
import {IHedgeManager} from "../interfaces/IHedgeManager.sol";
import {SecurityModule} from "../libraries/SecurityModule.sol";

/// @title Delta Neutral Vault
/// @notice ERC-4626 vault that deploys capital into delta-neutral yield strategy
/// @dev Combines Uniswap v3 LP positions with GMX v2 perpetual hedging
contract DeltaNeutralVault is ERC4626, ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Precision for percentage calculations (1e18 = 100%)
    uint256 public constant PRECISION = 1e18;

    /// @notice Delta threshold for triggering rebalance (5%)
    uint256 public constant DELTA_THRESHOLD = 5e16;

    /// @notice Maximum leverage on perpetual position (3x)
    uint256 public constant MAX_LEVERAGE = 3e18;

    /// @notice Minimum hedge ratio required (80%)
    uint256 public constant MIN_HEDGE_RATIO = 80e16;

    /// @notice Emergency threshold for circuit breaker (20%)
    uint256 public constant EMERGENCY_THRESHOLD = 20e16;

    /// @notice Maximum single withdrawal percentage (25%)
    uint256 public constant MAX_SINGLE_WITHDRAWAL = 25e16;

    /// @notice Minimum interval between large withdrawals (1 hour)
    uint256 public constant LARGE_WITHDRAWAL_COOLDOWN = 1 hours;

    /// @notice Large withdrawal threshold (10% of total assets)
    uint256 public constant LARGE_WITHDRAWAL_THRESHOLD = 10e16;

    // ============ State Variables ============

    /// @notice Address of the liquidity manager (to be set in Phase 4)
    address public liquidityManager;

    /// @notice Address of the hedge manager (to be set in Phase 5)
    address public hedgeManager;

    /// @notice Address of the rebalance controller (to be set in Phase 6)
    address public rebalanceController;

    /// @notice Current Uniswap v3 position token ID (0 if no position)
    uint256 public lpTokenId;

    /// @notice Timestamp of last rebalance
    uint256 public lastRebalanceTime;

    /// @notice Total fees collected (in asset terms)
    uint256 public totalFeesCollected;

    /// @notice Total funding received/paid (can be negative)
    int256 public totalFundingReceived;

    /// @notice Deposit cap (0 means no cap)
    uint256 public depositCap;

    /// @notice Circuit breaker: is the vault in lockdown mode
    bool public circuitBreakerTriggered;

    /// @notice Timestamp of last large withdrawal
    uint256 public lastLargeWithdrawalTime;

    /// @notice Circuit breaker: is the mechanism enabled
    bool public circuitBreakerEnabled = true;

    /// @notice Guardian address for emergency operations
    address public guardian;

    // ============ Events ============

    /// @notice Emitted when capital is deployed to strategy
    event CapitalDeployed(uint256 assets, uint256 lpValue, uint256 hedgeValue);

    /// @notice Emitted when capital is withdrawn from strategy
    event CapitalWithdrawn(uint256 assets, uint256 lpValue, uint256 hedgeValue);

    /// @notice Emitted when a rebalance is executed
    event Rebalanced(int256 deltaBefore, int256 deltaAfter, uint256 hedgeAdjustment);

    /// @notice Emitted when fees are collected
    event FeesCollected(uint256 amount0, uint256 amount1, uint256 totalUSD);

    /// @notice Emitted when funding is claimed
    event FundingClaimed(int256 amount);

    /// @notice Emitted when deposit cap is updated
    event DepositCapUpdated(uint256 oldCap, uint256 newCap);

    /// @notice Emitted when circuit breaker enabled status is updated
    event CircuitBreakerEnabled(bool enabled);

    /// @notice Emitted when managers are updated
    event ManagersUpdated(
        address liquidityManager,
        address hedgeManager,
        address rebalanceController
    );

    /// @notice Emitted when circuit breaker is triggered
    event CircuitBreakerTriggered(int256 deltaRatio, uint256 timestamp);

    /// @notice Emitted when circuit breaker is reset
    event CircuitBreakerReset(uint256 timestamp);

    /// @notice Emitted when guardian is updated
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);

    /// @notice Emitted when large withdrawal cooldown is enforced
    event LargeWithdrawalCooldownEnforced(uint256 requestedAmount, uint256 cooldownEnd);

    // ============ Errors ============

    /// @notice Thrown when deposit would exceed cap
    error DepositCapExceeded(uint256 requested, uint256 available);

    /// @notice Thrown when caller is not authorized
    error Unauthorized(address caller);

    /// @notice Thrown when position is in emergency state
    error EmergencyState();

    /// @notice Thrown when zero amount is provided
    error ZeroAmount();

    /// @notice Thrown when address is zero
    error ZeroAddress();

    /// @notice Thrown when circuit breaker is active
    error CircuitBreakerActive();

    /// @notice Thrown when withdrawal is too large
    error WithdrawalTooLarge(uint256 requested, uint256 maxAllowed);

    /// @notice Thrown when withdrawal cooldown is active
    error WithdrawalCooldownActive(uint256 cooldownEnd);

    /// @notice Thrown when caller is not guardian
    error OnlyGuardian();

    // ============ Constructor ============

    /// @notice Initialize the vault with USDC as the underlying asset
    /// @param _asset Address of the underlying asset (USDC)
    /// @param _name Name of the vault token
    /// @param _symbol Symbol of the vault token
    /// @param _owner Address of the vault owner
    constructor(
        IERC20 _asset,
        string memory _name,
        string memory _symbol,
        address _owner
    ) ERC4626(_asset) ERC20(_name, _symbol) Ownable(_owner) {
        if (address(_asset) == address(0)) revert ZeroAddress();
        // Note: OpenZeppelin's Ownable already validates non-zero owner
    }

    // ============ ERC-4626 Overrides ============

    /// @notice Calculate total assets under management
    /// @dev Combines idle assets + LP position value + hedge position value
    /// @return Total assets in USDC terms
    function totalAssets() public view override returns (uint256) {
        uint256 idleAssets = IERC20(asset()).balanceOf(address(this));
        uint256 lpValue = _getLPValue();
        uint256 hedgeValue = _getHedgeValue();

        return idleAssets + lpValue + hedgeValue;
    }

    /// @notice Deposit assets and receive vault shares
    /// @dev Overridden to add deposit cap check and reentrancy protection
    /// @param assets Amount of assets to deposit
    /// @param receiver Address to receive vault shares
    /// @return shares Amount of shares minted
    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant whenNotPaused returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();

        // Check deposit cap
        if (depositCap > 0) {
            uint256 totalAfterDeposit = totalAssets() + assets;
            if (totalAfterDeposit > depositCap) {
                uint256 available = depositCap > totalAssets() ? depositCap - totalAssets() : 0;
                revert DepositCapExceeded(assets, available);
            }
        }

        shares = super.deposit(assets, receiver);

        // Deploy capital to strategy (to be implemented in Phase 4+)
        _deployCapital(assets);
    }

    /// @notice Mint exact shares by depositing assets
    /// @dev Overridden to add deposit cap check and reentrancy protection
    /// @param shares Amount of shares to mint
    /// @param receiver Address to receive vault shares
    /// @return assets Amount of assets deposited
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant whenNotPaused returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();

        assets = previewMint(shares);

        // Check deposit cap
        if (depositCap > 0) {
            uint256 totalAfterDeposit = totalAssets() + assets;
            if (totalAfterDeposit > depositCap) {
                uint256 available = depositCap > totalAssets() ? depositCap - totalAssets() : 0;
                revert DepositCapExceeded(assets, available);
            }
        }

        assets = super.mint(shares, receiver);

        // Deploy capital to strategy
        _deployCapital(assets);
    }

    /// @notice Withdraw exact assets by burning shares
    /// @dev Overridden to add reentrancy protection, circuit breaker, and capital unwinding
    /// @param assets Amount of assets to withdraw
    /// @param receiver Address to receive assets
    /// @param shareOwner Address of share owner
    /// @return shares Amount of shares burned
    function withdraw(
        uint256 assets,
        address receiver,
        address shareOwner
    ) public override nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();

        // Circuit breaker check - block new withdrawals during emergency (except owner/guardian)
        // Circuit breaker check - block new withdrawals during emergency (except owner/guardian)
        if (
            circuitBreakerEnabled &&
            circuitBreakerTriggered &&
            msg.sender != owner() &&
            msg.sender != guardian
        ) {
            revert CircuitBreakerActive();
        }

        // Large withdrawal protection
        _validateWithdrawalSize(assets);

        // Unwind capital from strategy before withdrawal
        _unwindCapital(assets);

        shares = super.withdraw(assets, receiver, shareOwner);
    }

    /// @notice Redeem exact shares for assets
    /// @dev Overridden to add reentrancy protection, circuit breaker, and capital unwinding
    /// @param shares Amount of shares to redeem
    /// @param receiver Address to receive assets
    /// @param shareOwner Address of share owner
    /// @return assets Amount of assets received
    function redeem(
        uint256 shares,
        address receiver,
        address shareOwner
    ) public override nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();

        // Circuit breaker check - block new redemptions during emergency (except owner/guardian)
        // Circuit breaker check - block new withdrawals during emergency (except owner/guardian)
        if (
            circuitBreakerEnabled &&
            circuitBreakerTriggered &&
            msg.sender != owner() &&
            msg.sender != guardian
        ) {
            revert CircuitBreakerActive();
        }

        assets = previewRedeem(shares);

        // Large withdrawal protection
        _validateWithdrawalSize(assets);

        // Unwind capital from strategy before redemption
        _unwindCapital(assets);

        assets = super.redeem(shares, receiver, shareOwner);
    }

    // ============ Strategy Functions ============

    /// @notice Execute rebalance to maintain delta neutrality
    /// @dev Called by rebalance controller when delta drift exceeds threshold
    /// @param targetHedgeSize Target size for hedge position
    function rebalance(uint256 targetHedgeSize) external {
        if (msg.sender != rebalanceController && msg.sender != owner()) {
            revert Unauthorized(msg.sender);
        }

        // Check for emergency condition and trigger circuit breaker if needed
        _checkAndTriggerCircuitBreaker();

        int256 deltaBefore = getNetDelta();

        // Rebalance logic will be implemented in Phase 5+6
        _executeRebalance(targetHedgeSize);

        int256 deltaAfter = getNetDelta();
        lastRebalanceTime = block.timestamp;

        emit Rebalanced(deltaBefore, deltaAfter, targetHedgeSize);
    }

    /// @notice Collect accrued fees from LP position
    /// @dev Called periodically to harvest yield
    function collectFees() external returns (uint256 amount0, uint256 amount1) {
        // Fee collection will be implemented in Phase 4
        (amount0, amount1) = _collectLPFees();

        uint256 totalUSD = _calculateFeesInUSD(amount0, amount1);
        totalFeesCollected += totalUSD;

        emit FeesCollected(amount0, amount1, totalUSD);
    }

    /// @notice Claim funding payments from perpetual position
    /// @dev Called periodically to realize funding income/expense
    function claimFunding() external returns (int256 fundingAmount) {
        // Funding claim will be implemented in Phase 5
        fundingAmount = _claimHedgeFunding();
        totalFundingReceived += fundingAmount;

        emit FundingClaimed(fundingAmount);
    }

    /// @notice Compound collected yield back into strategy
    /// @dev Reinvests fees and funding into LP + hedge
    function compound() external {
        // Compounding will be implemented in Phase 6
        _compoundYield();
    }

    // ============ View Functions ============

    /// @notice Get the current LP position value in USDC terms
    /// @return value LP position value
    function getLPValue() external view returns (uint256 value) {
        return _getLPValue();
    }

    /// @notice Get the current hedge position value (collateral + unrealized PnL)
    /// @return value Hedge position value in USDC
    function getHedgeValue() external view returns (uint256 value) {
        return _getHedgeValue();
    }

    /// @notice Get the net delta of the combined position
    /// @dev Net delta = LP delta + hedge delta (should be ~0)
    /// @return netDelta Net delta (positive = long, negative = short)
    function getNetDelta() public view returns (int256 netDelta) {
        int256 lpDelta = _getLPDelta();
        int256 hedgeDelta = _getHedgeDelta();
        return lpDelta + hedgeDelta;
    }

    /// @notice Get the current delta ratio (net delta / position value)
    /// @return deltaRatio Delta as percentage of position (scaled by 1e18)
    function getDeltaRatio() external view returns (int256 deltaRatio) {
        uint256 total = totalAssets();
        if (total == 0) return 0;

        int256 netDelta = getNetDelta();
        deltaRatio = (netDelta * int256(PRECISION)) / int256(total);
    }

    /// @notice Check if rebalance is needed
    /// @return needed True if delta drift exceeds threshold
    function rebalanceNeeded() external view returns (bool needed) {
        int256 deltaRatio = this.getDeltaRatio();
        int256 absRatio = deltaRatio >= 0 ? deltaRatio : -deltaRatio;
        return uint256(absRatio) > DELTA_THRESHOLD;
    }

    /// @notice Check if position is in emergency state
    /// @return emergency True if delta drift exceeds emergency threshold
    function isEmergency() external view returns (bool emergency) {
        int256 deltaRatio = this.getDeltaRatio();
        int256 absRatio = deltaRatio >= 0 ? deltaRatio : -deltaRatio;
        return uint256(absRatio) > EMERGENCY_THRESHOLD;
    }

    // ============ Admin Functions ============

    /// @notice Set the deposit cap
    /// @param _depositCap New deposit cap (0 for no cap)
    function setDepositCap(uint256 _depositCap) external onlyOwner {
        uint256 oldCap = depositCap;
        depositCap = _depositCap;
        emit DepositCapUpdated(oldCap, _depositCap);
    }

    /// @notice Enable or disable the circuit breaker mechanism
    /// @param _enabled True to enable, false to disable
    function setCircuitBreakerEnabled(bool _enabled) external onlyOwner {
        circuitBreakerEnabled = _enabled;
        emit CircuitBreakerEnabled(_enabled);
    }

    /// @notice Set manager addresses
    /// @param _liquidityManager Address of liquidity manager
    /// @param _hedgeManager Address of hedge manager
    /// @param _rebalanceController Address of rebalance controller
    function setManagers(
        address _liquidityManager,
        address _hedgeManager,
        address _rebalanceController
    ) external onlyOwner {
        liquidityManager = _liquidityManager;
        hedgeManager = _hedgeManager;
        rebalanceController = _rebalanceController;
        emit ManagersUpdated(_liquidityManager, _hedgeManager, _rebalanceController);
    }

    /// @notice Pause the vault (emergency)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause the vault
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Emergency unwind all positions
    /// @dev Closes LP and hedge positions, converts everything to USDC
    function emergencyUnwind() external {
        if (msg.sender != owner() && msg.sender != guardian) {
            revert Unauthorized(msg.sender);
        }
        _pause();
        circuitBreakerTriggered = true;
        emit CircuitBreakerTriggered(this.getDeltaRatio(), block.timestamp);
        _emergencyUnwind();
    }

    /// @notice Set the guardian address
    /// @param _guardian New guardian address
    function setGuardian(address _guardian) external onlyOwner {
        address oldGuardian = guardian;
        guardian = _guardian;
        emit GuardianUpdated(oldGuardian, _guardian);
    }

    /// @notice Trigger circuit breaker manually
    /// @dev Can be called by owner or guardian in emergency situations
    function triggerCircuitBreaker() external {
        if (msg.sender != owner() && msg.sender != guardian) {
            revert Unauthorized(msg.sender);
        }
        circuitBreakerTriggered = true;
        _pause();
        emit CircuitBreakerTriggered(this.getDeltaRatio(), block.timestamp);
    }

    /// @notice Reset circuit breaker after emergency is resolved
    /// @dev Only owner can reset after verifying conditions are safe
    function resetCircuitBreaker() external onlyOwner {
        // Verify delta is within acceptable range before resetting
        int256 deltaRatio = this.getDeltaRatio();
        int256 absRatio = deltaRatio >= 0 ? deltaRatio : -deltaRatio;

        // Only allow reset if delta is below rebalance threshold
        require(uint256(absRatio) <= DELTA_THRESHOLD, "Delta still too high");

        circuitBreakerTriggered = false;
        emit CircuitBreakerReset(block.timestamp);
    }

    // ============ Internal Functions ============

    /// @notice Deploy capital to the delta-neutral strategy
    /// @dev To be implemented in Phase 4+5 with LP and hedge integration
    /// @param assets Amount of assets to deploy
    function _deployCapital(uint256 assets) internal {
        // Phase 3: No-op, assets remain idle
        // Phase 4+: Will deploy to Uniswap v3 LP position
        // Phase 5+: Will also open hedge on GMX v2

        emit CapitalDeployed(assets, 0, 0);
    }

    /// @notice Unwind capital from strategy for withdrawal
    /// @dev To be implemented in Phase 4+5 with LP and hedge integration
    /// @param assets Amount of assets to unwind
    function _unwindCapital(uint256 assets) internal {
        // Phase 3: No-op, assets are already idle
        // Phase 4+: Will remove liquidity from Uniswap v3
        // Phase 5+: Will also close proportional hedge

        emit CapitalWithdrawn(assets, 0, 0);
    }

    /// @notice Get LP position value
    /// @dev Queries LiquidityManager for position value
    function _getLPValue() internal view returns (uint256) {
        if (liquidityManager == address(0)) return 0;
        return ILiquidityManager(liquidityManager).getPositionValue();
    }

    /// @notice Get hedge position value
    /// @dev Queries HedgeManager for position value (collateral + unrealized PnL)
    function _getHedgeValue() internal view returns (uint256) {
        if (hedgeManager == address(0)) return 0;
        return IHedgeManager(hedgeManager).getPositionValue();
    }

    /// @notice Get LP position delta
    /// @dev Queries LiquidityManager for position delta
    function _getLPDelta() internal view returns (int256) {
        if (liquidityManager == address(0)) return 0;
        return ILiquidityManager(liquidityManager).getPositionDelta();
    }

    /// @notice Get hedge position delta (negative for shorts)
    /// @dev Queries HedgeManager for position delta
    function _getHedgeDelta() internal view returns (int256) {
        if (hedgeManager == address(0)) return 0;
        return IHedgeManager(hedgeManager).getPositionDelta();
    }

    /// @notice Execute rebalance
    /// @dev To be implemented in Phase 5+6
    function _executeRebalance(uint256 targetHedgeSize) internal {
        // Phase 3: No-op
        // Phase 5+6: Adjust hedge position to match LP delta
        (targetHedgeSize);
    }

    /// @notice Collect LP fees
    /// @dev Calls LiquidityManager to collect accumulated fees
    function _collectLPFees() internal returns (uint256 amount0, uint256 amount1) {
        if (liquidityManager == address(0)) return (0, 0);
        return ILiquidityManager(liquidityManager).collectFees();
    }

    /// @notice Calculate fees in USD
    /// @dev To be implemented in Phase 4
    function _calculateFeesInUSD(uint256 amount0, uint256 amount1) internal pure returns (uint256) {
        // Phase 3: Return 0
        // Phase 4+: Use price oracle to convert
        (amount0, amount1);
        return 0;
    }

    /// @notice Claim hedge funding
    /// @dev Calls HedgeManager to claim accumulated funding
    function _claimHedgeFunding() internal returns (int256) {
        if (hedgeManager == address(0)) return 0;
        return IHedgeManager(hedgeManager).claimFunding();
    }

    /// @notice Compound yield
    /// @dev To be implemented in Phase 6
    function _compoundYield() internal {
        // Phase 3: No-op
        // Phase 6+: Reinvest fees and funding
    }

    /// @notice Emergency unwind all positions
    /// @dev Closes all LP and hedge positions
    function _emergencyUnwind() internal {
        // Close LP position if exists
        if (liquidityManager != address(0)) {
            try ILiquidityManager(liquidityManager).closePosition() {} catch {}
        }
        // Close hedge position if exists
        if (hedgeManager != address(0)) {
            try IHedgeManager(hedgeManager).closeShort() {} catch {}
        }
    }

    /// @notice Check and potentially trigger circuit breaker based on delta
    function _checkAndTriggerCircuitBreaker() internal {
        if (!circuitBreakerEnabled) return; // Circuit breaker disabled
        if (circuitBreakerTriggered) return; // Already triggered

        int256 deltaRatio = this.getDeltaRatio();

        if (SecurityModule.checkEmergencyDelta(deltaRatio, EMERGENCY_THRESHOLD)) {
            circuitBreakerTriggered = true;
            _pause();
            emit CircuitBreakerTriggered(deltaRatio, block.timestamp);
        }
    }

    /// @notice Validate withdrawal size against limits
    /// @param assets Amount of assets to withdraw
    function _validateWithdrawalSize(uint256 assets) internal {
        uint256 total = totalAssets();
        if (total == 0) return;

        uint256 withdrawPercent = (assets * PRECISION) / total;

        // Check maximum single withdrawal
        if (withdrawPercent > MAX_SINGLE_WITHDRAWAL) {
            uint256 maxAllowed = (total * MAX_SINGLE_WITHDRAWAL) / PRECISION;
            revert WithdrawalTooLarge(assets, maxAllowed);
        }

        // Check large withdrawal cooldown
        if (withdrawPercent > LARGE_WITHDRAWAL_THRESHOLD) {
            if (
                !SecurityModule.checkRateLimit(lastLargeWithdrawalTime, LARGE_WITHDRAWAL_COOLDOWN)
            ) {
                uint256 cooldownEnd = lastLargeWithdrawalTime + LARGE_WITHDRAWAL_COOLDOWN;
                emit LargeWithdrawalCooldownEnforced(assets, cooldownEnd);
                revert WithdrawalCooldownActive(cooldownEnd);
            }
            lastLargeWithdrawalTime = block.timestamp;
        }
    }
}
