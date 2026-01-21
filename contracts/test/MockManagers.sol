// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ILiquidityManager} from "../interfaces/ILiquidityManager.sol";
import {IHedgeManager} from "../interfaces/IHedgeManager.sol";
import {ISwapRouter} from "../interfaces/IUniswapV3.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SimpleMockSwapRouter {
    function exactInputSingle(
        ISwapRouter.ExactInputSingleParams calldata
    ) external payable returns (uint256) {
        return 0;
    }
}

contract MockPool {
    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        // sqrtPriceX96 for 1.0 = 2^96
        return (79228162514264337593543950336, 0, 0, 0, 0, 0, false);
    }
}

contract MockLiquidityManager is ILiquidityManager {
    address public baseToken;
    address public quoteToken;
    address public pool;
    address public vault;
    SimpleMockSwapRouter public router;

    int256 public mockDelta;
    uint256 public mockValue;
    uint256 public mockPrice;

    constructor(address _baseToken, address _quoteToken) {
        baseToken = _baseToken;
        quoteToken = _quoteToken;
        router = new SimpleMockSwapRouter();
        pool = address(new MockPool());
        mockPrice = 1e18;
    }

    function setVault(address _vault) external {
        vault = _vault;
    }

    function setMockDelta(int256 _delta) external {
        mockDelta = _delta;
    }

    function setMockValue(uint256 _value) external {
        mockValue = _value;
    }

    function setMockPrice(uint256 _price) external {
        mockPrice = _price;
    }

    // Dummy implementations
    function mintPosition(
        int24,
        int24,
        uint256,
        uint256,
        uint256
    ) external pure returns (uint256, uint128, uint256, uint256) {
        return (1, 1000, 0, 0);
    }
    function increaseLiquidity(
        uint256,
        uint256,
        uint256,
        uint256
    ) external pure returns (uint128, uint256, uint256) {
        return (1000, 0, 0);
    } // Adjusted signature? No check interface
    function increaseLiquidity(
        uint256,
        uint256,
        uint256
    ) external pure returns (uint128, uint256, uint256) {
        return (1000, 0, 0);
    }

    function decreaseLiquidity(uint128, uint256) external pure returns (uint256, uint256) {
        return (0, 0);
    }
    function collectFees() external pure returns (uint256, uint256) {
        return (0, 0);
    }
    function adjustRange(int24, int24, uint256) external pure returns (uint256, uint128) {
        return (0, 0);
    }
    function closePosition() external pure returns (uint256, uint256) {
        return (0, 0);
    }
    function getPositionValue() external view returns (uint256) {
        return mockValue;
    }
    function getPositionDelta() external view returns (int256) {
        return mockDelta;
    }
    function getPositionDeltaRatio() external pure returns (uint256) {
        return 0;
    }
    function getTokenAmounts() external pure returns (uint256, uint256) {
        return (0, 0);
    }
    function getPendingFees() external pure returns (uint256, uint256) {
        return (0, 0);
    }
    function getPool() external view returns (address) {
        return pool;
    }
    function getPositionInfo() external pure returns (uint256, int24, int24, uint128) {
        return (1, -100, 100, 1000);
    }
    function isInRange() external pure returns (bool) {
        return true;
    }
    function poolFee() external pure returns (uint24) {
        return 3000;
    }
    function tokenId() external pure returns (uint256) {
        return 1;
    }
    function liquidity() external pure returns (uint128) {
        return 1000;
    }
    function getRebalanceTicks(int24) external pure returns (int24, int24) {
        return (-100, 100);
    }
    function getOraclePrice() external view returns (uint256) {
        return mockPrice;
    }
    function swapRouter() external view returns (ISwapRouter) {
        return ISwapRouter(address(router));
    }

    function swapForLP(address, uint256, int24, uint256) external pure returns (uint256) {
        return 0;
    }
}

contract MockHedgeManager is IHedgeManager {
    address public vault;
    function setVault(address _vault) external {
        vault = _vault;
    }

    function openShort(uint256, uint256) external payable returns (bytes32) {
        return bytes32(0);
    }
    function increaseShort(uint256, uint256) external payable returns (bytes32) {
        return bytes32(0);
    }
    function decreaseShort(uint256, uint256) external payable returns (bytes32) {
        return bytes32(0);
    }
    function closeShort() external payable returns (bytes32) {
        return bytes32(0);
    }
    function adjustHedge(uint256) external payable returns (bytes32) {
        return bytes32(0);
    }
    function claimFunding() external pure returns (int256) {
        return 0;
    }
    function getPositionSizeUsd() external pure returns (uint256) {
        return 0;
    }
    function getPositionSizeTokens() external pure returns (uint256) {
        return 0;
    }
    function getCollateralAmount() external pure returns (uint256) {
        return 0;
    }
    function getPositionValue() external pure returns (uint256) {
        return 0;
    }
    function getPositionDelta() external pure returns (int256) {
        return 0;
    }
    function getUnrealizedPnL() external pure returns (int256) {
        return 0;
    }
    function getAccumulatedFunding() external pure returns (int256) {
        return 0;
    }
    function getCurrentLeverage() external pure returns (uint256) {
        return 0;
    }
    function hasPosition() external pure returns (bool) {
        return false;
    }
    function getPositionKey() external pure returns (bytes32) {
        return bytes32(0);
    }
    function getExecutionFee() external pure returns (uint256) {
        return 0;
    }
    function market() external pure returns (address) {
        return address(0);
    }
    function collateralToken() external pure returns (address) {
        return address(0);
    }
    function indexToken() external pure returns (address) {
        return address(0);
    }
    function totalFundingReceived() external pure returns (int256) {
        return 0;
    }
    function totalCollateralDeposited() external pure returns (uint256) {
        return 0;
    }

    function sweep(address) external pure {}
    function sweepEth() external pure {}
}
