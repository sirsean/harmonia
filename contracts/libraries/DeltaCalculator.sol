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

    /// @notice Calculates sqrtPriceX96 given a tick
    /// @dev Adapted from Uniswap V3 TickMath library
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= uint256(int256(type(int24).max)), "T");

        uint256 ratio = absTick & 0x1 != 0
            ? 0xfffcb933bd6fad37aa2d162d1a594001
            : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (tick > 0) ratio = type(uint256).max / ratio;

        // this divides by 1<<32 rounding up to go from a Q128.128 to a Q128.96.
        // we then downcast because we know the result always fits within 160 bits due to our tick input constraint
        // we round up in the division so getTickAtSqrtRatio of the output price is always consistent
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}
