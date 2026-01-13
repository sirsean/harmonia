// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    IExchangeRouter,
    IOrderVault,
    IDataStore,
    IReader,
    GMXPositionUtils
} from "./interfaces/IGMXV2.sol";
import {AggregatorV3Interface} from "./interfaces/IChainlink.sol";

/// @title Hedge Manager
/// @notice Manages GMX V2 short positions to hedge delta exposure from LP positions
/// @dev Wraps GMX V2 perpetuals for delta-neutral strategies
contract HedgeManager is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Precision for calculations (1e18)
    uint256 public constant PRECISION = 1e18;

    /// @notice USD precision used by GMX (1e30)
    uint256 public constant GMX_USD_PRECISION = 1e30;

    /// @notice Maximum acceptable price impact (5%)
    uint256 public constant MAX_PRICE_IMPACT = 5e16;

    /// @notice Minimum execution fee for GMX orders
    uint256 public constant MIN_EXECUTION_FEE = 0.001 ether;

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice GMX V2 Exchange Router
    IExchangeRouter public immutable exchangeRouter;

    /// @notice GMX V2 Order Vault
    IOrderVault public immutable orderVault;

    /// @notice GMX V2 Data Store
    IDataStore public immutable dataStore;

    /// @notice GMX V2 Reader for position info
    IReader public immutable reader;

    /// @notice Chainlink price feed for the hedged asset
    AggregatorV3Interface public immutable priceFeed;

    /// @notice GMX market address (e.g., ETH/USD market)
    address public immutable market;

    /// @notice Collateral token (e.g., USDC)
    IERC20 public immutable collateralToken;

    /// @notice Index token (e.g., WETH) - the token we're hedging
    address public immutable indexToken;

    /// @notice Authorized vault address
    address public vault;

    /// @notice Current pending order key (if any)
    bytes32 public pendingOrderKey;

    /// @notice Cumulative funding received (positive) or paid (negative)
    int256 public cumulativeFunding;

    /// @notice Cumulative trading fees paid
    uint256 public cumulativeTradingFees;

    /// @notice Target hedge size in USD (scaled by 1e30)
    uint256 public targetHedgeSizeUsd;

    /// @notice Acceptable slippage for orders (scaled by 1e18)
    uint256 public acceptableSlippage;

    /// @notice Callback gas limit for GMX orders
    uint256 public callbackGasLimit;

    // ═══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Hedge position information
    struct HedgePosition {
        uint256 sizeUsd;
        uint256 collateralAmount;
        int256 unrealizedPnl;
        int256 fundingFees;
        bool isActive;
    }

    /// @notice Parameters for adjusting hedge
    struct AdjustHedgeParams {
        uint256 targetSizeUsd;
        uint256 collateralDelta;
        bool isIncrease;
        uint256 executionFee;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event HedgeOpened(
        bytes32 indexed orderKey,
        uint256 sizeUsd,
        uint256 collateralAmount,
        uint256 acceptablePrice
    );

    event HedgeIncreased(bytes32 indexed orderKey, uint256 sizeDeltaUsd, uint256 collateralDelta);

    event HedgeDecreased(bytes32 indexed orderKey, uint256 sizeDeltaUsd, uint256 collateralDelta);

    event HedgeClosed(bytes32 indexed orderKey, uint256 sizeUsd);

    event OrderCancelled(bytes32 indexed orderKey);

    event FundingClaimed(address indexed market, int256 amount);

    event VaultUpdated(address indexed oldVault, address indexed newVault);

    event SlippageUpdated(uint256 oldSlippage, uint256 newSlippage);

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidAddress();
    error UnauthorizedCaller();
    error OrderPending();
    error NoActivePosition();
    error InsufficientExecutionFee();
    error SlippageTooHigh();
    error InvalidSize();
    error PriceStale();

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Restricts function access to the vault or owner
    modifier onlyVaultOrOwner() {
        if (msg.sender != vault && msg.sender != owner()) {
            revert UnauthorizedCaller();
        }
        _;
    }

    /// @notice Ensures no pending order exists
    modifier noPendingOrder() {
        if (pendingOrderKey != bytes32(0)) {
            revert OrderPending();
        }
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Constructs the HedgeManager
    /// @param _exchangeRouter GMX V2 Exchange Router address
    /// @param _reader GMX V2 Reader address
    /// @param _priceFeed Chainlink price feed address
    /// @param _market GMX market address
    /// @param _collateralToken Collateral token address
    /// @param _indexToken Index token address (token being hedged)
    /// @param _owner Initial owner address
    constructor(
        address _exchangeRouter,
        address _reader,
        address _priceFeed,
        address _market,
        address _collateralToken,
        address _indexToken,
        address _owner
    ) Ownable(_owner) {
        if (
            _exchangeRouter == address(0) ||
            _reader == address(0) ||
            _priceFeed == address(0) ||
            _market == address(0) ||
            _collateralToken == address(0) ||
            _indexToken == address(0)
        ) {
            revert InvalidAddress();
        }

        exchangeRouter = IExchangeRouter(_exchangeRouter);
        reader = IReader(_reader);
        priceFeed = AggregatorV3Interface(_priceFeed);
        market = _market;
        collateralToken = IERC20(_collateralToken);
        indexToken = _indexToken;

        // Get dependent addresses from exchange router
        dataStore = IDataStore(exchangeRouter.dataStore());
        orderVault = IOrderVault(exchangeRouter.orderVault());

        // Default settings
        acceptableSlippage = 5e15; // 0.5%
        callbackGasLimit = 1_000_000;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS - POSITION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Opens a new short hedge position
    /// @param sizeUsd Position size in USD (scaled by 1e30)
    /// @param collateralAmount Collateral amount in collateral token units
    /// @return orderKey The order key for tracking
    function openHedge(
        uint256 sizeUsd,
        uint256 collateralAmount
    ) external payable onlyVaultOrOwner noPendingOrder nonReentrant returns (bytes32 orderKey) {
        if (sizeUsd == 0) {
            revert InvalidSize();
        }
        if (msg.value < MIN_EXECUTION_FEE) {
            revert InsufficientExecutionFee();
        }

        // Transfer collateral from caller
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);

        // Get acceptable price with slippage (for short, we want lower price)
        uint256 currentPrice = getOraclePrice();
        uint256 acceptablePrice = (currentPrice * (PRECISION - acceptableSlippage)) / PRECISION;

        // Approve and transfer collateral to order vault
        collateralToken.safeIncreaseAllowance(address(orderVault), collateralAmount);
        collateralToken.safeTransfer(address(orderVault), collateralAmount);
        orderVault.recordTransferIn(address(collateralToken));

        // Create order params for short position
        address[] memory swapPath = new address[](0);

        IExchangeRouter.CreateOrderParams memory params = IExchangeRouter.CreateOrderParams({
            receiver: address(this),
            cancellationReceiver: address(this),
            callbackContract: address(0),
            uiFeeReceiver: address(0),
            market: market,
            initialCollateralToken: address(collateralToken),
            swapPath: swapPath,
            orderType: IExchangeRouter.OrderType.MarketIncrease,
            decreasePositionSwapType: IExchangeRouter.DecreasePositionSwapType.NoSwap,
            sizeDeltaUsd: sizeUsd,
            initialCollateralDeltaAmount: collateralAmount,
            triggerPrice: 0,
            acceptablePrice: acceptablePrice,
            executionFee: msg.value,
            callbackGasLimit: callbackGasLimit,
            minOutputAmount: 0,
            isLong: false, // SHORT position
            shouldUnwrapNativeToken: false,
            autoCancel: false,
            referralCode: bytes32(0)
        });

        orderKey = exchangeRouter.createOrder{value: msg.value}(params);
        pendingOrderKey = orderKey;
        targetHedgeSizeUsd = sizeUsd;

        emit HedgeOpened(orderKey, sizeUsd, collateralAmount, acceptablePrice);
    }

    /// @notice Increases the hedge position size
    /// @param sizeDeltaUsd Additional size in USD
    /// @param collateralDelta Additional collateral
    /// @return orderKey The order key
    function increaseHedge(
        uint256 sizeDeltaUsd,
        uint256 collateralDelta
    ) external payable onlyVaultOrOwner noPendingOrder nonReentrant returns (bytes32 orderKey) {
        if (sizeDeltaUsd == 0 && collateralDelta == 0) {
            revert InvalidSize();
        }
        if (msg.value < MIN_EXECUTION_FEE) {
            revert InsufficientExecutionFee();
        }

        // Transfer collateral if adding
        if (collateralDelta > 0) {
            collateralToken.safeTransferFrom(msg.sender, address(this), collateralDelta);
            collateralToken.safeIncreaseAllowance(address(orderVault), collateralDelta);
            collateralToken.safeTransfer(address(orderVault), collateralDelta);
            orderVault.recordTransferIn(address(collateralToken));
        }

        uint256 currentPrice = getOraclePrice();
        uint256 acceptablePrice = (currentPrice * (PRECISION - acceptableSlippage)) / PRECISION;

        address[] memory swapPath = new address[](0);

        IExchangeRouter.CreateOrderParams memory params = IExchangeRouter.CreateOrderParams({
            receiver: address(this),
            cancellationReceiver: address(this),
            callbackContract: address(0),
            uiFeeReceiver: address(0),
            market: market,
            initialCollateralToken: address(collateralToken),
            swapPath: swapPath,
            orderType: IExchangeRouter.OrderType.MarketIncrease,
            decreasePositionSwapType: IExchangeRouter.DecreasePositionSwapType.NoSwap,
            sizeDeltaUsd: sizeDeltaUsd,
            initialCollateralDeltaAmount: collateralDelta,
            triggerPrice: 0,
            acceptablePrice: acceptablePrice,
            executionFee: msg.value,
            callbackGasLimit: callbackGasLimit,
            minOutputAmount: 0,
            isLong: false,
            shouldUnwrapNativeToken: false,
            autoCancel: false,
            referralCode: bytes32(0)
        });

        orderKey = exchangeRouter.createOrder{value: msg.value}(params);
        pendingOrderKey = orderKey;
        targetHedgeSizeUsd += sizeDeltaUsd;

        emit HedgeIncreased(orderKey, sizeDeltaUsd, collateralDelta);
    }

    /// @notice Decreases the hedge position size
    /// @param sizeDeltaUsd Size to reduce in USD
    /// @param collateralDelta Collateral to withdraw
    /// @return orderKey The order key
    function decreaseHedge(
        uint256 sizeDeltaUsd,
        uint256 collateralDelta
    ) external payable onlyVaultOrOwner noPendingOrder nonReentrant returns (bytes32 orderKey) {
        if (sizeDeltaUsd == 0 && collateralDelta == 0) {
            revert InvalidSize();
        }
        if (msg.value < MIN_EXECUTION_FEE) {
            revert InsufficientExecutionFee();
        }

        // For decrease, we want higher acceptable price (we're buying back)
        uint256 currentPrice = getOraclePrice();
        uint256 acceptablePrice = (currentPrice * (PRECISION + acceptableSlippage)) / PRECISION;

        address[] memory swapPath = new address[](0);

        IExchangeRouter.CreateOrderParams memory params = IExchangeRouter.CreateOrderParams({
            receiver: msg.sender, // Send withdrawn collateral to caller
            cancellationReceiver: address(this),
            callbackContract: address(0),
            uiFeeReceiver: address(0),
            market: market,
            initialCollateralToken: address(collateralToken),
            swapPath: swapPath,
            orderType: IExchangeRouter.OrderType.MarketDecrease,
            decreasePositionSwapType: IExchangeRouter.DecreasePositionSwapType.NoSwap,
            sizeDeltaUsd: sizeDeltaUsd,
            initialCollateralDeltaAmount: collateralDelta,
            triggerPrice: 0,
            acceptablePrice: acceptablePrice,
            executionFee: msg.value,
            callbackGasLimit: callbackGasLimit,
            minOutputAmount: 0,
            isLong: false,
            shouldUnwrapNativeToken: false,
            autoCancel: false,
            referralCode: bytes32(0)
        });

        orderKey = exchangeRouter.createOrder{value: msg.value}(params);
        pendingOrderKey = orderKey;

        if (sizeDeltaUsd <= targetHedgeSizeUsd) {
            targetHedgeSizeUsd -= sizeDeltaUsd;
        } else {
            targetHedgeSizeUsd = 0;
        }

        emit HedgeDecreased(orderKey, sizeDeltaUsd, collateralDelta);
    }

    /// @notice Closes the entire hedge position
    /// @return orderKey The order key
    function closeHedge()
        external
        payable
        onlyVaultOrOwner
        noPendingOrder
        nonReentrant
        returns (bytes32 orderKey)
    {
        if (msg.value < MIN_EXECUTION_FEE) {
            revert InsufficientExecutionFee();
        }

        HedgePosition memory position = getHedgePosition();
        if (!position.isActive) {
            revert NoActivePosition();
        }

        uint256 currentPrice = getOraclePrice();
        uint256 acceptablePrice = (currentPrice * (PRECISION + acceptableSlippage)) / PRECISION;

        address[] memory swapPath = new address[](0);

        IExchangeRouter.CreateOrderParams memory params = IExchangeRouter.CreateOrderParams({
            receiver: msg.sender,
            cancellationReceiver: address(this),
            callbackContract: address(0),
            uiFeeReceiver: address(0),
            market: market,
            initialCollateralToken: address(collateralToken),
            swapPath: swapPath,
            orderType: IExchangeRouter.OrderType.MarketDecrease,
            decreasePositionSwapType: IExchangeRouter.DecreasePositionSwapType.NoSwap,
            sizeDeltaUsd: position.sizeUsd,
            initialCollateralDeltaAmount: position.collateralAmount,
            triggerPrice: 0,
            acceptablePrice: acceptablePrice,
            executionFee: msg.value,
            callbackGasLimit: callbackGasLimit,
            minOutputAmount: 0,
            isLong: false,
            shouldUnwrapNativeToken: false,
            autoCancel: false,
            referralCode: bytes32(0)
        });

        orderKey = exchangeRouter.createOrder{value: msg.value}(params);
        pendingOrderKey = orderKey;
        targetHedgeSizeUsd = 0;

        emit HedgeClosed(orderKey, position.sizeUsd);
    }

    /// @notice Cancels a pending order
    function cancelPendingOrder() external payable onlyVaultOrOwner nonReentrant {
        if (pendingOrderKey == bytes32(0)) {
            return;
        }

        bytes32 orderKey = pendingOrderKey;
        pendingOrderKey = bytes32(0);

        exchangeRouter.cancelOrder{value: msg.value}(orderKey);

        emit OrderCancelled(orderKey);
    }

    /// @notice Claims accumulated funding fees
    /// @return claimedAmount The amount of funding claimed
    function claimFunding() external onlyVaultOrOwner nonReentrant returns (int256 claimedAmount) {
        address[] memory markets = new address[](1);
        markets[0] = market;

        address[] memory tokens = new address[](1);
        tokens[0] = address(collateralToken);

        uint256 balanceBefore = collateralToken.balanceOf(address(this));

        uint256[] memory claimed = exchangeRouter.claimFundingFees(markets, tokens, address(this));

        uint256 balanceAfter = collateralToken.balanceOf(address(this));
        claimedAmount = int256(balanceAfter - balanceBefore);

        cumulativeFunding += claimedAmount;

        // Transfer claimed funding to vault
        if (claimedAmount > 0) {
            collateralToken.safeTransfer(msg.sender, uint256(claimedAmount));
        }

        emit FundingClaimed(market, claimedAmount);
    }

    /// @notice Clears pending order key after order execution
    /// @dev Called by keeper/executor after order is processed
    function clearPendingOrder() external onlyVaultOrOwner {
        pendingOrderKey = bytes32(0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS - VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Gets the current hedge position info
    /// @return position The hedge position struct
    function getHedgePosition() public view returns (HedgePosition memory position) {
        bytes32 positionKey = GMXPositionUtils.getPositionKey(
            address(this),
            market,
            address(collateralToken),
            false // isLong = false for short
        );

        IReader.PositionInfo memory gmxPosition = reader.getPosition(
            address(dataStore),
            positionKey
        );

        position = HedgePosition({
            sizeUsd: gmxPosition.sizeInUsd,
            collateralAmount: gmxPosition.collateralAmount,
            unrealizedPnl: 0, // Would need price context to calculate
            fundingFees: gmxPosition.fundingFeeAmount,
            isActive: gmxPosition.sizeInUsd > 0
        });
    }

    /// @notice Gets the current position size in USD
    /// @return sizeUsd Position size scaled by 1e30
    function getPositionSizeUsd() external view returns (uint256 sizeUsd) {
        HedgePosition memory position = getHedgePosition();
        return position.sizeUsd;
    }

    /// @notice Gets the position delta (exposure to price changes)
    /// @dev For a short position, delta is negative
    /// @return delta Position delta (negative for short)
    function getPositionDelta() external view returns (int256 delta) {
        HedgePosition memory position = getHedgePosition();
        if (!position.isActive) {
            return 0;
        }

        // For a short position, delta = -sizeInTokens
        // sizeInTokens = sizeUsd / price
        uint256 price = getOraclePrice();
        if (price == 0) return 0;

        // Convert to token units and negate for short
        uint256 sizeInTokens = (position.sizeUsd * PRECISION) /
            ((price * GMX_USD_PRECISION) / PRECISION);
        delta = -int256(sizeInTokens);
    }

    /// @notice Gets the oracle price
    /// @return price Price in USD with 8 decimals
    function getOraclePrice() public view returns (uint256 price) {
        (, int256 answer, , uint256 updatedAt, ) = priceFeed.latestRoundData();

        if (answer <= 0) {
            revert PriceStale();
        }
        if (block.timestamp - updatedAt > 1 hours) {
            revert PriceStale();
        }

        price = uint256(answer);
    }

    /// @notice Gets the effective leverage of the position
    /// @return leverage Position leverage (scaled by 1e18)
    function getPositionLeverage() external view returns (uint256 leverage) {
        HedgePosition memory position = getHedgePosition();
        if (!position.isActive || position.collateralAmount == 0) {
            return 0;
        }

        // Get collateral value in USD (assuming collateral is stablecoin)
        // collateral decimals is typically 6 for USDC
        uint256 collateralUsd = (position.collateralAmount * GMX_USD_PRECISION) / 1e6;

        if (collateralUsd == 0) return 0;

        leverage = (position.sizeUsd * PRECISION) / collateralUsd;
    }

    /// @notice Gets cumulative funding received/paid
    /// @return funding Cumulative funding (positive = received)
    function getCumulativeFunding() external view returns (int256 funding) {
        return cumulativeFunding;
    }

    /// @notice Checks if there's a pending order
    /// @return pending True if there's a pending order
    function hasPendingOrder() external view returns (bool pending) {
        return pendingOrderKey != bytes32(0);
    }

    /// @notice Gets the position key for this contract's short position
    /// @return key The position key
    function getPositionKey() external view returns (bytes32 key) {
        return
            GMXPositionUtils.getPositionKey(address(this), market, address(collateralToken), false);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS - ADMIN
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Sets the authorized vault address
    /// @param _vault New vault address
    function setVault(address _vault) external onlyOwner {
        if (_vault == address(0)) {
            revert InvalidAddress();
        }
        address oldVault = vault;
        vault = _vault;
        emit VaultUpdated(oldVault, _vault);
    }

    /// @notice Sets the acceptable slippage
    /// @param _slippage New slippage tolerance (scaled by 1e18)
    function setAcceptableSlippage(uint256 _slippage) external onlyOwner {
        if (_slippage > MAX_PRICE_IMPACT) {
            revert SlippageTooHigh();
        }
        uint256 oldSlippage = acceptableSlippage;
        acceptableSlippage = _slippage;
        emit SlippageUpdated(oldSlippage, _slippage);
    }

    /// @notice Sets the callback gas limit
    /// @param _gasLimit New gas limit
    function setCallbackGasLimit(uint256 _gasLimit) external onlyOwner {
        callbackGasLimit = _gasLimit;
    }

    /// @notice Emergency function to recover stuck tokens
    /// @param token Token address to recover
    /// @param to Recipient address
    /// @param amount Amount to recover
    function emergencyRecover(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) {
            revert InvalidAddress();
        }
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Emergency function to recover stuck ETH
    /// @param to Recipient address
    /// @param amount Amount to recover
    function emergencyRecoverETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) {
            revert InvalidAddress();
        }
        (bool success, ) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    /// @notice Allows contract to receive ETH (for execution fee refunds)
    receive() external payable {}
}
