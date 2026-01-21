// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title Hedge Manager Interface
/// @notice Interface for the HedgeManager contract that manages GMX v2 perpetual positions
interface IHedgeManager {
    /// @notice Open a new short position
    /// @param sizeDeltaUsd Size of the position in USD (30 decimals)
    /// @param collateralAmount Amount of collateral to deposit
    /// @return orderKey The key of the created order
    function openShort(
        uint256 sizeDeltaUsd,
        uint256 collateralAmount
    ) external payable returns (bytes32 orderKey);

    /// @notice Increase an existing short position
    /// @param sizeDeltaUsd Size increase in USD (30 decimals)
    /// @param collateralAmount Additional collateral to deposit
    /// @return orderKey The key of the created order
    function increaseShort(
        uint256 sizeDeltaUsd,
        uint256 collateralAmount
    ) external payable returns (bytes32 orderKey);

    /// @notice Decrease an existing short position
    /// @param sizeDeltaUsd Size decrease in USD (30 decimals)
    /// @param collateralAmount Collateral to withdraw (0 to keep all)
    /// @return orderKey The key of the created order
    function decreaseShort(
        uint256 sizeDeltaUsd,
        uint256 collateralAmount
    ) external payable returns (bytes32 orderKey);

    /// @notice Close the entire short position
    /// @return orderKey The key of the created order
    function closeShort() external payable returns (bytes32 orderKey);

    /// @notice Adjust hedge to target delta
    /// @param targetDeltaUsd Target short size in USD (30 decimals)
    /// @return orderKey The key of the created order
    function adjustHedge(uint256 targetDeltaUsd) external payable returns (bytes32 orderKey);

    /// @notice Claim accumulated funding fees
    /// @return fundingAmount Amount of funding claimed (can be negative)
    function claimFunding() external returns (int256 fundingAmount);

    /// @notice Get the current short position size in USD
    /// @return sizeUsd Position size in USD (30 decimals)
    function getPositionSizeUsd() external view returns (uint256 sizeUsd);

    /// @notice Get the current short position size in tokens
    /// @return sizeTokens Position size in tokens (18 decimals)
    function getPositionSizeTokens() external view returns (uint256 sizeTokens);

    /// @notice Get the current collateral amount
    /// @return collateral Collateral amount in collateral token decimals
    function getCollateralAmount() external view returns (uint256 collateral);

    /// @notice Get the current position value (collateral + unrealized PnL)
    /// @return value Position value in collateral token decimals
    function getPositionValue() external view returns (uint256 value);

    /// @notice Get the current position delta (negative for shorts)
    /// @return delta Position delta (negative value, 18 decimals)
    function getPositionDelta() external view returns (int256 delta);

    /// @notice Get the unrealized PnL
    /// @return pnl Unrealized profit/loss (can be negative)
    function getUnrealizedPnL() external view returns (int256 pnl);

    /// @notice Get accumulated funding (positive = received, negative = paid)
    /// @return fundingAmount Accumulated funding amount
    function getAccumulatedFunding() external view returns (int256 fundingAmount);

    /// @notice Get the current leverage ratio
    /// @return leverage Current leverage (18 decimals, e.g., 2e18 = 2x)
    function getCurrentLeverage() external view returns (uint256 leverage);

    /// @notice Check if a position exists
    /// @return exists True if position exists
    function hasPosition() external view returns (bool exists);

    /// @notice Get the position key
    /// @return key The GMX position key
    function getPositionKey() external view returns (bytes32 key);

    /// @notice Get the required execution fee for GMX orders
    /// @return fee Execution fee in ETH
    function getExecutionFee() external view returns (uint256 fee);

    /// @notice Get the market address
    function market() external view returns (address);

    /// @notice Get the collateral token address
    function collateralToken() external view returns (address);

    /// @notice Get the index token address (token being hedged)
    function indexToken() external view returns (address);

    /// @notice Get the vault address
    function vault() external view returns (address);

    /// @notice Get total funding received (tracked)
    function totalFundingReceived() external view returns (int256);

    /// @notice Get total collateral deposited
    function totalCollateralDeposited() external view returns (uint256);

    /// @notice Sweep idle tokens back to vault
    /// @param token Token to sweep
    function sweep(address token) external;

    /// @notice Sweep ETH back to vault
    function sweepEth() external;
}
