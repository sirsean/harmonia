// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title Mock Uniswap V3 Pool
/// @notice Mock pool for testing
contract MockUniswapV3Pool {
    uint160 public sqrtPriceX96;
    int24 public currentTick;
    uint24 public fee;
    address public token0;
    address public token1;
    uint128 public poolLiquidity;

    constructor(address _token0, address _token1, uint24 _fee) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        // Default to price of ~2000 (WETH/USDC typical range)
        sqrtPriceX96 = 3543191142285914205922034323; // sqrt(2000) * 2^96
        currentTick = 74959; // Corresponding tick for ~2000 USDC per ETH
    }

    function slot0()
        external
        view
        returns (
            uint160,
            int24,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (sqrtPriceX96, currentTick, 0, 1, 1, 0, true);
    }

    function liquidity() external view returns (uint128) {
        return poolLiquidity;
    }

    function tickSpacing() external pure returns (int24) {
        return 10; // Common for 0.05% pools
    }

    // Test helpers
    function setSqrtPriceX96(uint160 _sqrtPriceX96) external {
        sqrtPriceX96 = _sqrtPriceX96;
    }

    function setCurrentTick(int24 _tick) external {
        currentTick = _tick;
    }

    function setLiquidity(uint128 _liquidity) external {
        poolLiquidity = _liquidity;
    }
}

/// @title Mock Uniswap V3 Factory
/// @notice Mock factory for testing
contract MockUniswapV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public pools;

    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external returns (address pool) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pool = address(new MockUniswapV3Pool(token0, token1, fee));
        pools[token0][token1][fee] = pool;
        pools[token1][token0][fee] = pool;
        return pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return pools[token0][token1][fee];
    }

    // Helper to set pool directly
    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[tokenA][tokenB][fee] = pool;
        pools[tokenB][tokenA][fee] = pool;
    }
}

/// @title Mock Nonfungible Position Manager
/// @notice Mock position manager for testing LP operations
contract MockNonfungiblePositionManager is ERC721 {
    using SafeERC20 for IERC20;

    uint256 private _nextTokenId = 1;

    struct Position {
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

    // Simulated fee accumulation
    uint256 public feeGrowth0;
    uint256 public feeGrowth1;

    address public factoryAddress;

    constructor() ERC721("Uniswap V3 Positions", "UNI-V3-POS") {}

    function setFactory(address _factory) external {
        factoryAddress = _factory;
    }

    function factory() external view returns (address) {
        return factoryAddress;
    }

    function WETH9() external pure returns (address) {
        return address(0); // Not used in tests
    }

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(
        MintParams calldata params
    )
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "Expired");
        require(params.tickLower < params.tickUpper, "Invalid tick range");

        tokenId = _nextTokenId++;

        // Calculate liquidity from amounts (simplified)
        liquidity = uint128((params.amount0Desired + params.amount1Desired) / 2);
        if (liquidity == 0) liquidity = 1;

        // Use desired amounts (in real world, this would be calculated precisely)
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;

        require(amount0 >= params.amount0Min, "Slippage check 0");
        require(amount1 >= params.amount1Min, "Slippage check 1");

        // Transfer tokens from caller
        if (amount0 > 0) {
            IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        }
        if (amount1 > 0) {
            IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);
        }

        // Store position
        positionData[tokenId] = Position({
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

        _mint(params.recipient, tokenId);
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function increaseLiquidity(
        IncreaseLiquidityParams calldata params
    ) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1) {
        require(block.timestamp <= params.deadline, "Expired");
        require(_ownerOf(params.tokenId) != address(0), "Invalid token");

        Position storage pos = positionData[params.tokenId];

        liquidity = uint128((params.amount0Desired + params.amount1Desired) / 2);
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;

        require(amount0 >= params.amount0Min, "Slippage check 0");
        require(amount1 >= params.amount1Min, "Slippage check 1");

        // Transfer tokens
        if (amount0 > 0) {
            IERC20(pos.token0).safeTransferFrom(msg.sender, address(this), amount0);
        }
        if (amount1 > 0) {
            IERC20(pos.token1).safeTransferFrom(msg.sender, address(this), amount1);
        }

        pos.liquidity += liquidity;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1) {
        require(block.timestamp <= params.deadline, "Expired");

        Position storage pos = positionData[params.tokenId];
        require(params.liquidity <= pos.liquidity, "Insufficient liquidity");

        // Calculate amounts proportional to liquidity removed
        // In a real implementation, this would be based on current price
        uint256 totalLiquidity = pos.liquidity;
        amount0 = (IERC20(pos.token0).balanceOf(address(this)) * params.liquidity) / totalLiquidity;
        amount1 = (IERC20(pos.token1).balanceOf(address(this)) * params.liquidity) / totalLiquidity;

        require(amount0 >= params.amount0Min, "Slippage check 0");
        require(amount1 >= params.amount1Min, "Slippage check 1");

        pos.liquidity -= params.liquidity;
        pos.tokensOwed0 += uint128(amount0);
        pos.tokensOwed1 += uint128(amount1);
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(
        CollectParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1) {
        Position storage pos = positionData[params.tokenId];

        amount0 = pos.tokensOwed0 > params.amount0Max ? params.amount0Max : pos.tokensOwed0;
        amount1 = pos.tokensOwed1 > params.amount1Max ? params.amount1Max : pos.tokensOwed1;

        if (amount0 > 0) {
            pos.tokensOwed0 -= uint128(amount0);
            IERC20(pos.token0).safeTransfer(params.recipient, amount0);
        }
        if (amount1 > 0) {
            pos.tokensOwed1 -= uint128(amount1);
            IERC20(pos.token1).safeTransfer(params.recipient, amount1);
        }
    }

    function burn(uint256 tokenId) external payable {
        Position storage pos = positionData[tokenId];
        require(pos.liquidity == 0, "Not empty");
        require(pos.tokensOwed0 == 0 && pos.tokensOwed1 == 0, "Tokens owed");

        _burn(tokenId);
        delete positionData[tokenId];
    }

    function positions(
        uint256 tokenId
    )
        external
        view
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
            0,
            address(0),
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

    // Test helpers
    function setTokensOwed(uint256 tokenId, uint128 owed0, uint128 owed1) external {
        positionData[tokenId].tokensOwed0 = owed0;
        positionData[tokenId].tokensOwed1 = owed1;
    }

    function setLiquidity(uint256 tokenId, uint128 _liquidity) external {
        positionData[tokenId].liquidity = _liquidity;
    }
}

/// @title Mock Swap Router
/// @notice Mock router for testing swaps
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    // Exchange rate for mock (1 ETH = 2000 USDC)
    uint256 public ethPriceInUsdc = 2000e6;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        require(block.timestamp <= params.deadline, "Expired");

        // Simple mock: convert at fixed rate
        // Assuming WETH has 18 decimals and USDC has 6 decimals
        amountOut = (params.amountIn * ethPriceInUsdc) / 1e18;

        require(amountOut >= params.amountOutMinimum, "Slippage");

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(
        ExactOutputSingleParams calldata params
    ) external payable returns (uint256 amountIn) {
        require(block.timestamp <= params.deadline, "Expired");

        // Calculate input needed
        amountIn = (params.amountOut * 1e18) / ethPriceInUsdc;

        require(amountIn <= params.amountInMaximum, "Slippage");

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, params.amountOut);
    }

    // Test helper
    function setEthPrice(uint256 _price) external {
        ethPriceInUsdc = _price;
    }
}
