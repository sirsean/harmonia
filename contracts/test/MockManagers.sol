// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockLiquidityManager {
    address public baseToken;
    address public quoteToken;

    constructor(address _baseToken, address _quoteToken) {
        baseToken = _baseToken;
        quoteToken = _quoteToken;
    }
}
