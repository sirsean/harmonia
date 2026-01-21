// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title Yield Math Library
/// @notice Library for calculating APY and yield metrics
library YieldMath {
    /// @notice Precision for percentage calculations (1e18 = 100%)
    uint256 internal constant PRECISION = 1e18;

    /// @notice Seconds per year (365.25 days)
    uint256 internal constant SECONDS_PER_YEAR = 365.25 days;

    /// @notice Yield snapshot structure for tracking historical yield
    struct YieldSnapshot {
        uint256 timestamp;
        uint256 totalValue;
        uint256 cumulativeFees;
        int256 cumulativeFunding;
        uint256 cumulativeRebalanceCosts;
    }

    /// @notice Aggregated yield metrics
    struct YieldMetrics {
        uint256 apy1Day;
        uint256 apy7Day;
        uint256 apy30Day;
        uint256 totalFeeIncome;
        int256 totalFundingIncome;
        uint256 totalRebalanceCosts;
        int256 netYield;
    }

    /// @notice Calculate APY from two yield snapshots
    /// @param startSnapshot Starting point snapshot
    /// @param endSnapshot Ending point snapshot
    /// @return apy Annualized percentage yield (scaled by 1e18)
    function calculateAPY(
        YieldSnapshot memory startSnapshot,
        YieldSnapshot memory endSnapshot
    ) internal pure returns (uint256 apy) {
        if (startSnapshot.totalValue == 0) return 0;

        uint256 timeDelta = endSnapshot.timestamp - startSnapshot.timestamp;
        if (timeDelta == 0) return 0;

        // Calculate net income
        uint256 feeIncome = endSnapshot.cumulativeFees - startSnapshot.cumulativeFees;
        int256 fundingIncome = endSnapshot.cumulativeFunding - startSnapshot.cumulativeFunding;
        uint256 rebalanceCosts = endSnapshot.cumulativeRebalanceCosts -
            startSnapshot.cumulativeRebalanceCosts;

        int256 netIncome = int256(feeIncome) + fundingIncome - int256(rebalanceCosts);

        if (netIncome <= 0) return 0;

        // APY = (netIncome / startValue) * (SECONDS_PER_YEAR / timeDelta)
        uint256 periodReturn = (uint256(netIncome) * PRECISION) / startSnapshot.totalValue;
        apy = (periodReturn * SECONDS_PER_YEAR) / timeDelta;
    }

    /// @notice Calculate simple return percentage
    /// @param startValue Starting value
    /// @param endValue Ending value
    /// @return returnPct Return percentage (scaled by 1e18)
    function calculateReturn(
        uint256 startValue,
        uint256 endValue
    ) internal pure returns (int256 returnPct) {
        if (startValue == 0) return 0;

        if (endValue >= startValue) {
            returnPct = int256(((endValue - startValue) * PRECISION) / startValue);
        } else {
            returnPct = -int256(((startValue - endValue) * PRECISION) / startValue);
        }
    }

    /// @notice Calculate compounded APY from a simple period return
    /// @param periodReturn Return for the period (scaled by 1e18)
    /// @param periodSeconds Duration of the period in seconds
    /// @return apy Compounded APY (scaled by 1e18)
    function periodReturnToAPY(
        int256 periodReturn,
        uint256 periodSeconds
    ) internal pure returns (uint256 apy) {
        if (periodReturn <= 0 || periodSeconds == 0) return 0;

        // Simple annualization: APY ≈ periodReturn * (SECONDS_PER_YEAR / periodSeconds)
        // For more accurate compounding, we'd need exponential math
        apy = (uint256(periodReturn) * SECONDS_PER_YEAR) / periodSeconds;
    }

    /// @notice Calculate the fee earned from a Uniswap V3 position
    /// @param amount0Fees Fees earned in token0
    /// @param amount1Fees Fees earned in token1
    /// @param token0Price Price of token0 in USD (scaled by 1e18)
    /// @param token1Decimals Decimals of token1 (typically 6 for USDC)
    /// @return totalFeesUSD Total fees in USD (scaled by 1e18)
    function calculateTotalFees(
        uint256 amount0Fees,
        uint256 amount1Fees,
        uint256 token0Price,
        uint8 token1Decimals
    ) internal pure returns (uint256 totalFeesUSD) {
        // Convert token0 fees to USD
        uint256 token0FeesUSD = (amount0Fees * token0Price) / PRECISION;

        // Convert token1 fees to USD (assuming token1 is stablecoin)
        uint256 token1FeesUSD = (amount1Fees * PRECISION) / (10 ** token1Decimals);

        totalFeesUSD = token0FeesUSD + token1FeesUSD;
    }

    /// @notice Calculate the effective funding rate from GMX position
    /// @param fundingAmount Funding amount received/paid (positive = received)
    /// @param positionSize Position size in USD
    /// @param timePeriod Time period in seconds
    /// @return fundingAPY Annualized funding rate (can be negative)
    function calculateFundingAPY(
        int256 fundingAmount,
        uint256 positionSize,
        uint256 timePeriod
    ) internal pure returns (int256 fundingAPY) {
        if (positionSize == 0 || timePeriod == 0) return 0;

        // fundingAPY = (fundingAmount / positionSize) * (SECONDS_PER_YEAR / timePeriod)
        int256 periodRate = (fundingAmount * int256(PRECISION)) / int256(positionSize);
        fundingAPY = (periodRate * int256(SECONDS_PER_YEAR)) / int256(timePeriod);
    }

    /// @notice Calculate the breakeven volatility for an LP position
    /// @dev If realized volatility exceeds this, impermanent loss will exceed fee income
    /// @param feeAPY Expected fee APY (scaled by 1e18)
    /// @param rangeWidth Width of the LP range as percentage (e.g., 0.1e18 for 10%)
    /// @return breakevenVol Annualized breakeven volatility (scaled by 1e18)
    function calculateBreakevenVolatility(
        uint256 feeAPY,
        uint256 rangeWidth
    ) internal pure returns (uint256 breakevenVol) {
        // Simplified approximation: IL ≈ (vol^2 / 8) * (1 / rangeWidth)
        // Solving for vol when IL = feeAPY:
        // vol = sqrt(8 * feeAPY * rangeWidth)

        uint256 product = (8 * feeAPY * rangeWidth) / PRECISION;
        breakevenVol = _sqrt(product * PRECISION);
    }

    /// @notice Integer square root
    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /// @notice Convert a token amount to the equivalent value in another token
    /// @param amount Amount of the token to convert
    /// @param tokenDecimals Decimals of the token to convert
    /// @param targetDecimals Decimals of the target token
    /// @param price Price of the base token in USD (18 decimals)
    /// @param isBaseToQuote True if converting from base token to quote token
    /// @return convertedAmount Equivalent amount in target token
    function convertTokenValue(
        uint256 amount,
        uint8 tokenDecimals,
        uint8 targetDecimals,
        uint256 price,
        bool isBaseToQuote
    ) internal pure returns (uint256 convertedAmount) {
        if (isBaseToQuote) {
            // amount is Base (e.g. WETH), price is USD/Base
            // ValueInUSD = (amount * price) / 10^tokenDecimals
            uint256 value18 = (amount * price) / (10 ** tokenDecimals);

            // Convert from 18 decimals to target decimals
            if (targetDecimals <= 18) {
                convertedAmount = value18 / (10 ** (18 - targetDecimals));
            } else {
                convertedAmount = value18 * (10 ** (targetDecimals - 18));
            }
        } else {
            // amount is Quote (e.g. USDC), target is Base (e.g. WETH)
            // amount18 = amount * 10^(18-tokenDecimals)
            // ValueInBase18 = amount18 * 1e18 / price
            uint256 amount18;
            if (tokenDecimals <= 18) {
                amount18 = amount * (10 ** (18 - tokenDecimals));
            } else {
                amount18 = amount / (10 ** (tokenDecimals - 18));
            }

            uint256 valueBase18 = (amount18 * PRECISION) / price;

            // Convert from 18 decimals to target decimals
            if (targetDecimals <= 18) {
                convertedAmount = valueBase18 / (10 ** (18 - targetDecimals));
            } else {
                convertedAmount = valueBase18 * (10 ** (targetDecimals - 18));
            }
        }
    }
}
