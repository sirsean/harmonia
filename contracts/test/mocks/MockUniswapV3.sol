// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool, INonfungiblePositionManager} from "../../interfaces/IUniswapV3.sol";

/// @title Mock Uniswap V3 Pool
/// @notice Mock pool for testing
contract MockUniswapV3Pool is IUniswapV3Pool {
    address public override token0;
    address public override token1;
    uint24 public override fee;

    uint160 public sqrtPriceX96;
    int24 public currentTick;
    uint128 public poolLiquidity;

    constructor(address _token0, address _token1, uint24 _fee) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        // Default price: ~2000 USDC per ETH (sqrt(2000) * 2^96)
        sqrtPriceX96 = 3543191142285914205922034323214;
        currentTick = 74959;
        poolLiquidity = 1000000e18;
    }

    function slot0()
        external
        view
        override
        returns (
            uint160 sqrtPriceX96_,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (sqrtPriceX96, currentTick, 0, 1, 1, 0, true);
    }

    function liquidity() external view override returns (uint128) {
        return poolLiquidity;
    }

    function tickSpacing() external pure override returns (int24) {
        return 10;
    }

    function ticks(
        int24
    )
        external
        pure
        override
        returns (
            uint128 liquidityGross,
            int128 liquidityNet,
            uint256 feeGrowthOutside0X128,
            uint256 feeGrowthOutside1X128,
            int56 tickCumulativeOutside,
            uint160 secondsPerLiquidityOutsideX128,
            uint32 secondsOutside,
            bool initialized
        )
    {
        return (1000e18, 1000e18, 0, 0, 0, 0, 0, true);
    }

    function observe(
        uint32[] calldata
    )
        external
        pure
        override
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        )
    {
        tickCumulatives = new int56[](2);
        secondsPerLiquidityCumulativeX128s = new uint160[](2);
        return (tickCumulatives, secondsPerLiquidityCumulativeX128s);
    }

    // Mock setters for testing
    function setPrice(uint160 _sqrtPriceX96, int24 _tick) external {
        sqrtPriceX96 = _sqrtPriceX96;
        currentTick = _tick;
    }

    function setLiquidity(uint128 _liquidity) external {
        poolLiquidity = _liquidity;
    }
}

/// @title Mock Nonfungible Position Manager
/// @notice Mock position manager for testing
contract MockNonfungiblePositionManager is INonfungiblePositionManager {
    uint256 private _nextTokenId = 1;

    struct Position {
        uint96 nonce;
        address operator;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    mapping(uint256 => Position) public positionData;
    mapping(uint256 => address) public positionOwner;

    // Fees to return on collect
    uint128 public mockFees0;
    uint128 public mockFees1;

    function positions(
        uint256 tokenId
    )
        external
        view
        override
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position memory pos = positionData[tokenId];
        return (
            pos.nonce,
            pos.operator,
            pos.token0,
            pos.token1,
            pos.fee,
            pos.tickLower,
            pos.tickUpper,
            pos.liquidity,
            pos.feeGrowthInside0LastX128,
            pos.feeGrowthInside1LastX128,
            pos.tokensOwed0,
            pos.tokensOwed1
        );
    }

    function mint(
        MintParams calldata params
    )
        external
        payable
        override
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        tokenId = _nextTokenId++;

        // Transfer tokens from sender
        IERC20(params.token0).transferFrom(msg.sender, address(this), params.amount0Desired);
        IERC20(params.token1).transferFrom(msg.sender, address(this), params.amount1Desired);

        // Calculate liquidity (simplified - just use amount0 as proxy)
        liquidity = uint128(params.amount0Desired / 1e12);
        if (liquidity == 0) liquidity = 1e6;

        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;

        positionData[tokenId] = Position({
            nonce: 0,
            operator: address(0),
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            feeGrowthInside0LastX128: 0,
            feeGrowthInside1LastX128: 0,
            tokensOwed0: 0,
            tokensOwed1: 0
        });

        positionOwner[tokenId] = params.recipient;
    }

    function increaseLiquidity(
        IncreaseLiquidityParams calldata params
    ) external payable override returns (uint128 liquidity, uint256 amount0, uint256 amount1) {
        Position storage pos = positionData[params.tokenId];

        // Transfer tokens
        IERC20(pos.token0).transferFrom(msg.sender, address(this), params.amount0Desired);
        IERC20(pos.token1).transferFrom(msg.sender, address(this), params.amount1Desired);

        liquidity = uint128(params.amount0Desired / 1e12);
        if (liquidity == 0) liquidity = 1e6;

        pos.liquidity += liquidity;
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
    }

    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external payable override returns (uint256 amount0, uint256 amount1) {
        Position storage pos = positionData[params.tokenId];
        require(pos.liquidity >= params.liquidity, "Insufficient liquidity");

        pos.liquidity -= params.liquidity;

        // Return proportional amounts (simplified)
        amount0 = uint256(params.liquidity) * 1e12;
        amount1 = (uint256(params.liquidity) * 2000e6) / 1e6; // ~2000 USDC per ETH
    }

    function collect(
        CollectParams calldata params
    ) external payable override returns (uint256 amount0, uint256 amount1) {
        Position storage pos = positionData[params.tokenId];

        amount0 = mockFees0 > 0 ? mockFees0 : pos.tokensOwed0;
        amount1 = mockFees1 > 0 ? mockFees1 : pos.tokensOwed1;

        // Cap by max requested
        if (amount0 > params.amount0Max) amount0 = params.amount0Max;
        if (amount1 > params.amount1Max) amount1 = params.amount1Max;

        pos.tokensOwed0 = 0;
        pos.tokensOwed1 = 0;

        // Transfer tokens
        if (amount0 > 0) {
            IERC20(pos.token0).transfer(params.recipient, amount0);
        }
        if (amount1 > 0) {
            IERC20(pos.token1).transfer(params.recipient, amount1);
        }
    }

    function burn(uint256 tokenId) external payable override {
        require(positionData[tokenId].liquidity == 0, "Liquidity not zero");
        delete positionData[tokenId];
        delete positionOwner[tokenId];
    }

    // Mock setters
    function setMockFees(uint128 _fees0, uint128 _fees1) external {
        mockFees0 = _fees0;
        mockFees1 = _fees1;
    }

    function setTokensOwed(uint256 tokenId, uint128 _owed0, uint128 _owed1) external {
        positionData[tokenId].tokensOwed0 = _owed0;
        positionData[tokenId].tokensOwed1 = _owed1;
    }

    /// @notice Returns the address of WETH9 (mock)
    function WETH9() external pure override returns (address) {
        return address(0);
    }

    /// @notice Returns the address of the factory (mock)
    function factory() external pure override returns (address) {
        return address(0);
    }
}
