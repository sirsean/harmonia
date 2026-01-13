// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter} from "../../interfaces/IUniswapV3.sol";

/// @title Mock Swap Router
/// @notice Mock swap router for testing
contract MockSwapRouter is ISwapRouter {
    // Fixed exchange rate: 1 ETH = 2000 USDC
    uint256 public ethPrice = 2000e6;

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        // Transfer tokens in
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);

        // Calculate output based on mock price
        // Assuming tokenIn is WETH (18 decimals) and tokenOut is USDC (6 decimals)
        // or vice versa
        amountOut = params.amountIn * ethPrice / 1e18;

        require(amountOut >= params.amountOutMinimum, "Insufficient output");

        // Transfer tokens out
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountIn)
    {
        // Calculate input needed
        amountIn = params.amountOut * 1e18 / ethPrice;

        require(amountIn <= params.amountInMaximum, "Too much input required");

        // Transfer tokens
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(params.tokenOut).transfer(params.recipient, params.amountOut);
    }

    // Mock setter
    function setEthPrice(uint256 _price) external {
        ethPrice = _price;
    }
}
