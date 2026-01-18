// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {
    INonfungiblePositionManager,
    IUniswapV3Pool,
    ISwapRouter,
    IUniswapV3Factory
} from "../interfaces/IUniswapV3.sol";
import {DeltaCalculator} from "../libraries/DeltaCalculator.sol";
import {SecurityModule} from "../libraries/SecurityModule.sol";
import {IChainlinkPriceFeed} from "../interfaces/IChainlink.sol";
import {ILiquidityManager} from "../interfaces/ILiquidityManager.sol";

/// @title Liquidity Manager
/// @notice Manages Uniswap V3 LP positions for the delta-neutral vault
/// @dev Handles minting, fee collection, liquidity adjustments, and range rebalancing
contract LiquidityManager is
    ILiquidityManager,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Precision for percentage calculations (1e18 = 100%)
    uint256 public constant PRECISION = 1e18;

    /// @notice Maximum slippage tolerance (1% = 1e16)
    uint256 public constant MAX_SLIPPAGE = 1e16;

    /// @notice Default slippage tolerance (0.5% = 5e15)
    uint256 public constant DEFAULT_SLIPPAGE = 5e15;

    // ============ Storage Variables (Converted from Immutables) ============

    /// @notice Uniswap V3 NonfungiblePositionManager
    INonfungiblePositionManager public positionManager;

    /// @notice Uniswap V3 SwapRouter
    ISwapRouter public swapRouter;

    /// @notice Uniswap V3 Factory
    IUniswapV3Factory public factory;

    /// @notice Base token (e.g., WETH)
    address public baseToken;

    /// @notice Quote token (e.g., USDC)
    address public quoteToken;

    /// @notice Pool fee tier
    uint24 public poolFee;

    // ============ State Variables ============

    /// @notice TWAP observation period for price validation (default 30 minutes)
    uint32 public twapPeriod;

    /// @notice Maximum acceptable TWAP deviation from spot (default 3%)
    uint256 public maxTwapDeviation;

    /// @notice Address of the vault that owns this manager
    address public vault;

    /// @notice Current LP position token ID (0 if no position)
    uint256 public tokenId;

    /// @notice Current position lower tick
    int24 public tickLower;

    /// @notice Current position upper tick
    int24 public tickUpper;

    /// @notice Current position liquidity
    uint128 public liquidity;

    /// @notice Slippage tolerance for operations
    uint256 public slippageTolerance;

    /// @notice Total fees collected in token0
    uint256 public totalFeesCollected0;

    /// @notice Total fees collected in token1
    uint256 public totalFeesCollected1;

    /// @notice Optional Chainlink price feed for validation
    IChainlinkPriceFeed public priceFeed;

    /// @notice Enable/disable TWAP validation
    bool public twapValidationEnabled;

    // ============ Gap for Upgradeability ============
    uint256[50] private __gap;

    // ============ Events ============

    /// @notice Emitted when a new position is minted
    event PositionMinted(
        uint256 indexed tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );

    /// @notice Emitted when liquidity is increased
    event LiquidityIncreased(
        uint256 indexed tokenId,
        uint128 liquidityAdded,
        uint256 amount0,
        uint256 amount1
    );

    /// @notice Emitted when liquidity is decreased
    event LiquidityDecreased(
        uint256 indexed tokenId,
        uint128 liquidityRemoved,
        uint256 amount0,
        uint256 amount1
    );

    /// @notice Emitted when fees are collected
    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);

    /// @notice Emitted when position range is adjusted
    event RangeAdjusted(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        int24 oldTickLower,
        int24 oldTickUpper,
        int24 newTickLower,
        int24 newTickUpper
    );

    /// @notice Emitted when position is closed
    event PositionClosed(uint256 indexed tokenId, uint256 amount0, uint256 amount1);

    /// @notice Emitted when vault address is updated
    event VaultUpdated(address indexed oldVault, address indexed newVault);

    /// @notice Emitted when slippage tolerance is updated
    event SlippageToleranceUpdated(uint256 oldSlippage, uint256 newSlippage);

    /// @notice Emitted when TWAP validation status changes
    event TWAPValidationUpdated(bool enabled);

    /// @notice Emitted when PriceFeedUpdated is emitted
    event PriceFeedUpdated(address indexed oldFeed, address indexed newFeed);

    /// @notice Emitted when TWAP period is updated
    event TWAPPeriodUpdated(uint32 oldPeriod, uint32 newPeriod);

    /// @notice Emitted when max TWAP deviation is updated
    event MaxTWAPDeviationUpdated(uint256 oldDeviation, uint256 newDeviation);

    // ============ Errors ============

    /// @notice Thrown when caller is not the vault
    error OnlyVault();

    /// @notice Thrown when position already exists
    error PositionExists();

    /// @notice Thrown when no position exists
    error NoPosition();

    /// @notice Thrown when invalid tick range provided
    error InvalidTickRange();

    /// @notice Thrown when zero amount provided
    error ZeroAmount();

    /// @notice Thrown when zero address provided
    error ZeroAddress();

    /// @notice Thrown when slippage is too high
    error SlippageTooHigh();

    /// @notice Thrown when swap fails
    error SwapFailed();

    /// @notice Thrown when deadline expired
    error DeadlineExpired();

    /// @notice Thrown when spot price deviates too much from TWAP
    error TWAPDeviationTooHigh(uint256 spotPrice, uint256 twapPrice, uint256 deviation);

    /// @notice Thrown when TWAP observation is not available
    error TWAPNotAvailable();

    // ============ Modifiers ============

    /// @notice Restricts function to vault only
    modifier onlyVault() {
        if (msg.sender != vault && msg.sender != owner()) {
            revert OnlyVault();
        }
        _;
    }

    // ============ Initializer ============

    /// @notice Initialize the liquidity manager
    /// @param _positionManager Uniswap V3 NonfungiblePositionManager address
    /// @param _swapRouter Uniswap V3 SwapRouter address
    /// @param _factory Uniswap V3 Factory address
    /// @param _baseToken Base token address (e.g., WETH)
    /// @param _quoteToken Quote token address (e.g., USDC)
    /// @param _poolFee Pool fee tier (e.g., 500 for 0.05%)
    /// @param _owner Owner address
    function initialize(
        address _positionManager,
        address _swapRouter,
        address _factory,
        address _baseToken,
        address _quoteToken,
        uint24 _poolFee,
        address _owner
    ) public initializer {
        if (_positionManager == address(0)) revert ZeroAddress();
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (_factory == address(0)) revert ZeroAddress();
        if (_baseToken == address(0)) revert ZeroAddress();
        if (_quoteToken == address(0)) revert ZeroAddress();

        __Ownable_init(_owner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        positionManager = INonfungiblePositionManager(_positionManager);
        swapRouter = ISwapRouter(_swapRouter);
        factory = IUniswapV3Factory(_factory);
        baseToken = _baseToken;
        quoteToken = _quoteToken;
        poolFee = _poolFee;
        slippageTolerance = DEFAULT_SLIPPAGE;

        // Initialize configurable parameters
        twapPeriod = 30 minutes;
        maxTwapDeviation = 3e16; // 3%
    }

    /// @dev Authorize upgrade - only owner can upgrade
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ============ External Functions ============

    /// @notice Set the vault address
    /// @param _vault New vault address
    function setVault(address _vault) external onlyOwner {
        if (_vault == address(0)) revert ZeroAddress();
        address oldVault = vault;
        vault = _vault;
        emit VaultUpdated(oldVault, _vault);
    }

    /// @notice Set slippage tolerance
    /// @param _slippageTolerance New slippage tolerance (scaled by 1e18)
    function setSlippageTolerance(uint256 _slippageTolerance) external onlyOwner {
        if (_slippageTolerance > MAX_SLIPPAGE) revert SlippageTooHigh();
        uint256 oldSlippage = slippageTolerance;
        slippageTolerance = _slippageTolerance;
        emit SlippageToleranceUpdated(oldSlippage, _slippageTolerance);
    }

    /// @notice Set the Chainlink price feed for validation
    /// @param _priceFeed New price feed address (address(0) to disable)
    function setPriceFeed(address _priceFeed) external onlyOwner {
        address oldFeed = address(priceFeed);
        priceFeed = IChainlinkPriceFeed(_priceFeed);
        emit PriceFeedUpdated(oldFeed, _priceFeed);
    }

    /// @notice Enable or disable TWAP validation
    /// @param _enabled Whether to enable TWAP validation
    function setTWAPValidation(bool _enabled) external onlyOwner {
        twapValidationEnabled = _enabled;
        emit TWAPValidationUpdated(_enabled);
    }

    /// @notice Set TWAP period
    /// @param _twapPeriod New TWAP period in seconds
    function setTWAPPeriod(uint32 _twapPeriod) external onlyOwner {
        uint32 oldPeriod = twapPeriod;
        twapPeriod = _twapPeriod;
        emit TWAPPeriodUpdated(oldPeriod, _twapPeriod);
    }

    /// @notice Set max TWAP deviation
    /// @param _maxTwapDeviation New max deviation (scaled by 1e18)
    function setMaxTwapDeviation(uint256 _maxTwapDeviation) external onlyOwner {
        uint256 oldDeviation = maxTwapDeviation;
        maxTwapDeviation = _maxTwapDeviation;
        emit MaxTWAPDeviationUpdated(oldDeviation, _maxTwapDeviation);
    }

    /// @notice Mint a new LP position
    /// @param _tickLower Lower tick of the position range
    /// @param _tickUpper Upper tick of the position range
    /// @param amount0Desired Amount of token0 to deposit
    /// @param amount1Desired Amount of token1 to deposit
    /// @param deadline Transaction deadline
    /// @return _tokenId The minted position token ID
    /// @return _liquidity The amount of liquidity minted
    /// @return amount0 Actual amount of token0 deposited
    /// @return amount1 Actual amount of token1 deposited
    function mintPosition(
        int24 _tickLower,
        int24 _tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 deadline
    )
        external
        onlyVault
        nonReentrant
        returns (uint256 _tokenId, uint128 _liquidity, uint256 amount0, uint256 amount1)
    {
        if (tokenId != 0) revert PositionExists();
        if (_tickLower >= _tickUpper) revert InvalidTickRange();
        if (amount0Desired == 0 && amount1Desired == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert DeadlineExpired();

        // Determine token order (Uniswap requires token0 < token1)
        (address token0, address token1) = _getTokenOrder();

        // Transfer tokens from vault
        if (amount0Desired > 0) {
            IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
            IERC20(token0).safeIncreaseAllowance(address(positionManager), amount0Desired);
        }
        if (amount1Desired > 0) {
            IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1Desired);
            IERC20(token1).safeIncreaseAllowance(address(positionManager), amount1Desired);
        }

        // Calculate minimum amounts with slippage
        uint256 amount0Min = (amount0Desired * (PRECISION - slippageTolerance)) / PRECISION;
        uint256 amount1Min = (amount1Desired * (PRECISION - slippageTolerance)) / PRECISION;

        // Mint position
        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager
            .MintParams({
                token0: token0,
                token1: token1,
                fee: poolFee,
                tickLower: _tickLower,
                tickUpper: _tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: address(this),
                deadline: deadline
            });

        (_tokenId, _liquidity, amount0, amount1) = positionManager.mint(params);

        // Update state
        tokenId = _tokenId;
        tickLower = _tickLower;
        tickUpper = _tickUpper;
        liquidity = _liquidity;

        // Refund unused tokens
        _refundUnusedTokens(token0, token1, amount0Desired - amount0, amount1Desired - amount1);

        emit PositionMinted(_tokenId, _tickLower, _tickUpper, _liquidity, amount0, amount1);
    }

    /// @notice Increase liquidity in the current position
    /// @param amount0Desired Amount of token0 to add
    /// @param amount1Desired Amount of token1 to add
    /// @param deadline Transaction deadline
    /// @return _liquidity Amount of liquidity added
    /// @return amount0 Actual amount of token0 added
    /// @return amount1 Actual amount of token1 added
    function increaseLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 deadline
    )
        external
        onlyVault
        nonReentrant
        returns (uint128 _liquidity, uint256 amount0, uint256 amount1)
    {
        if (tokenId == 0) revert NoPosition();
        if (amount0Desired == 0 && amount1Desired == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert DeadlineExpired();

        (address token0, address token1) = _getTokenOrder();

        // Transfer and approve tokens
        if (amount0Desired > 0) {
            IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
            IERC20(token0).safeIncreaseAllowance(address(positionManager), amount0Desired);
        }
        if (amount1Desired > 0) {
            IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1Desired);
            IERC20(token1).safeIncreaseAllowance(address(positionManager), amount1Desired);
        }

        // Calculate minimum amounts
        uint256 amount0Min = (amount0Desired * (PRECISION - slippageTolerance)) / PRECISION;
        uint256 amount1Min = (amount1Desired * (PRECISION - slippageTolerance)) / PRECISION;

        INonfungiblePositionManager.IncreaseLiquidityParams
            memory params = INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: tokenId,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: deadline
            });

        (_liquidity, amount0, amount1) = positionManager.increaseLiquidity(params);

        // Update state
        liquidity += _liquidity;

        // Refund unused tokens
        _refundUnusedTokens(token0, token1, amount0Desired - amount0, amount1Desired - amount1);

        emit LiquidityIncreased(tokenId, _liquidity, amount0, amount1);
    }

    /// @notice Decrease liquidity in the current position
    /// @param _liquidity Amount of liquidity to remove
    /// @param deadline Transaction deadline
    /// @return amount0 Amount of token0 received
    /// @return amount1 Amount of token1 received
    function decreaseLiquidity(
        uint128 _liquidity,
        uint256 deadline
    ) external onlyVault nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (tokenId == 0) revert NoPosition();
        if (_liquidity == 0) revert ZeroAmount();
        if (_liquidity > liquidity) revert ZeroAmount();
        if (block.timestamp > deadline) revert DeadlineExpired();

        INonfungiblePositionManager.DecreaseLiquidityParams
            memory params = INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: _liquidity,
                amount0Min: 0, // We'll handle slippage check ourselves
                amount1Min: 0,
                deadline: deadline
            });

        (amount0, amount1) = positionManager.decreaseLiquidity(params);

        // Update state
        liquidity -= _liquidity;

        // Collect the tokens (they're held by position manager after decrease)
        _collectToVault();

        emit LiquidityDecreased(tokenId, _liquidity, amount0, amount1);
    }

    /// @notice Collect accumulated fees from the position
    /// @return amount0 Amount of token0 fees collected
    /// @return amount1 Amount of token1 fees collected
    function collectFees()
        external
        onlyVault
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (tokenId == 0) revert NoPosition();

        (amount0, amount1) = _collectToVault();

        totalFeesCollected0 += amount0;
        totalFeesCollected1 += amount1;

        emit FeesCollected(tokenId, amount0, amount1);
    }

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
    ) external onlyVault nonReentrant returns (uint256 newTokenId, uint128 newLiquidity) {
        if (tokenId == 0) revert NoPosition();
        if (newTickLower >= newTickUpper) revert InvalidTickRange();
        if (block.timestamp > deadline) revert DeadlineExpired();

        uint256 oldTokenId = tokenId;
        int24 oldTickLower = tickLower;
        int24 oldTickUpper = tickUpper;

        // Close current position and collect all tokens
        _closePosition();

        // Reset state
        tokenId = 0;
        tickLower = 0;
        tickUpper = 0;
        liquidity = 0;

        (address token0, address token1) = _getTokenOrder();

        // Use full balance for new position (allows for manual topping up or previous dust)
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));

        // Approve tokens for new position
        if (balance0 > 0) {
            IERC20(token0).safeIncreaseAllowance(address(positionManager), balance0);
        }
        if (balance1 > 0) {
            IERC20(token1).safeIncreaseAllowance(address(positionManager), balance1);
        }

        // Calculate minimum amounts
        uint256 amount0Min = (balance0 * (PRECISION - slippageTolerance)) / PRECISION;
        uint256 amount1Min = (balance1 * (PRECISION - slippageTolerance)) / PRECISION;

        // Mint new position
        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager
            .MintParams({
                token0: token0,
                token1: token1,
                fee: poolFee,
                tickLower: newTickLower,
                tickUpper: newTickUpper,
                amount0Desired: balance0,
                amount1Desired: balance1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: address(this),
                deadline: deadline
            });

        uint256 actualAmount0;
        uint256 actualAmount1;
        (newTokenId, newLiquidity, actualAmount0, actualAmount1) = positionManager.mint(params);

        // Update state
        tokenId = newTokenId;
        tickLower = newTickLower;
        tickUpper = newTickUpper;
        liquidity = newLiquidity;

        // Refund any unused tokens to vault
        _refundUnusedTokens(token0, token1, balance0 - actualAmount0, balance1 - actualAmount1);

        emit RangeAdjusted(
            oldTokenId,
            newTokenId,
            oldTickLower,
            oldTickUpper,
            newTickLower,
            newTickUpper
        );
    }

    /// @notice Close the current position completely
    /// @return amount0 Amount of token0 received
    /// @return amount1 Amount of token1 received
    function closePosition()
        external
        onlyVault
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (tokenId == 0) revert NoPosition();

        uint256 oldTokenId = tokenId;
        (amount0, amount1) = _closePosition();

        // Reset state
        tokenId = 0;
        tickLower = 0;
        tickUpper = 0;
        liquidity = 0;

        // Send tokens to vault
        (address token0, address token1) = _getTokenOrder();
        if (amount0 > 0) {
            IERC20(token0).safeTransfer(vault, amount0);
        }
        if (amount1 > 0) {
            IERC20(token1).safeTransfer(vault, amount1);
        }

        emit PositionClosed(oldTokenId, amount0, amount1);
    }

    // ============ View Functions ============

    /// @notice Get the current position value in quote token terms
    /// @return value Position value in quote token
    function getPositionValue() external view returns (uint256 value) {
        if (tokenId == 0) return 0;

        uint160 sqrtPriceX96 = _getCurrentSqrtPrice();

        // Convert ticks to sqrt prices
        uint160 sqrtPriceLowerX96 = _tickToSqrtPriceX96(tickLower);
        uint160 sqrtPriceUpperX96 = _tickToSqrtPriceX96(tickUpper);

        value = DeltaCalculator.getPositionValue(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            liquidity
        );
    }

    /// @notice Get the current position delta
    /// @return delta Position delta in base token units (scaled by 1e18)
    function getPositionDelta() external view returns (int256 delta) {
        if (tokenId == 0) return 0;

        uint160 sqrtPriceX96 = _getCurrentSqrtPrice();
        uint160 sqrtPriceLowerX96 = _tickToSqrtPriceX96(tickLower);
        uint160 sqrtPriceUpperX96 = _tickToSqrtPriceX96(tickUpper);

        delta = DeltaCalculator.calculateDelta(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            liquidity
        );
    }

    /// @notice Get the current position delta ratio
    /// @return deltaRatio Delta as percentage (0 to 1e18)
    function getPositionDeltaRatio() external view returns (uint256 deltaRatio) {
        if (tokenId == 0) return 0;

        uint160 sqrtPriceX96 = _getCurrentSqrtPrice();
        uint160 sqrtPriceLowerX96 = _tickToSqrtPriceX96(tickLower);
        uint160 sqrtPriceUpperX96 = _tickToSqrtPriceX96(tickUpper);

        deltaRatio = DeltaCalculator.calculateDeltaRatio(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96
        );
    }

    /// @notice Get the token amounts in the current position
    /// @return amount0 Amount of token0
    /// @return amount1 Amount of token1
    function getTokenAmounts() external view returns (uint256 amount0, uint256 amount1) {
        if (tokenId == 0) return (0, 0);

        uint160 sqrtPriceX96 = _getCurrentSqrtPrice();
        uint160 sqrtPriceLowerX96 = _tickToSqrtPriceX96(tickLower);
        uint160 sqrtPriceUpperX96 = _tickToSqrtPriceX96(tickUpper);

        amount0 = DeltaCalculator.getBaseTokenAmount(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            liquidity
        );
        amount1 = DeltaCalculator.getQuoteTokenAmount(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            liquidity
        );
    }

    /// @notice Get pending fees (uncollected)
    /// @return amount0 Pending token0 fees
    /// @return amount1 Pending token1 fees
    function getPendingFees() external view returns (uint256 amount0, uint256 amount1) {
        if (tokenId == 0) return (0, 0);

        (, , , , , , , , , , uint128 tokensOwed0, uint128 tokensOwed1) = positionManager.positions(
            tokenId
        );

        return (uint256(tokensOwed0), uint256(tokensOwed1));
    }

    /// @notice Get the current pool
    /// @return pool The Uniswap V3 pool address
    function getPool() public view returns (address pool) {
        (address token0, address token1) = _getTokenOrder();
        pool = factory.getPool(token0, token1, poolFee);
    }

    /// @notice Get current position info
    /// @return _tokenId Position token ID
    /// @return _tickLower Lower tick
    /// @return _tickUpper Upper tick
    /// @return _liquidity Position liquidity
    function getPositionInfo()
        external
        view
        returns (uint256 _tokenId, int24 _tickLower, int24 _tickUpper, uint128 _liquidity)
    {
        return (tokenId, tickLower, tickUpper, liquidity);
    }

    /// @notice Check if position is in range
    /// @return inRange True if current price is within position range
    function isInRange() external view returns (bool inRange) {
        if (tokenId == 0) return false;

        address pool = getPool();
        (, int24 currentTick, , , , , ) = IUniswapV3Pool(pool).slot0();

        return currentTick >= tickLower && currentTick < tickUpper;
    }

    // ============ Internal Functions ============

    /// @notice Get token order (Uniswap requires token0 < token1)
    function _getTokenOrder() internal view returns (address token0, address token1) {
        if (baseToken < quoteToken) {
            return (baseToken, quoteToken);
        } else {
            return (quoteToken, baseToken);
        }
    }

    /// @notice Get current sqrt price from the pool
    function _getCurrentSqrtPrice() internal view returns (uint160 sqrtPriceX96) {
        address pool = getPool();
        (sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
    }

    /// @notice Convert tick to sqrt price X96
    /// @dev Uses the formula: sqrtPrice = 1.0001^(tick/2) * 2^96
    function _tickToSqrtPriceX96(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        // Implementation based on Uniswap's TickMath
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

        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    /// @notice Collect tokens to vault
    function _collectToVault() internal returns (uint256 amount0, uint256 amount1) {
        INonfungiblePositionManager.CollectParams memory params = INonfungiblePositionManager
            .CollectParams({
                tokenId: tokenId,
                recipient: vault,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });

        (amount0, amount1) = positionManager.collect(params);
    }

    /// @notice Close position and collect all tokens
    function _closePosition() internal returns (uint256 amount0, uint256 amount1) {
        // Decrease all liquidity
        if (liquidity > 0) {
            INonfungiblePositionManager.DecreaseLiquidityParams
                memory decreaseParams = INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                });

            positionManager.decreaseLiquidity(decreaseParams);
        }

        // Collect all tokens (including fees)
        INonfungiblePositionManager.CollectParams memory collectParams = INonfungiblePositionManager
            .CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });

        (amount0, amount1) = positionManager.collect(collectParams);

        // Burn the NFT
        positionManager.burn(tokenId);
    }

    /// @notice Refund unused tokens to vault
    function _refundUnusedTokens(
        address token0,
        address token1,
        uint256 refund0,
        uint256 refund1
    ) internal {
        if (refund0 > 0) {
            IERC20(token0).safeTransfer(vault, refund0);
        }
        if (refund1 > 0) {
            IERC20(token1).safeTransfer(vault, refund1);
        }
    }

    // ============ TWAP Validation Functions ============

    /// @notice Get the TWAP price from Uniswap pool observations
    /// @return twapSqrtPriceX96 The TWAP sqrt price in X96 format
    function getTWAPSqrtPriceX96() public view returns (uint160 twapSqrtPriceX96) {
        address pool = getPool();
        if (pool == address(0)) revert TWAPNotAvailable();

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapPeriod;
        secondsAgos[1] = 0;

        try IUniswapV3Pool(pool).observe(secondsAgos) returns (
            int56[] memory tickCumulatives,
            uint160[] memory
        ) {
            // Calculate time-weighted average tick
            int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
            int24 arithmeticMeanTick = int24(tickCumulativesDelta / int56(int32(twapPeriod)));

            // Round to negative infinity
            if (
                tickCumulativesDelta < 0 && (tickCumulativesDelta % int56(int32(twapPeriod)) != 0)
            ) {
                arithmeticMeanTick--;
            }

            // Convert tick to sqrtPriceX96
            twapSqrtPriceX96 = _tickToSqrtPriceX96(arithmeticMeanTick);
        } catch {
            revert TWAPNotAvailable();
        }
    }

    /// @notice Validate current spot price against TWAP
    /// @dev Reverts if spot deviates too much from TWAP
    function validatePriceAgainstTWAP() public view {
        if (!twapValidationEnabled) return;

        uint160 spotSqrtPriceX96 = _getCurrentSqrtPrice();
        uint160 twapSqrtPriceX96 = getTWAPSqrtPriceX96();

        // Calculate price deviation
        uint256 spotPrice = uint256(spotSqrtPriceX96);
        uint256 twapPrice = uint256(twapSqrtPriceX96);

        uint256 deviation;
        if (spotPrice > twapPrice) {
            deviation = ((spotPrice - twapPrice) * PRECISION) / twapPrice;
        } else {
            deviation = ((twapPrice - spotPrice) * PRECISION) / twapPrice;
        }

        if (deviation > maxTwapDeviation) {
            revert TWAPDeviationTooHigh(spotPrice, twapPrice, deviation);
        }
    }

    /// @notice Get current spot to TWAP deviation percentage
    /// @return deviation The deviation as percentage (scaled by 1e18)
    function getSpotTWAPDeviation() external view returns (uint256 deviation) {
        address pool = getPool();
        if (pool == address(0)) return 0;

        try this.getTWAPSqrtPriceX96() returns (uint160 twapSqrtPriceX96) {
            uint160 spotSqrtPriceX96 = _getCurrentSqrtPrice();

            uint256 spotPrice = uint256(spotSqrtPriceX96);
            uint256 twapPrice = uint256(twapSqrtPriceX96);

            if (spotPrice > twapPrice) {
                deviation = ((spotPrice - twapPrice) * PRECISION) / twapPrice;
            } else {
                deviation = ((twapPrice - spotPrice) * PRECISION) / twapPrice;
            }
        } catch {
            return 0;
        }
    }

    /// @notice Check if oracle price is consistent with pool price
    /// @dev Requires price feed to be set
    /// @return isConsistent True if prices are within tolerance
    function validateOracleAgainstPool() external view returns (bool isConsistent) {
        if (address(priceFeed) == address(0)) return true;

        // Get Chainlink price (8 decimals for ETH/USD)
        (, int256 oracleAnswer, , , ) = priceFeed.latestRoundData();
        if (oracleAnswer <= 0) return false;

        uint256 oraclePrice = uint256(oracleAnswer);

        // Get pool price and convert to comparable format
        uint160 sqrtPriceX96 = _getCurrentSqrtPrice();
        uint256 poolPrice = DeltaCalculator.sqrtPriceX96ToPrice(sqrtPriceX96, 18);

        // Convert pool price to 8 decimals to match Chainlink
        // Pool price is typically in quote/base format
        // Adjust based on token order
        (address token0, ) = _getTokenOrder();
        uint256 poolPrice8Decimals;

        if (token0 == baseToken) {
            // Price is quote/base (USDC per WETH), need to convert
            poolPrice8Decimals = poolPrice / 1e10; // Assuming 18 decimals to 8
        } else {
            // Price is base/quote (WETH per USDC), invert
            if (poolPrice > 0) {
                poolPrice8Decimals = (1e18 * 1e8) / poolPrice;
            }
        }

        // Check deviation
        uint256 deviation;
        if (oraclePrice > poolPrice8Decimals) {
            deviation = ((oraclePrice - poolPrice8Decimals) * PRECISION) / oraclePrice;
        } else {
            deviation = ((poolPrice8Decimals - oraclePrice) * PRECISION) / poolPrice8Decimals;
        }

        return deviation <= maxTwapDeviation;
    }

    /// @inheritdoc ILiquidityManager
    function getRebalanceTicks(
        int24 widthMultiplier
    ) external view returns (int24 newTickLower, int24 newTickUpper) {
        address pool = getPool();
        (, int24 currentTick, , , , , ) = IUniswapV3Pool(pool).slot0();
        int24 tickSpacing = IUniswapV3Pool(pool).tickSpacing();

        // Round current tick to nearest tickSpacing
        int24 baseTick = (currentTick / tickSpacing) * tickSpacing;
        if (currentTick < 0 && currentTick % tickSpacing != 0) {
            baseTick -= tickSpacing;
        }

        // Calculate range
        // widthMultiplier is interpreted as number of tickSpacings on each side
        int24 halfWidth = widthMultiplier * tickSpacing;

        newTickLower = baseTick - halfWidth;
        newTickUpper = baseTick + halfWidth;
    }

    /// @inheritdoc ILiquidityManager
    function getOraclePrice() external view returns (uint256 price) {
        if (address(priceFeed) == address(0)) revert ZeroAddress();

        (, int256 answer, , , ) = priceFeed.latestRoundData();
        if (answer <= 0) revert("Invalid oracle price");

        // Convert 8 decimals (Chainlink) to 18 decimals
        return uint256(answer) * 1e10;
    }
}
