// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IExchangeRouter, IOrderVault, IDataStore, IReader} from "../interfaces/IGMXV2.sol";

/// @title Mock GMX V2 Exchange Router
/// @notice Mock implementation for testing HedgeManager
contract MockExchangeRouter is IExchangeRouter {
    using SafeERC20 for IERC20;

    address public override dataStore;
    address public override orderVault;

    uint256 private _orderNonce;
    uint256 public executionFee = 0.001 ether;

    // Track created orders
    mapping(bytes32 => CreateOrderParams) public orders;
    mapping(bytes32 => bool) public orderExecuted;
    mapping(bytes32 => bool) public orderCancelled;

    // Mock position state
    mapping(bytes32 => MockPosition) public positions;

    struct MockPosition {
        uint256 sizeInUsd;
        uint256 sizeInTokens;
        uint256 collateralAmount;
        int256 unrealizedPnl;
        int256 fundingFeeAmount;
        bool isLong;
        bool exists;
    }

    event OrderCreated(bytes32 indexed orderKey, CreateOrderParams params);
    event OrderCancelled(bytes32 indexed orderKey);
    event PositionUpdated(bytes32 indexed positionKey, uint256 sizeInUsd, uint256 collateralAmount);

    constructor() {
        dataStore = address(new MockDataStore());
        orderVault = address(new MockOrderVault());
    }

    function setDataStore(address _dataStore) external {
        dataStore = _dataStore;
    }

    function setOrderVault(address _orderVault) external {
        orderVault = _orderVault;
    }

    function setExecutionFee(uint256 _fee) external {
        executionFee = _fee;
    }

    function createOrder(
        CreateOrderParams calldata params
    ) external payable override returns (bytes32 orderKey) {
        require(msg.value >= executionFee, "Insufficient execution fee");

        _orderNonce++;
        orderKey = keccak256(abi.encode(msg.sender, _orderNonce, block.timestamp));

        orders[orderKey] = params;

        emit OrderCreated(orderKey, params);

        // Auto-execute the order for testing (simulating keeper execution)
        _executeOrder(orderKey, params);

        return orderKey;
    }

    function _executeOrder(bytes32 orderKey, CreateOrderParams memory params) internal {
        bytes32 positionKey = _getPositionKey(
            params.receiver,
            params.market,
            params.initialCollateralToken,
            params.isLong
        );

        MockPosition storage position = positions[positionKey];

        if (
            params.orderType == OrderType.MarketIncrease ||
            params.orderType == OrderType.LimitIncrease
        ) {
            // Increase position
            position.sizeInUsd += params.sizeDeltaUsd;
            position.sizeInTokens += (params.sizeDeltaUsd * 1e18) / _getMockPrice(); // Simplified
            position.collateralAmount += params.initialCollateralDeltaAmount;
            position.isLong = params.isLong;
            position.exists = true;
        } else if (
            params.orderType == OrderType.MarketDecrease ||
            params.orderType == OrderType.LimitDecrease
        ) {
            // Decrease position
            if (params.sizeDeltaUsd >= position.sizeInUsd) {
                // Close position
                position.sizeInUsd = 0;
                position.sizeInTokens = 0;
                position.collateralAmount = 0;
                position.exists = false;
            } else {
                position.sizeInUsd -= params.sizeDeltaUsd;
                position.sizeInTokens -= (params.sizeDeltaUsd * 1e18) / _getMockPrice();
                if (params.initialCollateralDeltaAmount > 0) {
                    position.collateralAmount -= params.initialCollateralDeltaAmount;
                }
            }
        }

        orderExecuted[orderKey] = true;

        emit PositionUpdated(positionKey, position.sizeInUsd, position.collateralAmount);
    }

    function cancelOrder(bytes32 key) external payable override {
        require(!orderExecuted[key], "Order already executed");
        orderCancelled[key] = true;
        emit OrderCancelled(key);
    }

    function updateOrder(
        bytes32 key,
        uint256 sizeDeltaUsd,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        uint256 minOutputAmount,
        bool autoCancel
    ) external payable override {
        require(!orderExecuted[key], "Order already executed");
        CreateOrderParams storage order = orders[key];
        order.sizeDeltaUsd = sizeDeltaUsd;
        order.acceptablePrice = acceptablePrice;
        order.triggerPrice = triggerPrice;
        order.minOutputAmount = minOutputAmount;
        order.autoCancel = autoCancel;
    }

    function claimFundingFees(
        address[] memory markets,
        address[] memory tokens,
        address receiver
    ) external payable override returns (uint256[] memory amounts) {
        amounts = new uint256[](markets.length);

        for (uint256 i = 0; i < markets.length; i++) {
            // Mock: return some funding for each market
            bytes32 positionKey = _getPositionKey(receiver, markets[i], tokens[i], false);
            MockPosition storage position = positions[positionKey];

            if (position.exists && position.fundingFeeAmount > 0) {
                amounts[i] = uint256(position.fundingFeeAmount);
                position.fundingFeeAmount = 0;
            }
        }
    }

    // ============ Mock Helper Functions ============

    function setPosition(
        address account,
        address market,
        address collateralToken,
        bool isLong,
        uint256 sizeInUsd,
        uint256 sizeInTokens,
        uint256 collateralAmount,
        int256 unrealizedPnl,
        int256 fundingFeeAmount
    ) external {
        bytes32 positionKey = _getPositionKey(account, market, collateralToken, isLong);
        positions[positionKey] = MockPosition({
            sizeInUsd: sizeInUsd,
            sizeInTokens: sizeInTokens,
            collateralAmount: collateralAmount,
            unrealizedPnl: unrealizedPnl,
            fundingFeeAmount: fundingFeeAmount,
            isLong: isLong,
            exists: sizeInUsd > 0
        });
    }

    function setPositionPnL(
        address account,
        address market,
        address collateralToken,
        bool isLong,
        int256 pnl
    ) external {
        bytes32 positionKey = _getPositionKey(account, market, collateralToken, isLong);
        positions[positionKey].unrealizedPnl = pnl;
    }

    function setPositionFunding(
        address account,
        address market,
        address collateralToken,
        bool isLong,
        int256 funding
    ) external {
        bytes32 positionKey = _getPositionKey(account, market, collateralToken, isLong);
        positions[positionKey].fundingFeeAmount = funding;
    }

    function getPosition(
        address account,
        address market,
        address collateralToken,
        bool isLong
    ) external view returns (MockPosition memory) {
        bytes32 positionKey = _getPositionKey(account, market, collateralToken, isLong);
        return positions[positionKey];
    }

    function _getPositionKey(
        address account,
        address market,
        address collateralToken,
        bool isLong
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, market, collateralToken, isLong));
    }

    function _getMockPrice() internal pure returns (uint256) {
        // Mock ETH price: $2000 with 30 decimals
        return 2000 * 1e30;
    }
}

/// @title Mock GMX V2 Order Vault
/// @notice Mock implementation for testing
contract MockOrderVault is IOrderVault {
    using SafeERC20 for IERC20;

    mapping(address => uint256) public tokenBalances;

    function recordTransferIn(address token) external override returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 amount = balance - tokenBalances[token];
        tokenBalances[token] = balance;
        return amount;
    }

    function transferOut(address token, address receiver, uint256 amount) external override {
        IERC20(token).safeTransfer(receiver, amount);
        tokenBalances[token] -= amount;
    }
}

/// @title Mock GMX V2 Data Store
/// @notice Mock implementation for testing
contract MockDataStore is IDataStore {
    mapping(bytes32 => uint256) private uintValues;
    mapping(bytes32 => int256) private intValues;
    mapping(bytes32 => address) private addressValues;
    mapping(bytes32 => bool) private boolValues;
    mapping(bytes32 => bytes32) private bytes32Values;
    mapping(bytes32 => uint256[]) private uintArrayValues;
    mapping(bytes32 => address[]) private addressArrayValues;

    function getUint(bytes32 key) external view override returns (uint256) {
        return uintValues[key];
    }

    function setUint(bytes32 key, uint256 value) external override returns (uint256) {
        uintValues[key] = value;
        return value;
    }

    function getInt(bytes32 key) external view override returns (int256) {
        return intValues[key];
    }

    function setInt(bytes32 key, int256 value) external override returns (int256) {
        intValues[key] = value;
        return value;
    }

    function getAddress(bytes32 key) external view override returns (address) {
        return addressValues[key];
    }

    function setAddress(bytes32 key, address value) external override returns (address) {
        addressValues[key] = value;
        return value;
    }

    function getBool(bytes32 key) external view override returns (bool) {
        return boolValues[key];
    }

    function setBool(bytes32 key, bool value) external override returns (bool) {
        boolValues[key] = value;
        return value;
    }

    function getBytes32(bytes32 key) external view override returns (bytes32) {
        return bytes32Values[key];
    }

    function setBytes32(bytes32 key, bytes32 value) external override returns (bytes32) {
        bytes32Values[key] = value;
        return value;
    }

    function getUintArray(bytes32 key) external view override returns (uint256[] memory) {
        return uintArrayValues[key];
    }

    function getAddressArray(bytes32 key) external view override returns (address[] memory) {
        return addressArrayValues[key];
    }

    function setUintArray(bytes32 key, uint256[] memory values) external {
        uintArrayValues[key] = values;
    }

    function setAddressArray(bytes32 key, address[] memory values) external {
        addressArrayValues[key] = values;
    }
}

/// @title Mock GMX V2 Reader
/// @notice Mock implementation for testing
contract MockReader is IReader {
    MockExchangeRouter public exchangeRouter;

    constructor(address _exchangeRouter) {
        exchangeRouter = MockExchangeRouter(_exchangeRouter);
    }

    function getPosition(
        address dataStore,
        bytes32 positionKey
    ) external view override returns (PositionInfo memory info) {
        // Not implemented in mock - use getPositionInfo instead
        (dataStore, positionKey);
        return info;
    }

    function getPositionInfo(
        address dataStore,
        address referralStorage,
        bytes32 positionKey,
        MarketPrices memory prices,
        uint256 sizeDeltaUsd,
        address uiFeeReceiver,
        bool usePositionSizeAsSizeDeltaUsd
    ) external view override returns (PositionInfo memory info) {
        // Silence unused warnings
        (
            dataStore,
            referralStorage,
            prices,
            sizeDeltaUsd,
            uiFeeReceiver,
            usePositionSizeAsSizeDeltaUsd
        );
        // This is a simplified mock
        return info;
    }

    function getMarket(
        address dataStore,
        address marketAddress
    ) external view override returns (MarketInfo memory info) {
        (dataStore);
        info.marketToken = marketAddress;
        return info;
    }

    function getMarkets(
        address dataStore,
        uint256 start,
        uint256 end
    ) external view override returns (MarketInfo[] memory) {
        (dataStore, start, end);
        return new MarketInfo[](0);
    }

    function getAccountPositionKeys(
        address dataStore,
        address account,
        uint256 start,
        uint256 end
    ) external view override returns (bytes32[] memory) {
        (dataStore, account, start, end);
        return new bytes32[](0);
    }
}

/// @title Mock Chainlink Price Feed for GMX
/// @notice Provides mock price data for testing
contract MockGMXPriceFeed {
    int256 private _price;
    uint8 private _decimals;

    constructor(int256 initialPrice, uint8 decimals_) {
        _price = initialPrice;
        _decimals = decimals_;
    }

    function setPrice(int256 price) external {
        _price = price;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (1, _price, block.timestamp, block.timestamp, 1);
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }
}
