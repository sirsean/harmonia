// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title Delta Calculator Library
/// @notice Calculates delta and other Greeks for Uniswap V3 LP positions
/// @dev Based on Guillaume Lambert's work on Uniswap v3 as options
library DeltaCalculator {
    /// @notice Q96 constant for fixed-point math (2^96)
    uint256 internal constant Q96 = 2 ** 96;

    /// @notice Precision for delta calculations (1e18)
    uint256 internal constant PRECISION = 1e18;

    /// @notice Calculate delta of a Uniswap v3 LP position
    /// @dev Delta represents the position's exposure to the base token (token0)
    ///      Delta = L * (1/√S - 1/√Pb) when in range
    ///      Delta = L * (1/√Pa - 1/√Pb) when price below range
    ///      Delta = 0 when price above range
    /// @param sqrtPriceX96 Current sqrt price (Q64.96)
    /// @param sqrtPriceLowerX96 Lower bound sqrt price (Q64.96)
    /// @param sqrtPriceUpperX96 Upper bound sqrt price (Q64.96)
    /// @param liquidity Position liquidity
    /// @return delta The position delta in base token units (scaled by 1e18)
    function calculateDelta(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) internal pure returns (int256 delta) {
        require(sqrtPriceLowerX96 < sqrtPriceUpperX96, "Invalid price range");
        require(sqrtPriceLowerX96 > 0, "Lower price must be positive");

        if (liquidity == 0) return 0;

        // If price below range: full exposure to base token
        // delta = L * (1/√Pa - 1/√Pb)
        if (sqrtPriceX96 <= sqrtPriceLowerX96) {
            return int256(_getAmount0ForLiquidity(sqrtPriceLowerX96, sqrtPriceUpperX96, liquidity));
        }

        // If price above range: no exposure to base token
        // delta = 0
        if (sqrtPriceX96 >= sqrtPriceUpperX96) {
            return 0;
        }

        // In range: partial exposure
        // delta = L * (1/√S - 1/√Pb)
        return int256(_getAmount0ForLiquidity(sqrtPriceX96, sqrtPriceUpperX96, liquidity));
    }

    /// @notice Calculate delta as a ratio (0 to 1, scaled by 1e18)
    /// @dev Returns the fraction of position value that is exposed to base token price
    /// @param sqrtPriceX96 Current sqrt price
    /// @param sqrtPriceLowerX96 Lower bound sqrt price
    /// @param sqrtPriceUpperX96 Upper bound sqrt price
    /// @return deltaRatio Delta as ratio between 0 and 1e18
    function calculateDeltaRatio(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96
    ) internal pure returns (uint256 deltaRatio) {
        require(sqrtPriceLowerX96 < sqrtPriceUpperX96, "Invalid price range");

        // Below range: delta ratio = 1 (100% base token exposure)
        if (sqrtPriceX96 <= sqrtPriceLowerX96) {
            return PRECISION;
        }

        // Above range: delta ratio = 0 (0% base token exposure)
        if (sqrtPriceX96 >= sqrtPriceUpperX96) {
            return 0;
        }

        // In range: calculate ratio
        // deltaRatio = (1/√S - 1/√Pb) / (1/√Pa - 1/√Pb)
        // Simplified: = (√Pb - √S) * √Pa / ((√Pb - √Pa) * √S)
        uint256 numerator = uint256(sqrtPriceUpperX96 - sqrtPriceX96) * uint256(sqrtPriceLowerX96);
        uint256 denominator = uint256(sqrtPriceUpperX96 - sqrtPriceLowerX96) *
            uint256(sqrtPriceX96);

        deltaRatio = mulDiv(numerator, PRECISION, denominator);
    }

    /// @notice Calculate the amount of base token (token0) in a position
    /// @param sqrtPriceX96 Current sqrt price
    /// @param sqrtPriceLowerX96 Lower bound sqrt price
    /// @param sqrtPriceUpperX96 Upper bound sqrt price
    /// @param liquidity Position liquidity
    /// @return amount0 Amount of base token
    function getBaseTokenAmount(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount0) {
        if (liquidity == 0) return 0;

        if (sqrtPriceX96 <= sqrtPriceLowerX96) {
            // All base token
            amount0 = _getAmount0ForLiquidity(sqrtPriceLowerX96, sqrtPriceUpperX96, liquidity);
        } else if (sqrtPriceX96 < sqrtPriceUpperX96) {
            // In range - partial base token
            amount0 = _getAmount0ForLiquidity(sqrtPriceX96, sqrtPriceUpperX96, liquidity);
        }
        // else: all quote token, amount0 = 0
    }

    /// @notice Calculate the amount of quote token (token1) in a position
    /// @param sqrtPriceX96 Current sqrt price
    /// @param sqrtPriceLowerX96 Lower bound sqrt price
    /// @param sqrtPriceUpperX96 Upper bound sqrt price
    /// @param liquidity Position liquidity
    /// @return amount1 Amount of quote token
    function getQuoteTokenAmount(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount1) {
        if (liquidity == 0) return 0;

        if (sqrtPriceX96 >= sqrtPriceUpperX96) {
            // All quote token
            amount1 = _getAmount1ForLiquidity(sqrtPriceLowerX96, sqrtPriceUpperX96, liquidity);
        } else if (sqrtPriceX96 > sqrtPriceLowerX96) {
            // In range - partial quote token
            amount1 = _getAmount1ForLiquidity(sqrtPriceLowerX96, sqrtPriceX96, liquidity);
        }
        // else: all base token, amount1 = 0
    }

    /// @notice Calculate the total value of a position in quote token terms
    /// @param sqrtPriceX96 Current sqrt price
    /// @param sqrtPriceLowerX96 Lower bound sqrt price
    /// @param sqrtPriceUpperX96 Upper bound sqrt price
    /// @param liquidity Position liquidity
    /// @return value Total value in quote token (token1) units
    function getPositionValue(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) internal pure returns (uint256 value) {
        uint256 amount0 = getBaseTokenAmount(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            liquidity
        );
        uint256 amount1 = getQuoteTokenAmount(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            liquidity
        );

        // Convert amount0 to quote token using current price
        // price = (sqrtPriceX96 / 2^96)^2 = sqrtPriceX96^2 / 2^192
        // value0 = amount0 * price
        uint256 amount0InQuote = mulDiv(
            amount0,
            mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96),
            Q96
        );

        value = amount0InQuote + amount1;
    }

    /// @notice Calculate gamma (second derivative of value with respect to price)
    /// @dev γ(S) = -L / (2 * S^(3/2)) when in range, 0 otherwise
    ///      Negative gamma indicates short volatility exposure
    /// @param sqrtPriceX96 Current sqrt price
    /// @param sqrtPriceLowerX96 Lower bound sqrt price
    /// @param sqrtPriceUpperX96 Upper bound sqrt price
    /// @param liquidity Position liquidity
    /// @return gamma Position gamma (negative, scaled by 1e18)
    function calculateGamma(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) internal pure returns (int256 gamma) {
        // Gamma is 0 outside the range
        if (sqrtPriceX96 <= sqrtPriceLowerX96 || sqrtPriceX96 >= sqrtPriceUpperX96) {
            return 0;
        }

        // γ = -L / (2 * S^(3/2))
        // In Q96 terms: γ = -L * Q96 / (2 * sqrtPrice^3 / Q96^2)
        //                 = -L * Q96^3 / (2 * sqrtPrice^3)
        uint256 sqrtPriceCubed = mulDiv(
            mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96),
            uint256(sqrtPriceX96),
            Q96
        );

        if (sqrtPriceCubed == 0) return 0;

        uint256 gammaAbs = mulDiv(uint256(liquidity) * PRECISION, Q96, 2 * sqrtPriceCubed);

        gamma = -int256(gammaAbs);
    }

    /// @notice Helper to calculate amount0 for a given liquidity and price range
    /// @dev amount0 = L * (1/√Pl - 1/√Pu) = L * (√Pu - √Pl) / (√Pl * √Pu)
    function _getAmount0ForLiquidity(
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) private pure returns (uint256 amount0) {
        // Use Uniswap's formula: amount0 = L * 2^96 * (Pb - Pa) / Pb / Pa
        // We use mulDiv to handle the intermediate multiplication by 2^96

        uint256 numerator = mulDiv(
            uint256(liquidity) << 96,
            uint256(sqrtPriceUpperX96 - sqrtPriceLowerX96),
            uint256(sqrtPriceUpperX96)
        );

        amount0 = numerator / uint256(sqrtPriceLowerX96);
    }

    /// @notice Helper to calculate amount1 for a given liquidity and price range
    /// @dev amount1 = L * (√Pu - √Pl)
    function _getAmount1ForLiquidity(
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) private pure returns (uint256 amount1) {
        amount1 = mulDiv(uint256(liquidity), uint256(sqrtPriceUpperX96 - sqrtPriceLowerX96), Q96);
    }

    /// @notice Convert a regular price to sqrtPriceX96 format
    /// @param price Price with decimals (e.g., 2000e18 for ETH at $2000)
    /// @param priceDecimals Decimals of the input price (e.g., 18)
    /// @return sqrtPriceX96 The sqrt price in Q64.96 format
    function priceToSqrtPriceX96(
        uint256 price,
        uint8 priceDecimals
    ) internal pure returns (uint160 sqrtPriceX96) {
        // sqrtPrice = sqrt(price) * 2^96
        // For precision, we multiply first then sqrt
        uint256 priceX192 = mulDiv(price, Q96 * Q96, 10 ** priceDecimals);
        sqrtPriceX96 = uint160(_sqrt(priceX192));
    }

    /// @notice Convert sqrtPriceX96 to a regular price
    /// @param sqrtPriceX96 The sqrt price in Q64.96 format
    /// @param priceDecimals Desired decimals for output price
    /// @return price The price with specified decimals
    function sqrtPriceX96ToPrice(
        uint160 sqrtPriceX96,
        uint8 priceDecimals
    ) internal pure returns (uint256 price) {
        // price = (sqrtPrice / 2^96)^2 = sqrtPrice^2 / 2^192
        uint256 sqrtPriceSquared = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        price = mulDiv(sqrtPriceSquared, 10 ** priceDecimals, Q96 * Q96);
    }

    /// @notice Calculates floor(a×b÷denominator) with full precision
    /// @dev Credit to Remco Bloemen under MIT license https://xn--2-umb.com/21/muldiv
    function mulDiv(
        uint256 a,
        uint256 b,
        uint256 denominator
    ) internal pure returns (uint256 result) {
        unchecked {
            // 512-bit multiply [prod1 prod0] = a * b
            uint256 prod0; // Least significant 256 bits of the product
            uint256 prod1; // Most significant 256 bits of the product
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            // Handle non-overflow cases, 256 by 256 division
            if (prod1 == 0) {
                require(denominator > 0);
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }

            // Make sure the result is less than 2**256
            require(denominator > prod1);

            // 512 by 256 division
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            // Factor powers of two out of denominator
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }

            // Shift in bits from prod1 into prod0
            prod0 |= prod1 * twos;

            // Invert denominator mod 2**256
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;

            result = prod0 * inv;
            return result;
        }
    }

    /// @notice Integer square root using the Babylonian method
    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
