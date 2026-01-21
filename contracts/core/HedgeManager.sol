// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IExchangeRouter, IDataStore, GMXPositionUtils} from "../interfaces/IGMXV2.sol";
import {IHedgeManager} from "../interfaces/IHedgeManager.sol";
import {IChainlinkPriceFeed} from "../interfaces/IChainlink.sol";
import {SecurityModule} from "../libraries/SecurityModule.sol";

/// @title Hedge Manager
/// @notice Manages GMX v2 perpetual short positions for delta hedging
/// @dev Handles opening, adjusting, and closing short positions on GMX v2
contract HedgeManager is
    IHedgeManager,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Precision for percentage calculations (1e18 = 100%)
    uint256 public constant PRECISION = 1e18;

    /// @notice GMX USD precision (30 decimals)
    uint256 public constant GMX_USD_PRECISION = 1e30;

    /// @notice GMX V2 DataStore Keys
    bytes32 public constant POSITION_SIZE_IN_USD = keccak256(abi.encode("POSITION_SIZE_IN_USD"));
    bytes32 public constant POSITION_SIZE_IN_TOKENS = keccak256(abi.encode("POSITION_SIZE_IN_TOKENS"));
    bytes32 public constant POSITION_COLLATERAL_AMOUNT = keccak256(abi.encode("POSITION_COLLATERAL_AMOUNT"));
    bytes32 public constant POSITION_FUNDING_FEE_AMOUNT = keccak256(abi.encode("POSITION_FUNDING_FEE_AMOUNT"));

    /// @notice Default acceptable price slippage (1% = 1e16)
    uint256 public constant DEFAULT_SLIPPAGE = 1e16;

    // ============ Storage Variables (Converted from Immutables) ============

    /// @notice GMX v2 Exchange Router
    IExchangeRouter public exchangeRouter;

    /// @notice GMX v2 market address (e.g., ETH/USD market)
    address public override market;

    /// @notice Collateral token (e.g., USDC)
    address public override collateralToken;

    /// @notice Index token being hedged (e.g., WETH)
    address public override indexToken;

    /// @notice Chainlink price feed for index token
    IChainlinkPriceFeed public priceFeed;

    // ============ State Variables ============

    /// @notice Maximum leverage allowed (default 3x)
    uint256 public maxLeverage;

    /// @notice Minimum position size in USD (default $100)
    uint256 public minPositionSize;

    /// @notice Maximum oracle staleness for price feeds (default 1 hour)
    uint256 public maxOracleStaleness;

    /// @notice Emergency leverage threshold (default 2.8x)
    uint256 public emergencyLeverageThreshold;

    /// @notice Address of the vault that owns this manager
    address public override vault;

    /// @notice Total funding received (positive) or paid (negative)
    int256 public override totalFundingReceived;

    /// @notice Total collateral deposited across all operations
    uint256 public override totalCollateralDeposited;

    /// @notice Acceptable price slippage for orders
    uint256 public slippageTolerance;

    /// @notice Execution fee for GMX orders (in ETH)
    uint256 public executionFeeOverride;

    /// @notice Last order key created
    bytes32 public lastOrderKey;

    /// @notice GMX Order Vault address
    address public orderVault;

    // ============ Gap for Upgradeability ============
    uint256[49] private __gap;

    // ============ Events ============

    /// @notice Emitted when a short position is opened
    event ShortOpened(bytes32 indexed orderKey, uint256 sizeDeltaUsd, uint256 collateralAmount);

    /// @notice Emitted when a short position is increased
    event ShortIncreased(bytes32 indexed orderKey, uint256 sizeDeltaUsd, uint256 collateralAmount);

    /// @notice Emitted when a short position is decreased
    event ShortDecreased(bytes32 indexed orderKey, uint256 sizeDeltaUsd, uint256 collateralAmount);

    /// @notice Emitted when a short position is closed
    event ShortClosed(bytes32 indexed orderKey);

    /// @notice Emitted when hedge is adjusted
    event HedgeAdjusted(bytes32 indexed orderKey, uint256 oldSizeUsd, uint256 newTargetSizeUsd);

    /// @notice Emitted when funding is claimed
    event FundingClaimed(int256 amount);

    /// @notice Emitted when vault address is updated
    event VaultUpdated(address indexed oldVault, address indexed newVault);

    /// @notice Emitted when slippage tolerance is updated
    event SlippageToleranceUpdated(uint256 oldSlippage, uint256 newSlippage);

    /// @notice Emitted when execution fee override is updated
    event ExecutionFeeUpdated(uint256 oldFee, uint256 newFee);

    /// @notice Emitted when max leverage is updated
    event MaxLeverageUpdated(uint256 oldLeverage, uint256 newLeverage);

    /// @notice Emitted when min position size is updated
    event MinPositionSizeUpdated(uint256 oldSize, uint256 newSize);

    /// @notice Emitted when max oracle staleness is updated
    event MaxOracleStalenessUpdated(uint256 oldStaleness, uint256 newStaleness);

    /// @notice Emitted when emergency leverage threshold is updated
    event EmergencyLeverageThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    /// @notice Emitted when order vault is updated
    event OrderVaultUpdated(address oldVault, address newVault);
    event ExchangeRouterUpdated(address indexed oldRouter, address indexed newRouter);

    // ============ Errors ============

    /// @notice Thrown when caller is not the vault
    error OnlyVault();

    /// @notice Thrown when position already exists
    error PositionExists();

    /// @notice Thrown when no position exists
    error NoPosition();

    /// @notice Thrown when position size is too small
    error PositionTooSmall();

    /// @notice Thrown when leverage exceeds maximum
    error LeverageTooHigh();

    /// @notice Thrown when zero amount provided
    error ZeroAmount();

    /// @notice Thrown when zero address provided
    error ZeroAddress();

    /// @notice Thrown when slippage is too high
    error SlippageTooHigh();

    /// @notice Thrown when insufficient execution fee
    error InsufficientExecutionFee();

    /// @notice Thrown when ETH transfer fails
    error ETHTransferFailed();

    /// @notice Thrown when leverage approaches liquidation threshold
    error LeverageApproachingLiquidation(uint256 currentLeverage);

    // ============ Modifiers ============

    /// @notice Restricts function to vault or owner
    modifier onlyVaultOrOwner() {
        if (msg.sender != vault && msg.sender != owner()) {
            revert OnlyVault();
        }
        _;
    }

    // ============ Initializer ============

    /// @notice Initialize the hedge manager
    /// @param _exchangeRouter GMX v2 Exchange Router address
    /// @param _market GMX v2 market address
    /// @param _collateralToken Collateral token address (e.g., USDC)
    /// @param _indexToken Index token address (e.g., WETH)
    /// @param _priceFeed Chainlink price feed for index token
    /// @param _owner Owner address
    function initialize(
        address _exchangeRouter,
        address _market,
        address _collateralToken,
        address _indexToken,
        address _priceFeed,
        address _owner
    ) public initializer {
        if (_exchangeRouter == address(0)) revert ZeroAddress();
        if (_market == address(0)) revert ZeroAddress();
        if (_collateralToken == address(0)) revert ZeroAddress();
        if (_indexToken == address(0)) revert ZeroAddress();
        if (_priceFeed == address(0)) revert ZeroAddress();

        __Ownable_init(_owner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        exchangeRouter = IExchangeRouter(_exchangeRouter);
        market = _market;
        collateralToken = _collateralToken;
        indexToken = _indexToken;
        priceFeed = IChainlinkPriceFeed(_priceFeed);
        slippageTolerance = DEFAULT_SLIPPAGE;

        // Initialize configurable parameters
        maxLeverage = 3e18; // 3x
        minPositionSize = 100 * GMX_USD_PRECISION; // $100
        maxOracleStaleness = 1 hours;
        emergencyLeverageThreshold = 28e17; // 2.8x
    }

    /// @dev Authorize upgrade - only owner can upgrade
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ============ External Functions ============

    /// @notice Set the vault address
    /// @param _vault New vault address
    function setVault(address _vault) external onlyOwner {
        if (_vault == address(0)) revert ZeroAddress();
        address oldVault = vault;
        vault = _vault;
        emit VaultUpdated(oldVault, _vault);
    }

    /// @notice Set slippage tolerance
    /// @param _slippageTolerance New slippage tolerance (scaled by 1e18)
    function setSlippageTolerance(uint256 _slippageTolerance) external onlyOwner {
        if (_slippageTolerance > 5e16) revert SlippageTooHigh(); // Max 5%
        uint256 oldSlippage = slippageTolerance;
        slippageTolerance = _slippageTolerance;
        emit SlippageToleranceUpdated(oldSlippage, _slippageTolerance);
    }

    /// @notice Set execution fee override
    /// @param _fee New execution fee (0 to use GMX default)
    function setExecutionFeeOverride(uint256 _fee) external onlyOwner {
        uint256 oldFee = executionFeeOverride;
        executionFeeOverride = _fee;
        emit ExecutionFeeUpdated(oldFee, _fee);
    }

    /// @notice Set max leverage
    /// @param _maxLeverage New max leverage (scaled by 1e18)
    function setMaxLeverage(uint256 _maxLeverage) external onlyOwner {
        uint256 old = maxLeverage;
        maxLeverage = _maxLeverage;
        emit MaxLeverageUpdated(old, _maxLeverage);
    }

    /// @notice Set minimum position size
    /// @param _minPositionSize New minimum position size (in USD 30 decimals)
    function setMinPositionSize(uint256 _minPositionSize) external onlyOwner {
        uint256 old = minPositionSize;
        minPositionSize = _minPositionSize;
        emit MinPositionSizeUpdated(old, _minPositionSize);
    }

    /// @notice Set max oracle staleness
    /// @param _maxOracleStaleness New max staleness in seconds
    function setMaxOracleStaleness(uint256 _maxOracleStaleness) external onlyOwner {
        uint256 old = maxOracleStaleness;
        maxOracleStaleness = _maxOracleStaleness;
        emit MaxOracleStalenessUpdated(old, _maxOracleStaleness);
    }

    /// @notice Set emergency leverage threshold
    /// @param _threshold New emergency leverage threshold (scaled by 1e18)
    function setEmergencyLeverageThreshold(uint256 _threshold) external onlyOwner {
        uint256 old = emergencyLeverageThreshold;
        emergencyLeverageThreshold = _threshold;
        emit EmergencyLeverageThresholdUpdated(old, _threshold);
    }

    /// @notice Set GMX Order Vault address
    /// @param _orderVault New order vault address
    function setOrderVault(address _orderVault) external onlyOwner {
        if (_orderVault == address(0)) revert ZeroAddress();
        address old = orderVault;
        orderVault = _orderVault;
        emit OrderVaultUpdated(old, _orderVault);
    }

    /// @notice Set GMX Exchange Router address
    /// @param _exchangeRouter New exchange router address
    function setExchangeRouter(address _exchangeRouter) external onlyOwner {
        if (_exchangeRouter == address(0)) revert ZeroAddress();
        address old = address(exchangeRouter);
        exchangeRouter = IExchangeRouter(_exchangeRouter);
        emit ExchangeRouterUpdated(old, _exchangeRouter);
    }

    /// @inheritdoc IHedgeManager
    function openShort(
        uint256 sizeDeltaUsd,
        uint256 collateralAmount
    ) external payable override onlyVaultOrOwner nonReentrant returns (bytes32 orderKey) {
        if (hasPosition()) revert PositionExists();
        if (sizeDeltaUsd < minPositionSize) revert PositionTooSmall();
        if (collateralAmount == 0) revert ZeroAmount();

        // Check leverage
        _validateLeverage(sizeDeltaUsd, collateralAmount);

        // Transfer collateral from caller
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);

        // Create the order
        orderKey = _createOrder(
            IExchangeRouter.OrderType.MarketIncrease,
            sizeDeltaUsd,
            collateralAmount,
            false // isLong = false for shorts
        );

        totalCollateralDeposited += collateralAmount;

        emit ShortOpened(orderKey, sizeDeltaUsd, collateralAmount);
    }

    /// @inheritdoc IHedgeManager
    function increaseShort(
        uint256 sizeDeltaUsd,
        uint256 collateralAmount
    ) external payable override onlyVaultOrOwner nonReentrant returns (bytes32 orderKey) {
        if (!hasPosition()) revert NoPosition();
        if (sizeDeltaUsd == 0 && collateralAmount == 0) revert ZeroAmount();

        uint256 currentSize = getPositionSizeUsd();
        uint256 currentCollateral = getCollateralAmount();
        uint256 newSize = currentSize + sizeDeltaUsd;
        uint256 newCollateral = currentCollateral + collateralAmount;

        // Check leverage after increase
        _validateLeverage(newSize, newCollateral);

        // Transfer additional collateral if provided
        if (collateralAmount > 0) {
            IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);
            totalCollateralDeposited += collateralAmount;
        }

        orderKey = _createOrder(
            IExchangeRouter.OrderType.MarketIncrease,
            sizeDeltaUsd,
            collateralAmount,
            false
        );

        emit ShortIncreased(orderKey, sizeDeltaUsd, collateralAmount);
    }

    /// @inheritdoc IHedgeManager
    function decreaseShort(
        uint256 sizeDeltaUsd,
        uint256 collateralAmount
    ) external payable override onlyVaultOrOwner nonReentrant returns (bytes32 orderKey) {
        if (!hasPosition()) revert NoPosition();

        uint256 currentSize = getPositionSizeUsd();
        if (sizeDeltaUsd > currentSize) {
            sizeDeltaUsd = currentSize; // Cap at current size
        }

        orderKey = _createOrder(
            IExchangeRouter.OrderType.MarketDecrease,
            sizeDeltaUsd,
            collateralAmount,
            false
        );

        emit ShortDecreased(orderKey, sizeDeltaUsd, collateralAmount);
    }

    /// @inheritdoc IHedgeManager
    function closeShort()
        external
        payable
        override
        onlyVaultOrOwner
        nonReentrant
        returns (bytes32 orderKey)
    {
        if (!hasPosition()) revert NoPosition();

        uint256 currentSize = getPositionSizeUsd();

        orderKey = _createOrder(
            IExchangeRouter.OrderType.MarketDecrease,
            currentSize,
            0, // Withdraw all collateral
            false
        );

        emit ShortClosed(orderKey);
    }

    /// @inheritdoc IHedgeManager
    function adjustHedge(
        uint256 targetDeltaUsd
    ) external payable override onlyVaultOrOwner nonReentrant returns (bytes32 orderKey) {
        uint256 currentSize = getPositionSizeUsd();

        emit HedgeAdjusted(orderKey, currentSize, targetDeltaUsd);

        if (targetDeltaUsd > currentSize) {
            // Need to increase position
            uint256 sizeDelta = targetDeltaUsd - currentSize;

            // Calculate required collateral for the increase
            uint256 additionalCollateral = _calculateRequiredCollateral(sizeDelta);

            if (!hasPosition()) {
                // Open new position
                if (targetDeltaUsd < minPositionSize) revert PositionTooSmall();

                IERC20(collateralToken).safeTransferFrom(
                    msg.sender,
                    address(this),
                    additionalCollateral
                );
                totalCollateralDeposited += additionalCollateral;

                orderKey = _createOrder(
                    IExchangeRouter.OrderType.MarketIncrease,
                    targetDeltaUsd,
                    additionalCollateral,
                    false
                );

                emit ShortOpened(orderKey, targetDeltaUsd, additionalCollateral);
            } else {
                // Increase existing position
                IERC20(collateralToken).safeTransferFrom(
                    msg.sender,
                    address(this),
                    additionalCollateral
                );
                totalCollateralDeposited += additionalCollateral;

                orderKey = _createOrder(
                    IExchangeRouter.OrderType.MarketIncrease,
                    sizeDelta,
                    additionalCollateral,
                    false
                );

                emit ShortIncreased(orderKey, sizeDelta, additionalCollateral);
            }
        } else if (targetDeltaUsd < currentSize) {
            // Need to decrease position
            uint256 sizeDelta = currentSize - targetDeltaUsd;

            if (targetDeltaUsd == 0) {
                // Close position entirely
                orderKey = _createOrder(
                    IExchangeRouter.OrderType.MarketDecrease,
                    currentSize,
                    0,
                    false
                );
                emit ShortClosed(orderKey);
            } else {
                // Partial decrease
                orderKey = _createOrder(
                    IExchangeRouter.OrderType.MarketDecrease,
                    sizeDelta,
                    0, // Keep collateral ratio
                    false
                );
                emit ShortDecreased(orderKey, sizeDelta, 0);
            }
        }
        // If targetDeltaUsd == currentSize, no action needed
    }

    /// @inheritdoc IHedgeManager
    function claimFunding() external override onlyVaultOrOwner returns (int256 fundingAmount) {
        address[] memory markets = new address[](1);
        markets[0] = market;

        address[] memory tokens = new address[](1);
        tokens[0] = collateralToken;

        uint256[] memory amounts = exchangeRouter.claimFundingFees(markets, tokens, vault);

        fundingAmount = int256(amounts[0]);
        totalFundingReceived += fundingAmount;

        emit FundingClaimed(fundingAmount);
    }

    // ============ View Functions ============

    /// @inheritdoc IHedgeManager
    function getPositionSizeUsd() public view override returns (uint256 sizeUsd) {
        bytes32 positionKey = getPositionKey();
        IDataStore dataStore = IDataStore(exchangeRouter.dataStore());

        // GMX stores position size at specific key
        bytes32 sizeKey = keccak256(abi.encode(POSITION_SIZE_IN_USD, positionKey));
        sizeUsd = dataStore.getUint(sizeKey);
    }

    /// @inheritdoc IHedgeManager
    function getPositionSizeTokens() public view override returns (uint256 sizeTokens) {
        bytes32 positionKey = getPositionKey();
        IDataStore dataStore = IDataStore(exchangeRouter.dataStore());

        bytes32 sizeKey = keccak256(abi.encode(POSITION_SIZE_IN_TOKENS, positionKey));
        sizeTokens = dataStore.getUint(sizeKey);
    }

    /// @inheritdoc IHedgeManager
    function getCollateralAmount() public view override returns (uint256 collateral) {
        bytes32 positionKey = getPositionKey();
        IDataStore dataStore = IDataStore(exchangeRouter.dataStore());

        bytes32 collateralKey = keccak256(abi.encode(POSITION_COLLATERAL_AMOUNT, positionKey));
        collateral = dataStore.getUint(collateralKey);
    }

    /// @inheritdoc IHedgeManager
    function getPositionValue() public view override returns (uint256 value) {
        uint256 collateral = getCollateralAmount();
        int256 pnl = getUnrealizedPnL();

        // Position value = collateral + unrealized PnL
        if (pnl >= 0) {
            value = collateral + uint256(pnl);
        } else {
            uint256 loss = uint256(-pnl);
            value = collateral > loss ? collateral - loss : 0;
        }
    }

    /// @inheritdoc IHedgeManager
    function getPositionDelta() public view override returns (int256 delta) {
        // Short position delta is negative
        // Delta = -(size in tokens)
        uint256 sizeTokens = getPositionSizeTokens();
        delta = -int256(sizeTokens);
    }

    /// @inheritdoc IHedgeManager
    function getUnrealizedPnL() public view override returns (int256 pnl) {
        if (!hasPosition()) return 0;

        uint256 sizeUsd = getPositionSizeUsd();
        uint256 sizeTokens = getPositionSizeTokens();

        if (sizeTokens == 0) return 0;

        // Get current price (use unchecked for view function)
        uint256 currentPrice = _getCurrentPriceUnchecked();

        // Entry price = sizeUsd / sizeTokens (in GMX precision)
        uint256 entryPrice = (sizeUsd * PRECISION) / sizeTokens;

        // For shorts: PnL = (entryPrice - currentPrice) * sizeTokens / PRECISION
        // Profit when price goes down, loss when price goes up
        if (currentPrice < entryPrice) {
            pnl = int256(((entryPrice - currentPrice) * sizeTokens) / PRECISION);
        } else {
            pnl = -int256(((currentPrice - entryPrice) * sizeTokens) / PRECISION);
        }

        // Convert to collateral token decimals (assuming 6 decimals for USDC)
        pnl = pnl / int256(1e12); // Convert from 18 to 6 decimals
    }

    /// @inheritdoc IHedgeManager
    function getAccumulatedFunding() public view override returns (int256 fundingAmount) {
        bytes32 positionKey = getPositionKey();
        IDataStore dataStore = IDataStore(exchangeRouter.dataStore());

        bytes32 fundingKey = keccak256(abi.encode(POSITION_FUNDING_FEE_AMOUNT, positionKey));
        fundingAmount = dataStore.getInt(fundingKey);
    }

    /// @inheritdoc IHedgeManager
    function getCurrentLeverage() public view override returns (uint256 leverage) {
        uint256 sizeUsd = getPositionSizeUsd();
        uint256 collateral = getCollateralAmount();

        if (collateral == 0) return 0;

        // Convert collateral to USD (30 decimals)
        // Assuming collateral is in 6 decimals (USDC)
        uint256 collateralUsd = collateral * 1e24; // 6 -> 30 decimals

        leverage = (sizeUsd * PRECISION) / collateralUsd;
    }

    /// @inheritdoc IHedgeManager
    function hasPosition() public view override returns (bool exists) {
        return getPositionSizeUsd() > 0;
    }

    /// @inheritdoc IHedgeManager
    function getPositionKey() public view override returns (bytes32 key) {
        return
            GMXPositionUtils.getPositionKey(
                address(this),
                market,
                collateralToken,
                false // isLong = false for shorts
            );
    }

    /// @inheritdoc IHedgeManager
    function getExecutionFee() public view override returns (uint256 fee) {
        if (executionFeeOverride > 0) {
            return executionFeeOverride;
        }
        // Default execution fee (can be queried from GMX DataStore in production)
        return 0.001 ether;
    }

    // ============ Internal Functions ============

    /// @notice Create an order on GMX v2
    function _createOrder(
        IExchangeRouter.OrderType orderType,
        uint256 sizeDeltaUsd,
        uint256 collateralDeltaAmount,
        bool isLong
    ) internal returns (bytes32 orderKey) {
        uint256 execFee = getExecutionFee();
        if (msg.value < execFee) revert InsufficientExecutionFee();

        // Approve collateral to router and send to order vault
        if (collateralDeltaAmount > 0) {
            if (orderVault == address(0)) revert ZeroAddress();
            address router = exchangeRouter.router();
            if (router != address(0)) {
                IERC20(collateralToken).safeIncreaseAllowance(router, collateralDeltaAmount);
            }
            IERC20(collateralToken).safeIncreaseAllowance(
                address(exchangeRouter),
                collateralDeltaAmount
            );
            exchangeRouter.sendTokens(collateralToken, orderVault, collateralDeltaAmount);
        }

        // Calculate acceptable price with slippage
        uint256 currentPrice = _getCurrentPrice12();
        uint256 acceptablePrice;

        if (orderType == IExchangeRouter.OrderType.MarketIncrease && !isLong) {
            // Opening/increasing short (Selling): acceptablePrice is MINIMUM price
            acceptablePrice = (currentPrice * (PRECISION - slippageTolerance)) / PRECISION;
        } else if (orderType == IExchangeRouter.OrderType.MarketDecrease && !isLong) {
            // Closing/decreasing short (Buying): acceptablePrice is MAXIMUM price
            acceptablePrice = (currentPrice * (PRECISION + slippageTolerance)) / PRECISION;
        } else {
            acceptablePrice = currentPrice;
        }

        // Determine receiver
        // For Increase: we (HedgeManager) must receive the position to manage it
        // For Decrease: the vault should receive the withdrawn collateral
        address orderReceiver;
        if (
            orderType == IExchangeRouter.OrderType.MarketIncrease ||
            orderType == IExchangeRouter.OrderType.LimitIncrease
        ) {
            orderReceiver = address(this);
        } else {
            orderReceiver = vault != address(0) ? vault : msg.sender;
        }

        if (orderVault == address(0)) revert ZeroAddress();
        // Send execution fee to order vault
        exchangeRouter.sendWnt{value: execFee}(orderVault, execFee);

        // Create order params
        IExchangeRouter.CreateOrderParams memory params = IExchangeRouter.CreateOrderParams({
            addresses: IExchangeRouter.CreateOrderParamsAddresses({
                receiver: orderReceiver,
                cancellationReceiver: address(this),
                callbackContract: address(0),
                uiFeeReceiver: address(0),
                market: market,
                initialCollateralToken: collateralToken,
                swapPath: new address[](0)
            }),
            numbers: IExchangeRouter.CreateOrderParamsNumbers({
                sizeDeltaUsd: sizeDeltaUsd,
                initialCollateralDeltaAmount: collateralDeltaAmount,
                triggerPrice: 0,
                acceptablePrice: acceptablePrice,
                executionFee: execFee,
                callbackGasLimit: 0,
                minOutputAmount: 0,
                validFromTime: 0
            }),
            orderType: orderType,
            decreasePositionSwapType: IExchangeRouter.DecreasePositionSwapType.NoSwap,
            isLong: isLong,
            shouldUnwrapNativeToken: false,
            autoCancel: false,
            referralCode: bytes32(0),
            dataList: new bytes32[](0)
        });

        // Create the order
        orderKey = exchangeRouter.createOrder(params);
        lastOrderKey = orderKey;

        // Refund excess ETH
        if (msg.value > execFee) {
            (bool success, ) = msg.sender.call{value: msg.value - execFee}("");
            if (!success) revert ETHTransferFailed();
        }
    }

    /// @notice Validate leverage is within limits
    function _validateLeverage(uint256 sizeUsd, uint256 collateralAmount) internal view {
        if (collateralAmount == 0) revert ZeroAmount();

        // Convert collateral to USD (30 decimals)
        // Assuming collateral is in 6 decimals (USDC)
        uint256 collateralUsd = collateralAmount * 1e24;

        uint256 leverage = (sizeUsd * PRECISION) / collateralUsd;

        if (leverage > maxLeverage) revert LeverageTooHigh();
    }

    /// @notice Calculate required collateral for a position size
    function _calculateRequiredCollateral(uint256 sizeDeltaUsd) internal view returns (uint256) {
        // Target 2x leverage by default
        uint256 targetLeverage = 2e18;

        // collateral (in USD 30 decimals) = size / leverage
        uint256 collateralUsd = (sizeDeltaUsd * PRECISION) / targetLeverage;
        uint256 requiredAmount = collateralUsd / 1e24; // 6 decimals

        // Check available balance of the payer (msg.sender, usually the vault)
        uint256 available = IERC20(collateralToken).balanceOf(msg.sender);

        if (requiredAmount > available) {
            // Check if available collateral allows us to stay within maxLeverage
            // minCollateral = size / maxLeverage
            uint256 minCollateralUsd = (sizeDeltaUsd * PRECISION) / maxLeverage;
            uint256 minCollateral = minCollateralUsd / 1e24;

            if (available >= minCollateral) {
                // Use what we have
                return available;
            }
            // If not enough even for maxLeverage, returns available (will likely fail on GMX or _validateLeverage)
            return available;
        }

        return requiredAmount;
    }

    /// @notice Get current price from price feed with full validation
    function _getCurrentPrice12() internal view returns (uint256) {
        // Use SecurityModule for comprehensive oracle validation
        uint256 price = SecurityModule.getOraclePriceWithStalenessCheck(
            priceFeed,
            maxOracleStaleness
        );

        // Convert to 12 decimals for GMX acceptablePrice
        // Chainlink ETH/USD has 8 decimals
        return price * 1e4;
    }

    /// @notice Get current price without staleness check (for view functions)
    /// @dev Used in view functions where we want to return a value even if stale
    function _getCurrentPriceUnchecked() internal view returns (uint256) {
        (, int256 answer, , , ) = priceFeed.latestRoundData();
        if (answer <= 0) {
            revert SecurityModule.InvalidOraclePrice(answer);
        }

        // Convert to 30 decimals (GMX precision)
        // Chainlink ETH/USD has 8 decimals
        return uint256(answer) * 1e22;
    }

    /// @notice Check if oracle price is stale
    /// @return isStale True if price is older than maxOracleStaleness
    function isOracleStale() external view returns (bool isStale) {
        (, , , uint256 updatedAt, ) = priceFeed.latestRoundData();
        return block.timestamp - updatedAt > maxOracleStaleness;
    }

    /// @notice Get oracle last update timestamp
    /// @return timestamp Last update time
    function getOracleLastUpdate() external view returns (uint256 timestamp) {
        (, , , timestamp, ) = priceFeed.latestRoundData();
    }

    /// @notice Check if leverage is approaching liquidation threshold
    /// @return isApproaching True if leverage is above emergency threshold
    function isLeverageApproachingLiquidation() external view returns (bool isApproaching) {
        uint256 currentLeverage = getCurrentLeverage();
        return currentLeverage > emergencyLeverageThreshold;
    }

    /// @notice Get the distance to liquidation as a percentage
    /// @return margin Remaining margin percentage (scaled by 1e18)
    function getLiquidationMargin() external view returns (uint256 margin) {
        uint256 currentLeverage = getCurrentLeverage();
        if (currentLeverage == 0) return PRECISION; // 100% margin if no position

        // Liquidation happens around 100x leverage for GMX
        // Return how far we are from max leverage as a percentage
        if (currentLeverage >= maxLeverage) return 0;

        margin = ((maxLeverage - currentLeverage) * PRECISION) / maxLeverage;
    }

    /// @notice Validate position health before operations
    /// @dev Reverts if leverage is too close to liquidation
    function _validatePositionHealth() internal view {
        if (!hasPosition()) return;

        uint256 currentLeverage = getCurrentLeverage();
        if (currentLeverage > emergencyLeverageThreshold) {
            revert LeverageApproachingLiquidation(currentLeverage);
        }
    }

    /// @notice Receive ETH for execution fee refunds
    receive() external payable {}
}