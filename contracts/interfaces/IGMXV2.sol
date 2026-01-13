// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title GMX V2 Router Interface
/// @notice Base router for token transfers on behalf of users
interface IRouter {
    /// @notice Transfers tokens on behalf of users who have approved the router
    /// @param token The token to transfer
    /// @param account The account to transfer from
    /// @param receiver The receiver of the tokens
    /// @param amount The amount to transfer
    function pluginTransfer(
        address token,
        address account,
        address receiver,
        uint256 amount
    ) external;
}

/// @title GMX V2 Exchange Router Interface
/// @notice Interface for creating and managing orders on GMX V2
/// @dev Inherits from BaseRouter which provides dataStore, router, sendWnt, sendTokens
interface IExchangeRouter {
    enum OrderType {
        MarketSwap,
        LimitSwap,
        MarketIncrease,
        LimitIncrease,
        MarketDecrease,
        LimitDecrease,
        StopLossDecrease,
        Liquidation
    }

    enum DecreasePositionSwapType {
        NoSwap,
        SwapPnlTokenToCollateralToken,
        SwapCollateralTokenToPnlToken
    }

    struct CreateOrderParams {
        address receiver;
        address cancellationReceiver;
        address callbackContract;
        address uiFeeReceiver;
        address market;
        address initialCollateralToken;
        address[] swapPath;
        OrderType orderType;
        DecreasePositionSwapType decreasePositionSwapType;
        uint256 sizeDeltaUsd;
        uint256 initialCollateralDeltaAmount;
        uint256 triggerPrice;
        uint256 acceptablePrice;
        uint256 executionFee;
        uint256 callbackGasLimit;
        uint256 minOutputAmount;
        bool isLong;
        bool shouldUnwrapNativeToken;
        bool autoCancel;
        bytes32 referralCode;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INHERITED FROM BASE ROUTER
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Returns the address of the data store (from BaseRouter)
    function dataStore() external view returns (address);

    /// @notice Returns the address of the router (from BaseRouter)
    function router() external view returns (address);

    /// @notice Wraps native token and sends to receiver (from BaseRouter)
    /// @param receiver The address to receive the wrapped native token
    /// @param amount The amount to wrap and send
    function sendWnt(address receiver, uint256 amount) external payable;

    /// @notice Sends tokens to receiver using router's pluginTransfer (from BaseRouter)
    /// @param token The token to send
    /// @param receiver The receiver address
    /// @param amount The amount to send
    function sendTokens(address token, address receiver, uint256 amount) external payable;

    // ═══════════════════════════════════════════════════════════════════════════
    // ORDER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Creates a new order
    function createOrder(
        CreateOrderParams calldata params
    ) external payable returns (bytes32 orderKey);

    /// @notice Cancels an existing order
    function cancelOrder(bytes32 key) external payable;

    /// @notice Updates an existing order
    function updateOrder(
        bytes32 key,
        uint256 sizeDeltaUsd,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        uint256 minOutputAmount,
        bool autoCancel
    ) external payable;

    // ═══════════════════════════════════════════════════════════════════════════
    // FEE CLAIMS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Claims funding fees for a position
    function claimFundingFees(
        address[] memory markets,
        address[] memory tokens,
        address receiver
    ) external payable returns (uint256[] memory);

    // ═══════════════════════════════════════════════════════════════════════════
    // MULTICALL
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Executes multiple calls in a single transaction
    /// @param data Array of encoded function calls
    /// @return results Array of results from each call
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results);
}

/// @title GMX V2 Order Vault Interface
interface IOrderVault {
    /// @notice Records a transfer of tokens into the vault
    function recordTransferIn(address token) external returns (uint256);

    /// @notice Transfers tokens out of the vault
    function transferOut(address token, address receiver, uint256 amount) external;
}

/// @title GMX V2 Data Store Interface
/// @notice Stores all protocol data in key-value format
interface IDataStore {
    function getUint(bytes32 key) external view returns (uint256);
    function setUint(bytes32 key, uint256 value) external returns (uint256);
    function getInt(bytes32 key) external view returns (int256);
    function setInt(bytes32 key, int256 value) external returns (int256);
    function getAddress(bytes32 key) external view returns (address);
    function setAddress(bytes32 key, address value) external returns (address);
    function getBool(bytes32 key) external view returns (bool);
    function setBool(bytes32 key, bool value) external returns (bool);
    function getBytes32(bytes32 key) external view returns (bytes32);
    function setBytes32(bytes32 key, bytes32 value) external returns (bytes32);
    function getUintArray(bytes32 key) external view returns (uint256[] memory);
    function getAddressArray(bytes32 key) external view returns (address[] memory);
}

/// @title GMX V2 Reader Interface
/// @notice Read-only interface for GMX V2 positions and markets
interface IReader {
    struct MarketInfo {
        address marketToken;
        address indexToken;
        address longToken;
        address shortToken;
    }

    struct PositionInfo {
        address account;
        address market;
        address collateralToken;
        bool isLong;
        uint256 sizeInUsd;
        uint256 sizeInTokens;
        uint256 collateralAmount;
        int256 fundingFeeAmount;
        int256 claimableFundingAmount;
        uint256 increasedAtBlock;
        uint256 decreasedAtBlock;
    }

    struct MarketPrices {
        uint256 indexTokenPrice;
        uint256 longTokenPrice;
        uint256 shortTokenPrice;
    }

    /// @notice Gets the position info for an account in a market
    function getPosition(
        address dataStore,
        bytes32 positionKey
    ) external view returns (PositionInfo memory);

    /// @notice Gets position info using account, market, collateral token, and direction
    function getPositionInfo(
        address dataStore,
        address referralStorage,
        bytes32 positionKey,
        MarketPrices memory prices,
        uint256 sizeDeltaUsd,
        address uiFeeReceiver,
        bool usePositionSizeAsSizeDeltaUsd
    ) external view returns (PositionInfo memory);

    /// @notice Gets market info
    function getMarket(
        address dataStore,
        address marketAddress
    ) external view returns (MarketInfo memory);

    /// @notice Gets all markets
    function getMarkets(
        address dataStore,
        uint256 start,
        uint256 end
    ) external view returns (MarketInfo[] memory);

    /// @notice Gets the account's position keys
    function getAccountPositionKeys(
        address dataStore,
        address account,
        uint256 start,
        uint256 end
    ) external view returns (bytes32[] memory);
}

/// @title GMX V2 Position Utils
/// @notice Helper library for position key calculation
library GMXPositionUtils {
    /// @notice Calculates the position key for a position
    function getPositionKey(
        address account,
        address market,
        address collateralToken,
        bool isLong
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, market, collateralToken, isLong));
    }
}
