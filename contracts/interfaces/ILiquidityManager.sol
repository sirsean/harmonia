// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ISwapRouter} from "./IUniswapV3.sol";

/// @title Liquidity Manager Interface
/// @notice Interface for the LiquidityManager contract
interface ILiquidityManager {
    /// @notice Mint a new LP position
    /// @param tickLower Lower tick of the position range
    /// @param tickUpper Upper tick of the position range
    /// @param amount0Desired Amount of token0 to deposit
    /// @param amount1Desired Amount of token1 to deposit
    /// @param deadline Transaction deadline
    /// @return tokenId The minted position token ID
    /// @return liquidity The amount of liquidity minted
    /// @return amount0 Actual amount of token0 deposited
    /// @return amount1 Actual amount of token1 deposited
    function mintPosition(
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 deadline
    ) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    /// @notice Increase liquidity in the current position
    /// @param amount0Desired Amount of token0 to add
    /// @param amount1Desired Amount of token1 to add
    /// @param deadline Transaction deadline
    /// @return liquidity Amount of liquidity added
    /// @return amount0 Actual amount of token0 added
    /// @return amount1 Actual amount of token1 added
    function increaseLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 deadline
    ) external returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    /// @notice Decrease liquidity in the current position
    /// @param liquidity Amount of liquidity to remove
    /// @param deadline Transaction deadline
    /// @return amount0 Amount of token0 received
    /// @return amount1 Amount of token1 received
    function decreaseLiquidity(
        uint128 liquidity,
        uint256 deadline
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice Collect accumulated fees from the position
    /// @return amount0 Amount of token0 fees collected
    /// @return amount1 Amount of token1 fees collected
    function collectFees() external returns (uint256 amount0, uint256 amount1);

    /// @notice Adjust the position range by closing current and opening new position
    /// @param newTickLower New lower tick
    /// @param newTickUpper New upper tick
    /// @param deadline Transaction deadline
    /// @return newTokenId The new position token ID
    /// @return newLiquidity The new position liquidity
    function adjustRange(
        int24 newTickLower,
        int24 newTickUpper,
        uint256 deadline
    ) external returns (uint256 newTokenId, uint128 newLiquidity);

    /// @notice Close the current position completely
    /// @return amount0 Amount of token0 received
    /// @return amount1 Amount of token1 received
    function closePosition() external returns (uint256 amount0, uint256 amount1);

    /// @notice Get the current position value in quote token terms
    /// @return value Position value in quote token
    function getPositionValue() external view returns (uint256 value);

    /// @notice Get the current position delta
    /// @return delta Position delta in base token units (scaled by 1e18)
    function getPositionDelta() external view returns (int256 delta);

    /// @notice Get the current position delta ratio
    /// @return deltaRatio Delta as percentage (0 to 1e18)
    function getPositionDeltaRatio() external view returns (uint256 deltaRatio);

    /// @notice Get the token amounts in the current position
    /// @return amount0 Amount of token0
    /// @return amount1 Amount of token1
    function getTokenAmounts() external view returns (uint256 amount0, uint256 amount1);

    /// @notice Get pending fees (uncollected)
    /// @return amount0 Pending token0 fees
    /// @return amount1 Pending token1 fees
    function getPendingFees() external view returns (uint256 amount0, uint256 amount1);

    /// @notice Get the current pool address
    /// @return pool The Uniswap V3 pool address
    function getPool() external view returns (address pool);

    /// @notice Get current position info
    /// @return tokenId Position token ID
    /// @return tickLower Lower tick
    /// @return tickUpper Upper tick
    /// @return liquidity Position liquidity
    function getPositionInfo()
        external
        view
        returns (uint256 tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity);

    /// @notice Check if position is in range
    /// @return inRange True if current price is within position range
    function isInRange() external view returns (bool inRange);

    /// @notice Get the base token address
    function baseToken() external view returns (address);

    /// @notice Get the quote token address
    function quoteToken() external view returns (address);

    /// @notice Get the pool fee
    function poolFee() external view returns (uint24);

    /// @notice Get the vault address
    function vault() external view returns (address);

    /// @notice Get the current token ID
    function tokenId() external view returns (uint256);

    /// @notice Get current liquidity
    function liquidity() external view returns (uint128);

    /// @notice Get new ticks for rebalancing centered on current price
    /// @param widthMultiplier Multiplier for tick spacing to determine width (e.g. 200 = +/- 100 ticks)
    /// @return newTickLower New lower tick
    /// @return newTickUpper New upper tick
    function getRebalanceTicks(
        int24 widthMultiplier
    ) external view returns (int24 newTickLower, int24 newTickUpper);

    /// @notice Get the current price from the oracle
    /// @return price Current price (scaled by 1e18)
    function getOraclePrice() external view returns (uint256 price);

    /// @notice Get the swap router address
    function swapRouter() external view returns (ISwapRouter);
}
