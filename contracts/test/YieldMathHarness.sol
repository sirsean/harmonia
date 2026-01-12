// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../libraries/YieldMath.sol";

/// @title YieldMath Test Harness
/// @notice Exposes internal YieldMath functions for testing
contract YieldMathHarness {
    /// @notice Calculate APY from two yield snapshots
    function calculateAPY(
        YieldMath.YieldSnapshot memory startSnapshot,
        YieldMath.YieldSnapshot memory endSnapshot
    ) external pure returns (uint256) {
        return YieldMath.calculateAPY(startSnapshot, endSnapshot);
    }

    /// @notice Calculate simple return percentage
    function calculateReturn(uint256 startValue, uint256 endValue) external pure returns (int256) {
        return YieldMath.calculateReturn(startValue, endValue);
    }

    /// @notice Convert period return to APY
    function periodReturnToAPY(
        int256 periodReturn,
        uint256 periodSeconds
    ) external pure returns (uint256) {
        return YieldMath.periodReturnToAPY(periodReturn, periodSeconds);
    }

    /// @notice Calculate total fees in USD
    function calculateTotalFees(
        uint256 amount0Fees,
        uint256 amount1Fees,
        uint256 token0Price,
        uint8 token1Decimals
    ) external pure returns (uint256) {
        return YieldMath.calculateTotalFees(amount0Fees, amount1Fees, token0Price, token1Decimals);
    }

    /// @notice Calculate funding APY
    function calculateFundingAPY(
        int256 fundingAmount,
        uint256 positionSize,
        uint256 timePeriod
    ) external pure returns (int256) {
        return YieldMath.calculateFundingAPY(fundingAmount, positionSize, timePeriod);
    }

    /// @notice Calculate breakeven volatility
    function calculateBreakevenVolatility(
        uint256 feeAPY,
        uint256 rangeWidth
    ) external pure returns (uint256) {
        return YieldMath.calculateBreakevenVolatility(feeAPY, rangeWidth);
    }

    /// @notice Helper to create a yield snapshot
    function createSnapshot(
        uint256 timestamp,
        uint256 totalValue,
        uint256 cumulativeFees,
        int256 cumulativeFunding,
        uint256 cumulativeRebalanceCosts
    ) external pure returns (YieldMath.YieldSnapshot memory) {
        return
            YieldMath.YieldSnapshot({
                timestamp: timestamp,
                totalValue: totalValue,
                cumulativeFees: cumulativeFees,
                cumulativeFunding: cumulativeFunding,
                cumulativeRebalanceCosts: cumulativeRebalanceCosts
            });
    }

    /// @notice Expose PRECISION constant
    function PRECISION() external pure returns (uint256) {
        return 1e18;
    }

    /// @notice Expose SECONDS_PER_YEAR constant
    function SECONDS_PER_YEAR() external pure returns (uint256) {
        return 365.25 days;
    }
}
