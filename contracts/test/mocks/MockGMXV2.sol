// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IExchangeRouter, IOrderVault, IDataStore, IReader} from "../../interfaces/IGMXV2.sol";

/// @title Mock GMX V2 Exchange Router
/// @notice Mock exchange router for testing
contract MockExchangeRouter is IExchangeRouter {
    address public override dataStore;
    address public override orderVault;

    uint256 private _nextOrderKey = 1;

    struct Order {
        address receiver;
        address market;
        uint256 sizeDeltaUsd;
        uint256 collateralAmount;
        bool isLong;
        bool executed;
    }

    mapping(bytes32 => Order) public orders;

    constructor(address _dataStore, address _orderVault) {
        dataStore = _dataStore;
        orderVault = _orderVault;
    }

    function createOrder(
        CreateOrderParams calldata params
    ) external payable override returns (bytes32 orderKey) {
        orderKey = bytes32(_nextOrderKey++);

        orders[orderKey] = Order({
            receiver: params.receiver,
            market: params.market,
            sizeDeltaUsd: params.sizeDeltaUsd,
            collateralAmount: params.initialCollateralDeltaAmount,
            isLong: params.isLong,
            executed: false
        });
    }

    function cancelOrder(bytes32 key) external payable override {
        delete orders[key];
    }

    function updateOrder(
        bytes32,
        uint256,
        uint256,
        uint256,
        uint256,
        bool
    ) external payable override {
        // Mock: do nothing
    }

    function claimFundingFees(
        address[] memory,
        address[] memory,
        address
    ) external payable override returns (uint256[] memory amounts) {
        amounts = new uint256[](1);
        amounts[0] = 0;
    }

    // Mock helper: simulate order execution
    function executeOrder(bytes32 key) external {
        orders[key].executed = true;
    }
}

/// @title Mock GMX V2 Order Vault
/// @notice Mock order vault for testing
contract MockOrderVault is IOrderVault {
    mapping(address => uint256) public tokenBalances;

    function recordTransferIn(address token) external override returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 amount = balance - tokenBalances[token];
        tokenBalances[token] = balance;
        return amount;
    }

    function transferOut(address token, address receiver, uint256 amount) external override {
        IERC20(token).transfer(receiver, amount);
        tokenBalances[token] -= amount;
    }
}

/// @title Mock GMX V2 Data Store
/// @notice Mock data store for testing
contract MockDataStore is IDataStore {
    mapping(bytes32 => uint256) private uints;
    mapping(bytes32 => int256) private ints;
    mapping(bytes32 => address) private addresses;
    mapping(bytes32 => bool) private bools;
    mapping(bytes32 => bytes32) private bytes32s;

    function getUint(bytes32 key) external view override returns (uint256) {
        return uints[key];
    }

    function setUint(bytes32 key, uint256 value) external override returns (uint256) {
        uints[key] = value;
        return value;
    }

    function getInt(bytes32 key) external view override returns (int256) {
        return ints[key];
    }

    function setInt(bytes32 key, int256 value) external override returns (int256) {
        ints[key] = value;
        return value;
    }

    function getAddress(bytes32 key) external view override returns (address) {
        return addresses[key];
    }

    function setAddress(bytes32 key, address value) external override returns (address) {
        addresses[key] = value;
        return value;
    }

    function getBool(bytes32 key) external view override returns (bool) {
        return bools[key];
    }

    function setBool(bytes32 key, bool value) external override returns (bool) {
        bools[key] = value;
        return value;
    }

    function getBytes32(bytes32 key) external view override returns (bytes32) {
        return bytes32s[key];
    }

    function setBytes32(bytes32 key, bytes32 value) external override returns (bytes32) {
        bytes32s[key] = value;
        return value;
    }

    function getUintArray(bytes32) external pure override returns (uint256[] memory) {
        return new uint256[](0);
    }

    function getAddressArray(bytes32) external pure override returns (address[] memory) {
        return new address[](0);
    }
}

/// @title Mock GMX V2 Reader
/// @notice Mock reader for testing
contract MockReader is IReader {
    mapping(bytes32 => PositionInfo) public mockPositions;

    function getPosition(
        address,
        bytes32 positionKey
    ) external view override returns (PositionInfo memory) {
        return mockPositions[positionKey];
    }

    function getPositionInfo(
        address,
        address,
        bytes32 positionKey,
        MarketPrices memory,
        uint256,
        address,
        bool
    ) external view override returns (PositionInfo memory) {
        return mockPositions[positionKey];
    }

    function getMarket(
        address,
        address marketAddress
    ) external pure override returns (MarketInfo memory info) {
        info.marketToken = marketAddress;
        info.indexToken = address(0);
        info.longToken = address(0);
        info.shortToken = address(0);
    }

    function getMarkets(
        address,
        uint256,
        uint256
    ) external pure override returns (MarketInfo[] memory) {
        return new MarketInfo[](0);
    }

    function getAccountPositionKeys(
        address,
        address,
        uint256,
        uint256
    ) external pure override returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    // Mock helper: set position data
    function setMockPosition(
        bytes32 positionKey,
        uint256 sizeInUsd,
        uint256 collateralAmount,
        int256 fundingFeeAmount
    ) external {
        mockPositions[positionKey] = PositionInfo({
            account: address(0),
            market: address(0),
            collateralToken: address(0),
            isLong: false,
            sizeInUsd: sizeInUsd,
            sizeInTokens: sizeInUsd / 2000e30, // Assuming $2000 ETH
            collateralAmount: collateralAmount,
            fundingFeeAmount: fundingFeeAmount,
            claimableFundingAmount: 0,
            increasedAtBlock: block.number,
            decreasedAtBlock: 0
        });
    }
}
