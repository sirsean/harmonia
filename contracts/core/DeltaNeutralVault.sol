// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ILiquidityManager} from "../interfaces/ILiquidityManager.sol";
import {IHedgeManager} from "../interfaces/IHedgeManager.sol";
import {SecurityModule} from "../libraries/SecurityModule.sol";
import {IUniswapV3Pool, ISwapRouter} from "../interfaces/IUniswapV3.sol";
import {DeltaCalculator} from "../libraries/DeltaCalculator.sol";

/// @title Delta Neutral Vault
/// @notice ERC-4626 vault that deploys capital into delta-neutral yield strategy
/// @dev Combines Uniswap v3 LP positions with GMX v2 perpetual hedging
contract DeltaNeutralVault is
    ERC4626Upgradeable,
    ReentrancyGuardUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
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

    /// @notice Maximum protocol fee in basis points (50%)
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 5000;

    // ============ State Variables ============

    /// @notice Address of the liquidity manager
    address public liquidityManager;

    /// @notice Address of the hedge manager
    address public hedgeManager;

    /// @notice Address of the rebalance controller
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
    bool public circuitBreakerEnabled;

    /// @notice Guardian address for emergency operations
    address public guardian;

    /// @notice Multiplier for tick range width during rebalance (default 20)
    int24 public rangeWidthMultiplier;

    /// @notice Protocol fee in basis points
    uint256 public protocolFeeBps;

    /// @notice Treasury address for protocol fees
    address public treasury;

    // ============ Gap for Upgradeability ============
    uint256[48] private __gap;

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

    /// @notice Emitted when range width multiplier is updated
    event RangeWidthMultiplierUpdated(int24 oldMultiplier, int24 newMultiplier);

    /// @notice Emitted when protocol fee is updated
    event ProtocolFeeUpdated(uint256 oldFee, uint256 newFee);

    /// @notice Emitted when treasury is updated
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    /// @notice Emitted when protocol fee is collected
    event ProtocolFeeCollected(uint256 assets, uint256 shares);

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

    // ============ Initializer ============

    /// @notice Initialize the vault with USDC as the underlying asset
    /// @param _asset Address of the underlying asset (USDC)
    /// @param _name Name of the vault token
    /// @param _symbol Symbol of the vault token
    /// @param _owner Address of the vault owner
    function initialize(
        IERC20 _asset,
        string memory _name,
        string memory _symbol,
        address _owner
    ) public initializer {
        if (address(_asset) == address(0)) revert ZeroAddress();

        __ERC20_init(_name, _symbol);
        __ERC4626_init(_asset);
        __ReentrancyGuard_init();
        __Ownable_init(_owner);
        __Pausable_init();
        __UUPSUpgradeable_init();

        circuitBreakerEnabled = true;
        rangeWidthMultiplier = 20;
    }

    /// @dev Authorize upgrade - only owner can upgrade
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

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

        // Deploy capital to strategy
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

        // Execute rebalance logic
        _executeRebalance(targetHedgeSize);

        int256 deltaAfter = getNetDelta();
        lastRebalanceTime = block.timestamp;

        emit Rebalanced(deltaBefore, deltaAfter, targetHedgeSize);
    }

    /// @notice Collect accrued fees from LP position
    /// @dev Called periodically to harvest yield
    function collectFees() external returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = _collectLPFees();

        uint256 totalUSD = _calculateFeesInUSD(amount0, amount1);
        totalFeesCollected += totalUSD;

        emit FeesCollected(amount0, amount1, totalUSD);
    }

    /// @notice Claim funding payments from perpetual position
    /// @dev Called periodically to realize funding income/expense
    function claimFunding() external returns (int256 fundingAmount) {
        fundingAmount = _claimHedgeFunding();
        totalFundingReceived += fundingAmount;

        emit FundingClaimed(fundingAmount);
    }

    /// @notice Compound collected yield back into strategy
    /// @dev Reinvests fees and funding into LP + hedge
    function compound() external whenNotPaused {
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

        // Approve managers to spend tokens
        if (_liquidityManager != address(0)) {
            address baseToken = ILiquidityManager(_liquidityManager).baseToken();
            address quoteToken = ILiquidityManager(_liquidityManager).quoteToken();

            IERC20(baseToken).forceApprove(_liquidityManager, type(uint256).max);
            IERC20(quoteToken).forceApprove(_liquidityManager, type(uint256).max);
        }
        if (_hedgeManager != address(0)) {
            IERC20(asset()).forceApprove(_hedgeManager, type(uint256).max);
        }

        emit ManagersUpdated(_liquidityManager, _hedgeManager, _rebalanceController);
    }

    /// @notice Set the range width multiplier for rebalancing
    /// @param _multiplier New multiplier (e.g. 20)
    function setRangeWidthMultiplier(int24 _multiplier) external onlyOwner {
        int24 old = rangeWidthMultiplier;
        rangeWidthMultiplier = _multiplier;
        emit RangeWidthMultiplierUpdated(old, _multiplier);
    }

    /// @notice Set the protocol fee
    /// @param _protocolFeeBps New fee in basis points
    function setProtocolFee(uint256 _protocolFeeBps) external onlyOwner {
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert("Fee too high");
        uint256 old = protocolFeeBps;
        protocolFeeBps = _protocolFeeBps;
        emit ProtocolFeeUpdated(old, _protocolFeeBps);
    }

    /// @notice Set the treasury address
    /// @param _treasury New treasury address
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
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
    /// @param assets Amount of assets to deploy
    function _deployCapital(uint256 assets) internal {
        if (liquidityManager == address(0) || hedgeManager == address(0)) {
            emit CapitalDeployed(assets, 0, 0);
            return;
        }

        // Reserve ~15% for hedge collateral (conservative estimate for 3x leverage with ~0.5 delta)
        uint256 collateralAmount = (assets * 15) / 100;
        uint256 lpAmount = assets - collateralAmount;

        // 1. Swap for LP
        _swapForLP(lpAmount);

        // 2. Deposit to LP

        address baseToken = ILiquidityManager(liquidityManager).baseToken();

        address quoteToken = ILiquidityManager(liquidityManager).quoteToken();

        // We need to know balances of this contract

        uint256 balBase = IERC20(baseToken).balanceOf(address(this));

        uint256 balQuote = IERC20(quoteToken).balanceOf(address(this));

        // Reserve collateral if it is one of the tokens (usually asset() which is quoteToken)

        if (baseToken == asset()) {
            if (balBase > collateralAmount) balBase -= collateralAmount;
            else balBase = 0;
        }

        if (quoteToken == asset()) {
            if (balQuote > collateralAmount) balQuote -= collateralAmount;
            else balQuote = 0;
        }

        if (balBase > 0 || balQuote > 0) {
            // Determine amount0 and amount1 based on address order

            uint256 amount0;

            uint256 amount1;

            if (baseToken < quoteToken) {
                amount0 = balBase;

                amount1 = balQuote;
            } else {
                amount0 = balQuote;

                amount1 = balBase;
            }

            // Check if position exists

            if (ILiquidityManager(liquidityManager).tokenId() != 0) {
                ILiquidityManager(liquidityManager).increaseLiquidity(
                    amount0,
                    amount1,
                    block.timestamp
                );
            } else {
                // Get ticks

                (int24 tickLower, int24 tickUpper) = ILiquidityManager(liquidityManager)
                    .getRebalanceTicks(rangeWidthMultiplier);

                ILiquidityManager(liquidityManager).mintPosition(
                    tickLower,
                    tickUpper,
                    amount0,
                    amount1,
                    block.timestamp
                );
            }
        }

        // 3. Adjust Hedge
        // Trigger rebalance to adjust hedge size to match new LP delta
        // Use 0 as targetHedgeSize to force calculation based on LP delta
        // _executeRebalance is internal, we can call it directly.
        _executeRebalance(0);

        emit CapitalDeployed(assets, _getLPValue(), _getHedgeValue());
    }

    /// @notice Helper to swap assets for LP provision
    /// @param amountIn Amount of asset() to potentially swap
    function _swapForLP(uint256 amountIn) internal {
        if (amountIn == 0) return;

        address liquidityMgr = liquidityManager;
        address pool = ILiquidityManager(liquidityMgr).getPool();
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();

        // Determine range
        int24 tickLower;
        int24 tickUpper;
        if (ILiquidityManager(liquidityMgr).tokenId() != 0) {
            (, tickLower, tickUpper, ) = ILiquidityManager(liquidityMgr).getPositionInfo();
        } else {
            (tickLower, tickUpper) = ILiquidityManager(liquidityMgr).getRebalanceTicks(
                rangeWidthMultiplier
            );
        }

        uint160 sqrtPriceLowerX96 = DeltaCalculator.getSqrtRatioAtTick(tickLower);
        uint160 sqrtPriceUpperX96 = DeltaCalculator.getSqrtRatioAtTick(tickUpper);

        // Simulate ratio
        uint128 dummyLiquidity = 1e18;
        uint256 amt0 = DeltaCalculator.getBaseTokenAmount(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            dummyLiquidity
        );
        uint256 amt1 = DeltaCalculator.getQuoteTokenAmount(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            dummyLiquidity
        );

        // Convert amt0 to quote value for ratio calculation
        // price = sqrtPrice^2 / 2^192
        // val0 = amt0 * price
        uint256 val0 = DeltaCalculator.mulDiv(
            amt0,
            uint256(sqrtPriceX96) * uint256(sqrtPriceX96),
            uint256(1) << 192
        );
        uint256 totalVal = val0 + amt1;

        if (totalVal == 0) return;

        // Calculate swap amount
        // If asset() is Quote Token (token1), we need to swap portion to Base Token (token0)
        // If asset() is Base Token (token0), we need to swap portion to Quote Token (token1)

        address assetToken = asset();
        address baseToken = ILiquidityManager(liquidityMgr).baseToken();
        address quoteToken = ILiquidityManager(liquidityMgr).quoteToken();

        uint256 swapAmount;
        address tokenIn = assetToken;
        address tokenOut;

        if (assetToken == quoteToken) {
            // We hold Quote, need Base
            // Portion needed in Base value is val0 / totalVal
            swapAmount = (amountIn * val0) / totalVal;
            tokenOut = baseToken;
        } else {
            // We hold Base, need Quote
            // Portion needed in Quote value is amt1 / totalVal (wait, amt1 is value1 since it's quote)
            // Value1 = amt1
            swapAmount = (amountIn * amt1) / totalVal;
            tokenOut = quoteToken;
        }

        if (swapAmount > 0) {
            ISwapRouter router = ILiquidityManager(liquidityMgr).swapRouter();

            IERC20(tokenIn).safeIncreaseAllowance(address(router), swapAmount);

            ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: ILiquidityManager(liquidityMgr).poolFee(),
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: swapAmount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            });

            router.exactInputSingle(params);
        }
    }

    /// @notice Unwind capital from strategy for withdrawal
    /// @param assets Amount of assets to unwind
    function _unwindCapital(uint256 assets) internal {
        if (liquidityManager == address(0) || hedgeManager == address(0)) {
            emit CapitalWithdrawn(assets, 0, 0);
            return;
        }

        uint256 total = totalAssets();
        if (total == 0) return;

        // Ratio to withdraw
        uint256 ratio = (assets * PRECISION) / total;

        // 1. Decrease LP
        uint128 currentLiquidity = ILiquidityManager(liquidityManager).liquidity();
        if (currentLiquidity > 0) {
            uint128 liquidityToRemove = uint128((uint256(currentLiquidity) * ratio) / PRECISION);
            if (liquidityToRemove > 0) {
                ILiquidityManager(liquidityManager).decreaseLiquidity(
                    liquidityToRemove,
                    block.timestamp
                );
                ILiquidityManager(liquidityManager).collectFees(); // Collect to vault
            }
        }

        // 2. Decrease Hedge
        // We need to reduce hedge size and collateral by `ratio`.
        uint256 sizeUsd = IHedgeManager(hedgeManager).getPositionSizeUsd();
        uint256 collateral = IHedgeManager(hedgeManager).getCollateralAmount();

        uint256 sizeDecrease = (sizeUsd * ratio) / PRECISION;
        uint256 collateralDecrease = (collateral * ratio) / PRECISION;

        if (sizeDecrease > 0) {
            uint256 execFee = IHedgeManager(hedgeManager).getExecutionFee();
            // Ensure we have enough ETH for execution fee
            if (address(this).balance >= execFee) {
                IHedgeManager(hedgeManager).decreaseShort{value: execFee}(
                    sizeDecrease,
                    collateralDecrease
                );
            }
        }

        // 3. Swap Base Token to Asset
        address baseToken = ILiquidityManager(liquidityManager).baseToken();
        address quoteToken = ILiquidityManager(liquidityManager).quoteToken();
        address assetToken = asset();

        address tokenToSell = (baseToken == assetToken) ? quoteToken : baseToken;
        uint256 balanceToSell = IERC20(tokenToSell).balanceOf(address(this));

        if (balanceToSell > 0) {
            ISwapRouter router = ILiquidityManager(liquidityManager).swapRouter();
            IERC20(tokenToSell).safeIncreaseAllowance(address(router), balanceToSell);

            ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenToSell,
                tokenOut: assetToken,
                fee: ILiquidityManager(liquidityManager).poolFee(),
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: balanceToSell,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            });

            router.exactInputSingle(params);
        }

        emit CapitalWithdrawn(assets, _getLPValue(), _getHedgeValue());
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
    /// @dev Handles both out-of-range recovery and delta rebalancing
    function _executeRebalance(uint256 targetHedgeSize) internal {
        // 1. Check if LP position is in range and adjust if needed
        if (liquidityManager != address(0)) {
            bool inRange = ILiquidityManager(liquidityManager).isInRange();

            if (!inRange) {
                // Determine new ticks
                (int24 newTickLower, int24 newTickUpper) = ILiquidityManager(liquidityManager)
                    .getRebalanceTicks(rangeWidthMultiplier);

                // Adjust range (close current, mint new)
                ILiquidityManager(liquidityManager).adjustRange(
                    newTickLower,
                    newTickUpper,
                    block.timestamp
                );
            }
        }

        // 2. Adjust hedge to match new LP delta
        // If targetHedgeSize is provided (non-zero), use it. Otherwise calculate.
        uint256 hedgeTarget = targetHedgeSize;

        if (hedgeTarget == 0 && liquidityManager != address(0) && hedgeManager != address(0)) {
            int256 lpDelta = ILiquidityManager(liquidityManager).getPositionDelta();

            // If LP delta is positive (long exposure), we need to short
            if (lpDelta > 0) {
                uint256 price = ILiquidityManager(liquidityManager).getOraclePrice();
                uint256 deltaAbs = uint256(lpDelta);
                address baseToken = ILiquidityManager(liquidityManager).baseToken();
                uint8 decimals = IERC20Metadata(baseToken).decimals();

                if (decimals <= 30) {
                    // Calculate adjustment to reach 30 decimals
                    // ValueUSD = (TokenAmount * Price) / 10^decimals
                    // Price is 18 decimals
                    // SizeUSD = (TokenAmount * Price * 10^30) / (10^decimals * 10^18)
                    // SizeUSD = (TokenAmount * Price * 10^12) / 10^decimals

                    if (decimals <= 12) {
                        hedgeTarget = deltaAbs * price * (10 ** (12 - decimals));
                    } else {
                        hedgeTarget = (deltaAbs * price) / (10 ** (decimals - 12));
                    }
                }
            } else {
                // If LP delta is negative or zero, we don't want a short hedge
                hedgeTarget = 0;
            }
        }

        if (hedgeManager != address(0)) {
            uint256 execFee = IHedgeManager(hedgeManager).getExecutionFee();
            // Ensure we have enough ETH
            if (address(this).balance >= execFee) {
                IHedgeManager(hedgeManager).adjustHedge{value: execFee}(hedgeTarget);
            } else {
                // If not enough ETH, try without value (will fail if fee > 0, but allows testing if fee is 0)
                // Or revert? Reverting is safer to notice the issue.
                // However, for robustness, we might want to wrap WETH if we have it?
                // For now, revert if insufficient ETH for fee.
                revert("Insufficient ETH for execution fee");
            }
        }
    }

    /// @notice Allow vault to receive ETH for execution fees
    receive() external payable {}

    /// @notice Collect LP fees
    /// @dev Calls LiquidityManager to collect accumulated fees
    function _collectLPFees() internal returns (uint256 amount0, uint256 amount1) {
        if (liquidityManager == address(0)) return (0, 0);
        return ILiquidityManager(liquidityManager).collectFees();
    }

    /// @notice Calculate fees in USD
    function _calculateFeesInUSD(uint256 amount0, uint256 amount1) internal view returns (uint256) {
        if (liquidityManager == address(0)) return 0;

        // Assume price is 18 decimals, Base/USD (or Quote/USD if Quote is volatile, but here Quote is USDC)
        // Usually Oracle is for Base Token (ETH). Quote is USDC ($1).
        // Check tokens
        address baseToken = ILiquidityManager(liquidityManager).baseToken();
        address quoteToken = ILiquidityManager(liquidityManager).quoteToken();

        // Get decimals
        uint8 d0 = IERC20Metadata(baseToken).decimals();
        uint8 d1 = IERC20Metadata(quoteToken).decimals();

        uint256 price = ILiquidityManager(liquidityManager).getOraclePrice(); // 18 decimals

        uint256 value0;
        uint256 value1;

        // We need to know which one is Base.
        address token0;
        if (baseToken < quoteToken) token0 = baseToken;
        else token0 = quoteToken;

        if (token0 == baseToken) {
            // amount0 is Base
            // Value0 = amount0 * price / 10^d0
            value0 = (amount0 * price) / (10 ** d0);

            // Value1 = amount1 (USDC)
            // Scale to 18 decimals: amount1 * 10^(18-d1)
            if (d1 <= 18) value1 = amount1 * (10 ** (18 - d1));
            else value1 = amount1 / (10 ** (d1 - 18));
        } else {
            // amount0 is Quote
            if (d0 <= 18) value0 = amount0 * (10 ** (18 - d0));
            else value0 = amount0 / (10 ** (d0 - 18));

            // amount1 is Base
            value1 = (amount1 * price) / (10 ** d1);
        }

        return value0 + value1;
    }

    /// @notice Claim hedge funding
    /// @dev Calls HedgeManager to claim accumulated funding
    function _claimHedgeFunding() internal returns (int256) {
        if (hedgeManager == address(0)) return 0;
        return IHedgeManager(hedgeManager).claimFunding();
    }

    /// @notice Compound yield
    function _compoundYield() internal {
        // Only compound if strategy is active (managers set)
        if (liquidityManager == address(0)) return;

        // Reinvest idle assets
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle > 0) {
            // Calculate and mint protocol fee
            if (protocolFeeBps > 0 && treasury != address(0)) {
                uint256 feeAssets = (idle * protocolFeeBps) / 10000;
                if (feeAssets > 0) {
                    uint256 feeShares = convertToShares(feeAssets);
                    if (feeShares > 0) {
                        _mint(treasury, feeShares);
                        emit ProtocolFeeCollected(feeAssets, feeShares);
                    }
                }
            }

            _deployCapital(idle);
        }
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
