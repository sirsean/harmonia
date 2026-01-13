// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    IUniswapV3Pool,
    INonfungiblePositionManager,
    ISwapRouter
} from "./interfaces/IUniswapV3.sol";
import {AggregatorV3Interface} from "./interfaces/IChainlink.sol";
import {DeltaCalculator} from "./libraries/DeltaCalculator.sol";

/// @title Liquidity Manager
/// @notice Manages Uniswap V3 liquidity positions for the DeltaNeutralVault
/// @dev Wraps Uniswap V3 position NFTs and provides delta calculation functionality
contract LiquidityManager is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Precision for calculations (1e18)
    uint256 public constant PRECISION = 1e18;

    /// @notice Maximum slippage allowed (5%)
    uint256 public constant MAX_SLIPPAGE = 5e16;

    /// @notice Maximum fee collection amount for Uniswap
    uint128 public constant MAX_COLLECT_AMOUNT = type(uint128).max;

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Uniswap V3 Position Manager
    INonfungiblePositionManager public immutable positionManager;

    /// @notice Uniswap V3 Pool
    IUniswapV3Pool public immutable pool;

    /// @notice Swap Router for rebalancing
    ISwapRouter public immutable swapRouter;

    /// @notice Chainlink price feed for base token
    AggregatorV3Interface public immutable priceFeed;

    /// @notice Token0 of the pool (base token, e.g., WETH)
    IERC20 public immutable token0;

    /// @notice Token1 of the pool (quote token, e.g., USDC)
    IERC20 public immutable token1;

    /// @notice Pool fee tier
    uint24 public immutable poolFee;

    /// @notice Current position NFT token ID (0 if no position)
    uint256 public positionTokenId;

    /// @notice Authorized vault address
    address public vault;

    /// @notice Default slippage tolerance (scaled by 1e18, e.g., 0.5% = 0.005e18)
    uint256 public slippageTolerance;

    /// @notice Cumulative fees collected in token0
    uint256 public cumulativeFeesToken0;

    /// @notice Cumulative fees collected in token1
    uint256 public cumulativeFeesToken1;

    // ═══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Position information
    struct PositionInfo {
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    /// @notice Parameters for opening a new position
    struct OpenPositionParams {
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event PositionOpened(
        uint256 indexed tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );

    event PositionClosed(
        uint256 indexed tokenId,
        uint256 amount0,
        uint256 amount1,
        uint256 fee0,
        uint256 fee1
    );

    event LiquidityIncreased(
        uint256 indexed tokenId,
        uint128 liquidityAdded,
        uint256 amount0,
        uint256 amount1
    );

    event LiquidityDecreased(
        uint256 indexed tokenId,
        uint128 liquidityRemoved,
        uint256 amount0,
        uint256 amount1
    );

    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);

    event PositionRebalanced(
        uint256 oldTokenId,
        uint256 newTokenId,
        int24 newTickLower,
        int24 newTickUpper
    );

    event VaultUpdated(address indexed oldVault, address indexed newVault);

    event SlippageToleranceUpdated(uint256 oldTolerance, uint256 newTolerance);

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidAddress();
    error InvalidTickRange();
    error PositionAlreadyExists();
    error NoActivePosition();
    error UnauthorizedCaller();
    error SlippageTooHigh();
    error InsufficientLiquidity();
    error DeadlineExpired();
    error TransferFailed();

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Restricts function access to the vault or owner
    modifier onlyVaultOrOwner() {
        if (msg.sender != vault && msg.sender != owner()) {
            revert UnauthorizedCaller();
        }
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Constructs the LiquidityManager
    /// @param _positionManager Uniswap V3 NonfungiblePositionManager address
    /// @param _pool Uniswap V3 Pool address
    /// @param _swapRouter Uniswap V3 SwapRouter address
    /// @param _priceFeed Chainlink price feed for base token
    /// @param _owner Initial owner address
    constructor(
        address _positionManager,
        address _pool,
        address _swapRouter,
        address _priceFeed,
        address _owner
    ) Ownable(_owner) {
        if (
            _positionManager == address(0) ||
            _pool == address(0) ||
            _swapRouter == address(0) ||
            _priceFeed == address(0)
        ) {
            revert InvalidAddress();
        }

        positionManager = INonfungiblePositionManager(_positionManager);
        pool = IUniswapV3Pool(_pool);
        swapRouter = ISwapRouter(_swapRouter);
        priceFeed = AggregatorV3Interface(_priceFeed);

        token0 = IERC20(pool.token0());
        token1 = IERC20(pool.token1());
        poolFee = pool.fee();

        slippageTolerance = 5e15; // 0.5% default
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS - POSITION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Opens a new Uniswap V3 position
    /// @param params Position parameters
    /// @return tokenId NFT token ID of the new position
    /// @return liquidity Amount of liquidity minted
    /// @return amount0 Amount of token0 deposited
    /// @return amount1 Amount of token1 deposited
    function openPosition(
        OpenPositionParams calldata params
    )
        external
        onlyVaultOrOwner
        nonReentrant
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (positionTokenId != 0) {
            revert PositionAlreadyExists();
        }
        if (params.tickLower >= params.tickUpper) {
            revert InvalidTickRange();
        }
        if (block.timestamp > params.deadline) {
            revert DeadlineExpired();
        }

        // Transfer tokens from caller
        token0.safeTransferFrom(msg.sender, address(this), params.amount0Desired);
        token1.safeTransferFrom(msg.sender, address(this), params.amount1Desired);

        // Approve position manager
        token0.safeIncreaseAllowance(address(positionManager), params.amount0Desired);
        token1.safeIncreaseAllowance(address(positionManager), params.amount1Desired);

        // Mint position
        INonfungiblePositionManager.MintParams memory mintParams = INonfungiblePositionManager
            .MintParams({
                token0: address(token0),
                token1: address(token1),
                fee: poolFee,
                tickLower: params.tickLower,
                tickUpper: params.tickUpper,
                amount0Desired: params.amount0Desired,
                amount1Desired: params.amount1Desired,
                amount0Min: params.amount0Min,
                amount1Min: params.amount1Min,
                recipient: address(this),
                deadline: params.deadline
            });

        (tokenId, liquidity, amount0, amount1) = positionManager.mint(mintParams);
        positionTokenId = tokenId;

        // Refund unused tokens
        _refundUnusedTokens(params.amount0Desired - amount0, params.amount1Desired - amount1);

        emit PositionOpened(
            tokenId,
            params.tickLower,
            params.tickUpper,
            liquidity,
            amount0,
            amount1
        );
    }

    /// @notice Closes the current position and withdraws all liquidity
    /// @param amount0Min Minimum amount of token0 to receive
    /// @param amount1Min Minimum amount of token1 to receive
    /// @param deadline Transaction deadline
    /// @return amount0 Amount of token0 withdrawn
    /// @return amount1 Amount of token1 withdrawn
    /// @return fee0 Fees collected in token0
    /// @return fee1 Fees collected in token1
    function closePosition(
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    )
        external
        onlyVaultOrOwner
        nonReentrant
        returns (uint256 amount0, uint256 amount1, uint256 fee0, uint256 fee1)
    {
        if (positionTokenId == 0) {
            revert NoActivePosition();
        }
        if (block.timestamp > deadline) {
            revert DeadlineExpired();
        }

        uint256 tokenId = positionTokenId;

        // Get position info
        (, , , , , , , uint128 liquidity, , , , ) = positionManager.positions(tokenId);

        // Decrease liquidity to 0
        if (liquidity > 0) {
            INonfungiblePositionManager.DecreaseLiquidityParams
                memory decreaseParams = INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liquidity,
                    amount0Min: amount0Min,
                    amount1Min: amount1Min,
                    deadline: deadline
                });

            (amount0, amount1) = positionManager.decreaseLiquidity(decreaseParams);
        }

        // Collect all tokens (including fees)
        INonfungiblePositionManager.CollectParams memory collectParams = INonfungiblePositionManager
            .CollectParams({
                tokenId: tokenId,
                recipient: msg.sender,
                amount0Max: MAX_COLLECT_AMOUNT,
                amount1Max: MAX_COLLECT_AMOUNT
            });

        (uint256 collected0, uint256 collected1) = positionManager.collect(collectParams);

        // Calculate fees (collected - liquidity amounts)
        fee0 = collected0 > amount0 ? collected0 - amount0 : 0;
        fee1 = collected1 > amount1 ? collected1 - amount1 : 0;

        // Update cumulative fees
        cumulativeFeesToken0 += fee0;
        cumulativeFeesToken1 += fee1;

        // Burn the NFT
        positionManager.burn(tokenId);
        positionTokenId = 0;

        emit PositionClosed(tokenId, amount0, amount1, fee0, fee1);
    }

    /// @notice Increases liquidity in the current position
    /// @param amount0Desired Desired amount of token0 to add
    /// @param amount1Desired Desired amount of token1 to add
    /// @param amount0Min Minimum amount of token0 to add
    /// @param amount1Min Minimum amount of token1 to add
    /// @param deadline Transaction deadline
    /// @return liquidity Amount of liquidity added
    /// @return amount0 Actual amount of token0 added
    /// @return amount1 Actual amount of token1 added
    function increaseLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    )
        external
        onlyVaultOrOwner
        nonReentrant
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (positionTokenId == 0) {
            revert NoActivePosition();
        }
        if (block.timestamp > deadline) {
            revert DeadlineExpired();
        }

        // Transfer tokens from caller
        token0.safeTransferFrom(msg.sender, address(this), amount0Desired);
        token1.safeTransferFrom(msg.sender, address(this), amount1Desired);

        // Approve position manager
        token0.safeIncreaseAllowance(address(positionManager), amount0Desired);
        token1.safeIncreaseAllowance(address(positionManager), amount1Desired);

        INonfungiblePositionManager.IncreaseLiquidityParams
            memory params = INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: positionTokenId,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: deadline
            });

        (liquidity, amount0, amount1) = positionManager.increaseLiquidity(params);

        // Refund unused tokens
        _refundUnusedTokens(amount0Desired - amount0, amount1Desired - amount1);

        emit LiquidityIncreased(positionTokenId, liquidity, amount0, amount1);
    }

    /// @notice Decreases liquidity in the current position
    /// @param liquidityToRemove Amount of liquidity to remove
    /// @param amount0Min Minimum amount of token0 to receive
    /// @param amount1Min Minimum amount of token1 to receive
    /// @param deadline Transaction deadline
    /// @return amount0 Amount of token0 received
    /// @return amount1 Amount of token1 received
    function decreaseLiquidity(
        uint128 liquidityToRemove,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external onlyVaultOrOwner nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (positionTokenId == 0) {
            revert NoActivePosition();
        }
        if (block.timestamp > deadline) {
            revert DeadlineExpired();
        }

        INonfungiblePositionManager.DecreaseLiquidityParams
            memory params = INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: positionTokenId,
                liquidity: liquidityToRemove,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: deadline
            });

        (amount0, amount1) = positionManager.decreaseLiquidity(params);

        // Collect the tokens
        INonfungiblePositionManager.CollectParams memory collectParams = INonfungiblePositionManager
            .CollectParams({
                tokenId: positionTokenId,
                recipient: msg.sender,
                amount0Max: uint128(amount0),
                amount1Max: uint128(amount1)
            });

        positionManager.collect(collectParams);

        emit LiquidityDecreased(positionTokenId, liquidityToRemove, amount0, amount1);
    }

    /// @notice Collects accumulated fees from the position
    /// @return amount0 Fees collected in token0
    /// @return amount1 Fees collected in token1
    function collectFees()
        external
        onlyVaultOrOwner
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (positionTokenId == 0) {
            revert NoActivePosition();
        }

        INonfungiblePositionManager.CollectParams memory params = INonfungiblePositionManager
            .CollectParams({
                tokenId: positionTokenId,
                recipient: msg.sender,
                amount0Max: MAX_COLLECT_AMOUNT,
                amount1Max: MAX_COLLECT_AMOUNT
            });

        (amount0, amount1) = positionManager.collect(params);

        cumulativeFeesToken0 += amount0;
        cumulativeFeesToken1 += amount1;

        emit FeesCollected(positionTokenId, amount0, amount1);
    }

    /// @notice Rebalances the position to a new tick range
    /// @dev Closes current position and opens a new one with the new range
    /// @param newTickLower New lower tick
    /// @param newTickUpper New upper tick
    /// @param deadline Transaction deadline
    /// @return newTokenId New position token ID
    /// @return newLiquidity New position liquidity
    function rebalance(
        int24 newTickLower,
        int24 newTickUpper,
        uint256 deadline
    ) external onlyVaultOrOwner nonReentrant returns (uint256 newTokenId, uint128 newLiquidity) {
        if (positionTokenId == 0) {
            revert NoActivePosition();
        }
        if (newTickLower >= newTickUpper) {
            revert InvalidTickRange();
        }
        if (block.timestamp > deadline) {
            revert DeadlineExpired();
        }

        uint256 oldTokenId = positionTokenId;

        // Get current position liquidity
        (, , , , , , , uint128 currentLiquidity, , , , ) = positionManager.positions(oldTokenId);

        // Calculate minimum amounts with slippage
        (uint256 estAmount0, uint256 estAmount1) = _estimateWithdrawAmounts(currentLiquidity);
        uint256 amount0Min = (estAmount0 * (PRECISION - slippageTolerance)) / PRECISION;
        uint256 amount1Min = (estAmount1 * (PRECISION - slippageTolerance)) / PRECISION;

        // Decrease all liquidity
        INonfungiblePositionManager.DecreaseLiquidityParams
            memory decreaseParams = INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: oldTokenId,
                liquidity: currentLiquidity,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: deadline
            });

        positionManager.decreaseLiquidity(decreaseParams);

        // Collect all tokens including fees
        INonfungiblePositionManager.CollectParams memory collectParams = INonfungiblePositionManager
            .CollectParams({
                tokenId: oldTokenId,
                recipient: address(this),
                amount0Max: MAX_COLLECT_AMOUNT,
                amount1Max: MAX_COLLECT_AMOUNT
            });

        (uint256 collected0, uint256 collected1) = positionManager.collect(collectParams);

        // Burn old position
        positionManager.burn(oldTokenId);
        positionTokenId = 0;

        // Approve tokens for new position
        token0.safeIncreaseAllowance(address(positionManager), collected0);
        token1.safeIncreaseAllowance(address(positionManager), collected1);

        // Calculate min amounts for new position
        uint256 newAmount0Min = (collected0 * (PRECISION - slippageTolerance)) / PRECISION;
        uint256 newAmount1Min = (collected1 * (PRECISION - slippageTolerance)) / PRECISION;

        // Mint new position with new range
        INonfungiblePositionManager.MintParams memory mintParams = INonfungiblePositionManager
            .MintParams({
                token0: address(token0),
                token1: address(token1),
                fee: poolFee,
                tickLower: newTickLower,
                tickUpper: newTickUpper,
                amount0Desired: collected0,
                amount1Desired: collected1,
                amount0Min: newAmount0Min,
                amount1Min: newAmount1Min,
                recipient: address(this),
                deadline: deadline
            });

        uint256 amount0Used;
        uint256 amount1Used;
        (newTokenId, newLiquidity, amount0Used, amount1Used) = positionManager.mint(mintParams);
        positionTokenId = newTokenId;

        // Refund unused tokens to vault
        if (collected0 > amount0Used) {
            token0.safeTransfer(msg.sender, collected0 - amount0Used);
        }
        if (collected1 > amount1Used) {
            token1.safeTransfer(msg.sender, collected1 - amount1Used);
        }

        emit PositionRebalanced(oldTokenId, newTokenId, newTickLower, newTickUpper);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS - VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Gets the current position information
    /// @return info Position information struct
    function getPositionInfo() external view returns (PositionInfo memory info) {
        if (positionTokenId == 0) {
            return info;
        }

        (
            ,
            ,
            ,
            ,
            ,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        ) = positionManager.positions(positionTokenId);

        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

        uint256 amount0 = DeltaCalculator.getBaseTokenAmount(
            sqrtPriceX96,
            _tickToSqrtPriceX96(tickLower),
            _tickToSqrtPriceX96(tickUpper),
            liquidity
        );

        uint256 amount1 = DeltaCalculator.getQuoteTokenAmount(
            sqrtPriceX96,
            _tickToSqrtPriceX96(tickLower),
            _tickToSqrtPriceX96(tickUpper),
            liquidity
        );

        info = PositionInfo({
            tokenId: positionTokenId,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            amount0: amount0,
            amount1: amount1,
            feeGrowthInside0LastX128: feeGrowthInside0LastX128,
            feeGrowthInside1LastX128: feeGrowthInside1LastX128,
            tokensOwed0: tokensOwed0,
            tokensOwed1: tokensOwed1
        });
    }

    /// @notice Gets the current delta of the position
    /// @return delta Position delta (exposure to base token)
    function getPositionDelta() external view returns (int256 delta) {
        if (positionTokenId == 0) {
            return 0;
        }

        (, , , , , int24 tickLower, int24 tickUpper, uint128 liquidity, , , , ) = positionManager
            .positions(positionTokenId);

        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

        delta = DeltaCalculator.calculateDelta(
            sqrtPriceX96,
            _tickToSqrtPriceX96(tickLower),
            _tickToSqrtPriceX96(tickUpper),
            liquidity
        );
    }

    /// @notice Gets the delta ratio (0 to 1e18)
    /// @return deltaRatio Position delta as a ratio
    function getDeltaRatio() external view returns (uint256 deltaRatio) {
        if (positionTokenId == 0) {
            return 0;
        }

        (, , , , , int24 tickLower, int24 tickUpper, , , , , ) = positionManager.positions(
            positionTokenId
        );

        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

        deltaRatio = DeltaCalculator.calculateDeltaRatio(
            sqrtPriceX96,
            _tickToSqrtPriceX96(tickLower),
            _tickToSqrtPriceX96(tickUpper)
        );
    }

    /// @notice Gets the total position value in quote token terms
    /// @return value Position value in token1 (quote token)
    function getPositionValue() external view returns (uint256 value) {
        if (positionTokenId == 0) {
            return 0;
        }

        (, , , , , int24 tickLower, int24 tickUpper, uint128 liquidity, , , , ) = positionManager
            .positions(positionTokenId);

        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

        value = DeltaCalculator.getPositionValue(
            sqrtPriceX96,
            _tickToSqrtPriceX96(tickLower),
            _tickToSqrtPriceX96(tickUpper),
            liquidity
        );
    }

    /// @notice Gets the position gamma (volatility exposure)
    /// @return gamma Position gamma (negative = short volatility)
    function getPositionGamma() external view returns (int256 gamma) {
        if (positionTokenId == 0) {
            return 0;
        }

        (, , , , , int24 tickLower, int24 tickUpper, uint128 liquidity, , , , ) = positionManager
            .positions(positionTokenId);

        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

        gamma = DeltaCalculator.calculateGamma(
            sqrtPriceX96,
            _tickToSqrtPriceX96(tickLower),
            _tickToSqrtPriceX96(tickUpper),
            liquidity
        );
    }

    /// @notice Gets the current pool price
    /// @return sqrtPriceX96 Current sqrt price in Q64.96 format
    /// @return tick Current tick
    function getCurrentPrice() external view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick, , , , , ) = pool.slot0();
    }

    /// @notice Gets the current ETH price from Chainlink
    /// @return price ETH price in USD (8 decimals)
    function getOraclePrice() external view returns (uint256 price) {
        (, int256 answer, , uint256 updatedAt, ) = priceFeed.latestRoundData();
        require(answer > 0, "Invalid price");
        require(block.timestamp - updatedAt < 1 hours, "Stale price");
        price = uint256(answer);
    }

    /// @notice Checks if the position is in range
    /// @return inRange True if position is in range
    function isPositionInRange() external view returns (bool inRange) {
        if (positionTokenId == 0) {
            return false;
        }

        (, , , , , int24 tickLower, int24 tickUpper, , , , , ) = positionManager.positions(
            positionTokenId
        );

        (, int24 currentTick, , , , , ) = pool.slot0();

        inRange = currentTick >= tickLower && currentTick < tickUpper;
    }

    /// @notice Gets cumulative fees collected
    /// @return fees0 Cumulative fees in token0
    /// @return fees1 Cumulative fees in token1
    function getCumulativeFees() external view returns (uint256 fees0, uint256 fees1) {
        fees0 = cumulativeFeesToken0;
        fees1 = cumulativeFeesToken1;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS - ADMIN
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Sets the authorized vault address
    /// @param _vault New vault address
    function setVault(address _vault) external onlyOwner {
        if (_vault == address(0)) {
            revert InvalidAddress();
        }
        address oldVault = vault;
        vault = _vault;
        emit VaultUpdated(oldVault, _vault);
    }

    /// @notice Sets the slippage tolerance
    /// @param _slippageTolerance New slippage tolerance (scaled by 1e18)
    function setSlippageTolerance(uint256 _slippageTolerance) external onlyOwner {
        if (_slippageTolerance > MAX_SLIPPAGE) {
            revert SlippageTooHigh();
        }
        uint256 oldTolerance = slippageTolerance;
        slippageTolerance = _slippageTolerance;
        emit SlippageToleranceUpdated(oldTolerance, _slippageTolerance);
    }

    /// @notice Emergency function to recover stuck tokens
    /// @param token Token address to recover
    /// @param to Recipient address
    /// @param amount Amount to recover
    function emergencyRecover(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) {
            revert InvalidAddress();
        }
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Refunds unused tokens to the sender
    /// @param amount0 Amount of token0 to refund
    /// @param amount1 Amount of token1 to refund
    function _refundUnusedTokens(uint256 amount0, uint256 amount1) internal {
        if (amount0 > 0) {
            token0.safeTransfer(msg.sender, amount0);
        }
        if (amount1 > 0) {
            token1.safeTransfer(msg.sender, amount1);
        }
    }

    /// @notice Estimates withdrawal amounts for given liquidity
    /// @param liquidity Liquidity amount
    /// @return amount0 Estimated token0 amount
    /// @return amount1 Estimated token1 amount
    function _estimateWithdrawAmounts(
        uint128 liquidity
    ) internal view returns (uint256 amount0, uint256 amount1) {
        (, , , , , int24 tickLower, int24 tickUpper, , , , , ) = positionManager.positions(
            positionTokenId
        );

        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

        amount0 = DeltaCalculator.getBaseTokenAmount(
            sqrtPriceX96,
            _tickToSqrtPriceX96(tickLower),
            _tickToSqrtPriceX96(tickUpper),
            liquidity
        );

        amount1 = DeltaCalculator.getQuoteTokenAmount(
            sqrtPriceX96,
            _tickToSqrtPriceX96(tickLower),
            _tickToSqrtPriceX96(tickUpper),
            liquidity
        );
    }

    /// @notice Converts a tick to sqrtPriceX96
    /// @param tick The tick value
    /// @return sqrtPriceX96 The sqrt price in Q64.96 format
    function _tickToSqrtPriceX96(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        // Using the formula: sqrtPrice = 1.0001^(tick/2)
        // For precision, we use a lookup table approach or calculation
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= uint256(int256(type(int24).max)), "Tick out of bounds");

        // Start with Q96 (representing 1.0)
        uint256 ratio = 0x100000000000000000000000000000000;

        // Multiply by each bit's contribution
        if (absTick & 0x1 != 0) ratio = (ratio * 0xfffcb933bd6fad37aa2d162d1a594001) >> 128;
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

        // Shift to Q96 format
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}
