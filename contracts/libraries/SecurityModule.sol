// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IChainlinkPriceFeed} from "../interfaces/IChainlink.sol";

/// @title Security Module Library
/// @notice Provides security utilities for delta-neutral vault operations
/// @dev Includes oracle validation, circuit breaker logic, and safety checks
library SecurityModule {
    // ============ Constants ============

    /// @notice Precision for percentage calculations (1e18 = 100%)
    uint256 public constant PRECISION = 1e18;

    /// @notice Minimum valid price (prevents zero/negative prices)
    uint256 public constant MIN_VALID_PRICE = 1e6; // $0.01 in 8 decimals

    /// @notice Maximum valid price (prevents extreme prices)
    uint256 public constant MAX_VALID_PRICE = 1e14; // $1,000,000 in 8 decimals

    // ============ Errors ============

    /// @notice Thrown when oracle price is stale
    error OracleStale(uint256 lastUpdate, uint256 maxAge);

    /// @notice Thrown when oracle returns invalid price
    error InvalidOraclePrice(int256 price);

    /// @notice Thrown when oracle price deviates too much from TWAP
    error OraclePriceDeviation(uint256 oraclePrice, uint256 twapPrice, uint256 deviation);

    /// @notice Thrown when round data is incomplete
    error IncompleteRound(uint80 answeredInRound, uint80 roundId);

    /// @notice Thrown when price is out of valid range
    error PriceOutOfRange(uint256 price);

    // ============ Oracle Validation ============

    /// @notice Validate Chainlink oracle price data
    /// @param priceFeed The Chainlink price feed to validate
    /// @param maxStaleness Maximum acceptable staleness in seconds
    /// @return price The validated price (8 decimals for most feeds)
    function validateOraclePrice(
        IChainlinkPriceFeed priceFeed,
        uint256 maxStaleness
    ) internal view returns (uint256 price) {
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = priceFeed
            .latestRoundData();

        // Check for stale price
        if (block.timestamp - updatedAt > maxStaleness) {
            revert OracleStale(updatedAt, maxStaleness);
        }

        // Check for invalid price
        if (answer <= 0) {
            revert InvalidOraclePrice(answer);
        }

        // Check for incomplete round
        if (answeredInRound < roundId) {
            revert IncompleteRound(answeredInRound, roundId);
        }

        price = uint256(answer);

        // Check price is within valid range
        if (price < MIN_VALID_PRICE || price > MAX_VALID_PRICE) {
            revert PriceOutOfRange(price);
        }
    }

    /// @notice Validate oracle price against a reference (TWAP)
    /// @param oraclePrice Current oracle price
    /// @param referencePrice Reference price (e.g., TWAP)
    /// @param maxDeviation Maximum acceptable deviation (scaled by 1e18)
    /// @return isValid True if price deviation is acceptable
    function validatePriceDeviation(
        uint256 oraclePrice,
        uint256 referencePrice,
        uint256 maxDeviation
    ) internal pure returns (bool isValid) {
        if (referencePrice == 0) return false;

        uint256 deviation;
        if (oraclePrice > referencePrice) {
            deviation = ((oraclePrice - referencePrice) * PRECISION) / referencePrice;
        } else {
            deviation = ((referencePrice - oraclePrice) * PRECISION) / referencePrice;
        }

        if (deviation > maxDeviation) {
            revert OraclePriceDeviation(oraclePrice, referencePrice, deviation);
        }

        return true;
    }

    /// @notice Get oracle price with staleness check only (no range validation)
    /// @param priceFeed The Chainlink price feed
    /// @param maxStaleness Maximum acceptable staleness in seconds
    /// @return price The price from the oracle
    function getOraclePriceWithStalenessCheck(
        IChainlinkPriceFeed priceFeed,
        uint256 maxStaleness
    ) internal view returns (uint256 price) {
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = priceFeed
            .latestRoundData();

        // Check for stale price
        if (block.timestamp - updatedAt > maxStaleness) {
            revert OracleStale(updatedAt, maxStaleness);
        }

        // Check for invalid price
        if (answer <= 0) {
            revert InvalidOraclePrice(answer);
        }

        // Check for incomplete round
        if (answeredInRound < roundId) {
            revert IncompleteRound(answeredInRound, roundId);
        }

        price = uint256(answer);
    }

    // ============ Circuit Breaker Checks ============

    /// @notice Calculate absolute delta ratio
    /// @param deltaRatio The signed delta ratio
    /// @return absRatio The absolute value of delta ratio
    function absValue(int256 deltaRatio) internal pure returns (uint256 absRatio) {
        return deltaRatio >= 0 ? uint256(deltaRatio) : uint256(-deltaRatio);
    }

    /// @notice Check if delta drift exceeds emergency threshold
    /// @param currentDeltaRatio Current net delta ratio (scaled by 1e18)
    /// @param emergencyThreshold Emergency threshold (scaled by 1e18)
    /// @return isEmergency True if emergency condition is met
    function checkEmergencyDelta(
        int256 currentDeltaRatio,
        uint256 emergencyThreshold
    ) internal pure returns (bool isEmergency) {
        return absValue(currentDeltaRatio) > emergencyThreshold;
    }

    /// @notice Check if leverage exceeds maximum
    /// @param currentLeverage Current leverage ratio (scaled by 1e18)
    /// @param maxLeverage Maximum allowed leverage (scaled by 1e18)
    /// @return isExceeded True if leverage exceeds maximum
    function checkLeverageExceeded(
        uint256 currentLeverage,
        uint256 maxLeverage
    ) internal pure returns (bool isExceeded) {
        return currentLeverage > maxLeverage;
    }

    // ============ Position Sizing Safety ============

    /// @notice Calculate safe position size based on available collateral
    /// @param collateral Available collateral amount
    /// @param maxLeverage Maximum leverage (scaled by 1e18)
    /// @return maxPositionSize Maximum safe position size
    function calculateMaxPositionSize(
        uint256 collateral,
        uint256 maxLeverage
    ) internal pure returns (uint256 maxPositionSize) {
        // maxPositionSize = collateral * maxLeverage / PRECISION
        maxPositionSize = (collateral * maxLeverage) / PRECISION;
    }

    /// @notice Validate withdrawal amount is safe
    /// @param withdrawAmount Amount to withdraw
    /// @param totalAssets Total vault assets
    /// @param maxWithdrawPercent Maximum single withdrawal percentage (scaled by 1e18)
    /// @return isSafe True if withdrawal is within safe limits
    function validateWithdrawalSize(
        uint256 withdrawAmount,
        uint256 totalAssets,
        uint256 maxWithdrawPercent
    ) internal pure returns (bool isSafe) {
        if (totalAssets == 0) return withdrawAmount == 0;

        uint256 withdrawPercent = (withdrawAmount * PRECISION) / totalAssets;
        return withdrawPercent <= maxWithdrawPercent;
    }

    // ============ Rate Limiting ============

    /// @notice Check if minimum time has elapsed since last action
    /// @param lastActionTime Timestamp of last action
    /// @param minInterval Minimum interval between actions
    /// @return canAct True if enough time has passed
    function checkRateLimit(
        uint256 lastActionTime,
        uint256 minInterval
    ) internal view returns (bool canAct) {
        if (lastActionTime == 0) return true;
        return block.timestamp >= lastActionTime + minInterval;
    }
}
