// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../libraries/DeltaCalculator.sol";

/// @title Delta Calculator Test Harness
/// @notice Exposes internal library functions for testing
contract DeltaCalculatorHarness {
    function calculateDelta(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) external pure returns (int256) {
        return
            DeltaCalculator.calculateDelta(
                sqrtPriceX96,
                sqrtPriceLowerX96,
                sqrtPriceUpperX96,
                liquidity
            );
    }

    function calculateDeltaRatio(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96
    ) external pure returns (uint256) {
        return
            DeltaCalculator.calculateDeltaRatio(
                sqrtPriceX96,
                sqrtPriceLowerX96,
                sqrtPriceUpperX96
            );
    }

    function getBaseTokenAmount(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) external pure returns (uint256) {
        return
            DeltaCalculator.getBaseTokenAmount(
                sqrtPriceX96,
                sqrtPriceLowerX96,
                sqrtPriceUpperX96,
                liquidity
            );
    }

    function getQuoteTokenAmount(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) external pure returns (uint256) {
        return
            DeltaCalculator.getQuoteTokenAmount(
                sqrtPriceX96,
                sqrtPriceLowerX96,
                sqrtPriceUpperX96,
                liquidity
            );
    }

    function getPositionValue(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) external pure returns (uint256) {
        return
            DeltaCalculator.getPositionValue(
                sqrtPriceX96,
                sqrtPriceLowerX96,
                sqrtPriceUpperX96,
                liquidity
            );
    }

    function calculateGamma(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) external pure returns (int256) {
        return
            DeltaCalculator.calculateGamma(
                sqrtPriceX96,
                sqrtPriceLowerX96,
                sqrtPriceUpperX96,
                liquidity
            );
    }

    function priceToSqrtPriceX96(
        uint256 price,
        uint8 priceDecimals
    ) external pure returns (uint160) {
        return DeltaCalculator.priceToSqrtPriceX96(price, priceDecimals);
    }

    function sqrtPriceX96ToPrice(
        uint160 sqrtPriceX96,
        uint8 priceDecimals
    ) external pure returns (uint256) {
        return DeltaCalculator.sqrtPriceX96ToPrice(sqrtPriceX96, priceDecimals);
    }
}
