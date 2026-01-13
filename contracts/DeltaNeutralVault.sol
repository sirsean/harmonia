// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {LiquidityManager} from "./LiquidityManager.sol";
import {HedgeManager} from "./HedgeManager.sol";
import {AggregatorV3Interface} from "./interfaces/IChainlink.sol";
import {YieldMath} from "./libraries/YieldMath.sol";

/// @title Delta Neutral Vault
/// @notice ERC-4626 vault providing delta-neutral yield through Uniswap V3 LP + GMX hedging
/// @dev Deposits USDC, provides LP on Uniswap V3, hedges delta exposure via GMX shorts
contract DeltaNeutralVault is ERC4626, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Precision for calculations (1e18)
    uint256 public constant PRECISION = 1e18;

    /// @notice GMX USD precision (1e30)
    uint256 public constant GMX_USD_PRECISION = 1e30;

    /// @notice Maximum delta deviation before rebalance (5% of position)
    uint256 public constant MAX_DELTA_DEVIATION = 5e16;

    /// @notice Minimum deposit amount (100 USDC)
    uint256 public constant MIN_DEPOSIT = 100e6;

    /// @notice Performance fee (10%)
    uint256 public constant PERFORMANCE_FEE = 10e16;

    /// @notice Management fee (2% annual)
    uint256 public constant MANAGEMENT_FEE = 2e16;

    /// @notice Fee precision
    uint256 public constant FEE_PRECISION = 1e18;

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Liquidity manager for Uniswap V3 positions
    LiquidityManager public immutable liquidityManager;

    /// @notice Hedge manager for GMX short positions
    HedgeManager public immutable hedgeManager;

    /// @notice Chainlink price feed for ETH/USD
    AggregatorV3Interface public immutable priceFeed;

    /// @notice WETH token address
    address public immutable weth;

    /// @notice Fee recipient address
    address public feeRecipient;

    /// @notice Last fee collection timestamp
    uint256 public lastFeeCollection;

    /// @notice High water mark for performance fees
    uint256 public highWaterMark;

    /// @notice Total fees collected
    uint256 public totalFeesCollected;

    /// @notice Yield snapshots for APY calculation
    YieldMath.YieldSnapshot[] public yieldSnapshots;

    /// @notice Target LP tick range width (e.g., 1000 = ±5%)
    int24 public targetTickWidth;

    /// @notice Keeper address for automated rebalancing
    address public keeper;

    /// @notice Last rebalance timestamp
    uint256 public lastRebalanceTime;

    /// @notice Minimum time between rebalances
    uint256 public rebalanceCooldown;

    // ═══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Vault state information
    struct VaultState {
        uint256 totalAssets;
        uint256 lpValue;
        uint256 hedgeValue;
        int256 netDelta;
        uint256 pendingFees;
        bool isBalanced;
    }

    /// @notice Rebalance parameters
    struct RebalanceParams {
        int24 newTickLower;
        int24 newTickUpper;
        uint256 hedgeSizeDelta;
        bool increaseHedge;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event PositionOpened(
        uint256 lpTokenId,
        uint256 lpValue,
        uint256 hedgeSizeUsd
    );

    event Rebalanced(
        int256 oldDelta,
        int256 newDelta,
        uint256 lpValue,
        uint256 hedgeValue
    );

    event FeesCollected(
        uint256 managementFee,
        uint256 performanceFee,
        address indexed recipient
    );

    event YieldSnapshotTaken(
        uint256 timestamp,
        uint256 totalValue,
        uint256 cumulativeFees
    );

    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);

    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    event TickWidthUpdated(int24 oldWidth, int24 newWidth);

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidAddress();
    error DepositTooSmall();
    error UnauthorizedCaller();
    error RebalanceCooldownNotMet();
    error DeltaWithinTolerance();
    error NoActivePosition();
    error WithdrawalExceedsAvailable();
    error InsufficientExecutionFee();

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Restricts function access to keeper or owner
    modifier onlyKeeperOrOwner() {
        if (msg.sender != keeper && msg.sender != owner()) {
            revert UnauthorizedCaller();
        }
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Constructs the DeltaNeutralVault
    /// @param _asset Underlying asset (USDC)
    /// @param _liquidityManager LiquidityManager contract address
    /// @param _hedgeManager HedgeManager contract address
    /// @param _priceFeed Chainlink ETH/USD price feed
    /// @param _weth WETH token address
    /// @param _owner Initial owner address
    constructor(
        IERC20 _asset,
        address _liquidityManager,
        address _hedgeManager,
        address _priceFeed,
        address _weth,
        address _owner
    )
        ERC4626(_asset)
        ERC20("Delta Neutral Yield Vault", "dnYield")
        Ownable(_owner)
    {
        if (
            _liquidityManager == address(0) ||
            _hedgeManager == address(0) ||
            _priceFeed == address(0) ||
            _weth == address(0)
        ) {
            revert InvalidAddress();
        }

        liquidityManager = LiquidityManager(_liquidityManager);
        hedgeManager = HedgeManager(_hedgeManager);
        priceFeed = AggregatorV3Interface(_priceFeed);
        weth = _weth;

        feeRecipient = _owner;
        lastFeeCollection = block.timestamp;
        targetTickWidth = 1000; // ±5% range
        rebalanceCooldown = 1 hours;

        // Initialize first yield snapshot
        yieldSnapshots.push(
            YieldMath.YieldSnapshot({
                timestamp: block.timestamp,
                totalValue: 0,
                cumulativeFees: 0,
                cumulativeFunding: 0,
                cumulativeRebalanceCosts: 0
            })
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ERC-4626 OVERRIDES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Returns total assets under management
    /// @return Total value in asset terms (USDC)
    function totalAssets() public view override returns (uint256) {
        return _calculateTotalAssets();
    }

    /// @notice Deposit assets and receive shares
    /// @param assets Amount of assets to deposit
    /// @param receiver Address to receive shares
    /// @return shares Amount of shares minted
    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant whenNotPaused returns (uint256 shares) {
        if (assets < MIN_DEPOSIT) {
            revert DepositTooSmall();
        }

        shares = super.deposit(assets, receiver);

        // Update high water mark if needed
        uint256 currentValue = totalAssets();
        if (currentValue > highWaterMark) {
            highWaterMark = currentValue;
        }
    }

    /// @notice Mint shares by depositing assets
    /// @param shares Amount of shares to mint
    /// @param receiver Address to receive shares
    /// @return assets Amount of assets deposited
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant whenNotPaused returns (uint256 assets) {
        assets = super.mint(shares, receiver);

        if (assets < MIN_DEPOSIT) {
            revert DepositTooSmall();
        }

        uint256 currentValue = totalAssets();
        if (currentValue > highWaterMark) {
            highWaterMark = currentValue;
        }
    }

    /// @notice Withdraw assets by burning shares
    /// @param assets Amount of assets to withdraw
    /// @param receiver Address to receive assets
    /// @param owner Address of share owner
    /// @return shares Amount of shares burned
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256 shares) {
        uint256 available = _getAvailableAssets();
        if (assets > available) {
            revert WithdrawalExceedsAvailable();
        }

        shares = super.withdraw(assets, receiver, owner);
    }

    /// @notice Redeem shares for assets
    /// @param shares Amount of shares to redeem
    /// @param receiver Address to receive assets
    /// @param owner Address of share owner
    /// @return assets Amount of assets received
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256 assets) {
        assets = previewRedeem(shares);

        uint256 available = _getAvailableAssets();
        if (assets > available) {
            revert WithdrawalExceedsAvailable();
        }

        assets = super.redeem(shares, receiver, owner);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS - POSITION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Opens initial LP and hedge positions
    /// @param tickLower Lower tick for LP position
    /// @param tickUpper Upper tick for LP position
    /// @param lpAmount0 Amount of token0 for LP
    /// @param lpAmount1 Amount of token1 for LP
    /// @param hedgeCollateral Collateral for hedge position
    /// @param hedgeSizeUsd Hedge position size in USD
    function openPositions(
        int24 tickLower,
        int24 tickUpper,
        uint256 lpAmount0,
        uint256 lpAmount1,
        uint256 hedgeCollateral,
        uint256 hedgeSizeUsd
    ) external payable onlyOwner nonReentrant {
        IERC20 asset = IERC20(asset());

        // Swap some USDC to WETH for LP position
        // For simplicity, assume tokens are already available or transferred
        IERC20(weth).safeTransferFrom(msg.sender, address(this), lpAmount0);
        asset.safeTransferFrom(msg.sender, address(this), lpAmount1 + hedgeCollateral);

        // Approve and open LP position
        IERC20(weth).safeIncreaseAllowance(address(liquidityManager), lpAmount0);
        asset.safeIncreaseAllowance(address(liquidityManager), lpAmount1);

        LiquidityManager.OpenPositionParams memory lpParams = LiquidityManager.OpenPositionParams({
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: lpAmount0,
            amount1Desired: lpAmount1,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1 hours
        });

        liquidityManager.openPosition(lpParams);

        // Open hedge position
        asset.safeIncreaseAllowance(address(hedgeManager), hedgeCollateral);

        uint256 executionFee = msg.value;
        hedgeManager.openHedge{value: executionFee}(hedgeSizeUsd, hedgeCollateral);

        // Take initial yield snapshot
        _takeYieldSnapshot();

        emit PositionOpened(
            liquidityManager.positionTokenId(),
            liquidityManager.getPositionValue(),
            hedgeSizeUsd
        );
    }

    /// @notice Rebalances the vault to maintain delta neutrality
    /// @param params Rebalance parameters
    function rebalance(
        RebalanceParams calldata params
    ) external payable onlyKeeperOrOwner nonReentrant {
        if (block.timestamp < lastRebalanceTime + rebalanceCooldown) {
            revert RebalanceCooldownNotMet();
        }

        int256 currentDelta = getNetDelta();

        // Check if rebalance is needed
        uint256 absDelta = currentDelta >= 0 ? uint256(currentDelta) : uint256(-currentDelta);
        uint256 totalValue = totalAssets();

        if (totalValue > 0) {
            uint256 deltaRatio = (absDelta * PRECISION) / totalValue;
            if (deltaRatio < MAX_DELTA_DEVIATION) {
                revert DeltaWithinTolerance();
            }
        }

        // Rebalance LP position if tick range changed
        if (params.newTickLower != 0 || params.newTickUpper != 0) {
            liquidityManager.rebalance(params.newTickLower, params.newTickUpper, block.timestamp + 1 hours);
        }

        // Adjust hedge position
        IERC20 asset = IERC20(asset());
        if (params.hedgeSizeDelta > 0) {
            if (params.increaseHedge) {
                // Increase hedge (more short)
                asset.safeIncreaseAllowance(address(hedgeManager), 0);
                hedgeManager.increaseHedge{value: msg.value}(params.hedgeSizeDelta, 0);
            } else {
                // Decrease hedge (less short)
                hedgeManager.decreaseHedge{value: msg.value}(params.hedgeSizeDelta, 0);
            }
        }

        lastRebalanceTime = block.timestamp;

        int256 newDelta = getNetDelta();

        emit Rebalanced(
            currentDelta,
            newDelta,
            liquidityManager.getPositionValue(),
            hedgeManager.getPositionSizeUsd()
        );
    }

    /// @notice Collects fees from LP position
    function collectLPFees() external onlyKeeperOrOwner nonReentrant {
        liquidityManager.collectFees();
        _takeYieldSnapshot();
    }

    /// @notice Claims funding from hedge position
    function claimHedgeFunding() external onlyKeeperOrOwner nonReentrant {
        hedgeManager.claimFunding();
        _takeYieldSnapshot();
    }

    /// @notice Collects management and performance fees
    function collectFees() external nonReentrant {
        uint256 currentValue = totalAssets();
        uint256 timeDelta = block.timestamp - lastFeeCollection;

        // Calculate management fee (pro-rata for time elapsed)
        uint256 managementFee = (currentValue * MANAGEMENT_FEE * timeDelta) /
            (365.25 days * FEE_PRECISION);

        // Calculate performance fee (on gains above high water mark)
        uint256 performanceFee = 0;
        if (currentValue > highWaterMark) {
            uint256 gains = currentValue - highWaterMark;
            performanceFee = (gains * PERFORMANCE_FEE) / FEE_PRECISION;
            highWaterMark = currentValue;
        }

        uint256 totalFee = managementFee + performanceFee;

        if (totalFee > 0 && feeRecipient != address(0)) {
            // Transfer fee in shares
            uint256 feeShares = convertToShares(totalFee);
            if (feeShares > 0) {
                _mint(feeRecipient, feeShares);
                totalFeesCollected += totalFee;
            }
        }

        lastFeeCollection = block.timestamp;

        emit FeesCollected(managementFee, performanceFee, feeRecipient);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS - VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Gets the current vault state
    /// @return state VaultState struct with current values
    function getVaultState() external view returns (VaultState memory state) {
        int256 netDelta = getNetDelta();
        uint256 absDelta = netDelta >= 0 ? uint256(netDelta) : uint256(-netDelta);
        uint256 total = totalAssets();

        bool isBalanced = total == 0 || (absDelta * PRECISION / total) < MAX_DELTA_DEVIATION;

        state = VaultState({
            totalAssets: total,
            lpValue: liquidityManager.getPositionValue(),
            hedgeValue: hedgeManager.getPositionSizeUsd() / (GMX_USD_PRECISION / PRECISION),
            netDelta: netDelta,
            pendingFees: _calculatePendingFees(),
            isBalanced: isBalanced
        });
    }

    /// @notice Gets the net delta exposure of the vault
    /// @return delta Net delta (LP delta + hedge delta)
    function getNetDelta() public view returns (int256 delta) {
        int256 lpDelta = liquidityManager.getPositionDelta();
        int256 hedgeDelta = hedgeManager.getPositionDelta();

        delta = lpDelta + hedgeDelta;
    }

    /// @notice Gets yield metrics
    /// @return metrics YieldMetrics struct
    function getYieldMetrics() external view returns (YieldMath.YieldMetrics memory metrics) {
        if (yieldSnapshots.length < 2) {
            return metrics;
        }

        YieldMath.YieldSnapshot memory latest = yieldSnapshots[yieldSnapshots.length - 1];

        // Calculate 1-day APY
        uint256 oneDayAgo = block.timestamp - 1 days;
        YieldMath.YieldSnapshot memory daySnapshot = _findSnapshotNear(oneDayAgo);
        if (daySnapshot.timestamp > 0) {
            metrics.apy1Day = YieldMath.calculateAPY(daySnapshot, latest);
        }

        // Calculate 7-day APY
        uint256 sevenDaysAgo = block.timestamp - 7 days;
        YieldMath.YieldSnapshot memory weekSnapshot = _findSnapshotNear(sevenDaysAgo);
        if (weekSnapshot.timestamp > 0) {
            metrics.apy7Day = YieldMath.calculateAPY(weekSnapshot, latest);
        }

        // Calculate 30-day APY
        uint256 thirtyDaysAgo = block.timestamp - 30 days;
        YieldMath.YieldSnapshot memory monthSnapshot = _findSnapshotNear(thirtyDaysAgo);
        if (monthSnapshot.timestamp > 0) {
            metrics.apy30Day = YieldMath.calculateAPY(monthSnapshot, latest);
        }

        // Cumulative values from first snapshot
        YieldMath.YieldSnapshot memory first = yieldSnapshots[0];
        metrics.totalFeeIncome = latest.cumulativeFees - first.cumulativeFees;
        metrics.totalFundingIncome = latest.cumulativeFunding - first.cumulativeFunding;
        metrics.totalRebalanceCosts = latest.cumulativeRebalanceCosts - first.cumulativeRebalanceCosts;
        metrics.netYield = int256(metrics.totalFeeIncome) + metrics.totalFundingIncome -
            int256(metrics.totalRebalanceCosts);
    }

    /// @notice Gets the current ETH price from Chainlink
    /// @return price ETH/USD price (8 decimals)
    function getETHPrice() public view returns (uint256 price) {
        (, int256 answer, , , ) = priceFeed.latestRoundData();
        require(answer > 0, "Invalid price");
        price = uint256(answer);
    }

    /// @notice Returns the number of yield snapshots
    /// @return count Number of snapshots
    function getSnapshotCount() external view returns (uint256 count) {
        return yieldSnapshots.length;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS - ADMIN
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Sets the keeper address
    /// @param _keeper New keeper address
    function setKeeper(address _keeper) external onlyOwner {
        address oldKeeper = keeper;
        keeper = _keeper;
        emit KeeperUpdated(oldKeeper, _keeper);
    }

    /// @notice Sets the fee recipient
    /// @param _feeRecipient New fee recipient address
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) {
            revert InvalidAddress();
        }
        address oldRecipient = feeRecipient;
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(oldRecipient, _feeRecipient);
    }

    /// @notice Sets the target tick width for LP positions
    /// @param _tickWidth New tick width
    function setTargetTickWidth(int24 _tickWidth) external onlyOwner {
        int24 oldWidth = targetTickWidth;
        targetTickWidth = _tickWidth;
        emit TickWidthUpdated(oldWidth, _tickWidth);
    }

    /// @notice Sets the rebalance cooldown
    /// @param _cooldown New cooldown in seconds
    function setRebalanceCooldown(uint256 _cooldown) external onlyOwner {
        rebalanceCooldown = _cooldown;
    }

    /// @notice Pauses the vault
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses the vault
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Emergency function to recover stuck tokens
    /// @param token Token address
    /// @param to Recipient address
    /// @param amount Amount to recover
    function emergencyRecover(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) {
            revert InvalidAddress();
        }
        // Prevent recovering the underlying asset
        require(token != asset(), "Cannot recover underlying");
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Allows contract to receive ETH
    receive() external payable {}

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Calculates total assets under management
    /// @return total Total value in USDC terms
    function _calculateTotalAssets() internal view returns (uint256 total) {
        // Idle assets in vault
        total = IERC20(asset()).balanceOf(address(this));

        // LP position value (already in quote token = USDC terms)
        total += liquidityManager.getPositionValue();

        // Hedge position collateral (we count collateral, not notional)
        HedgeManager.HedgePosition memory hedgePos = hedgeManager.getHedgePosition();
        total += hedgePos.collateralAmount;
    }

    /// @notice Gets available assets for withdrawal
    /// @return available Amount available for withdrawal
    function _getAvailableAssets() internal view returns (uint256 available) {
        // Only idle assets are immediately available
        // Full withdrawals require closing positions
        available = IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Calculates pending fees
    /// @return fees Pending management + performance fees
    function _calculatePendingFees() internal view returns (uint256 fees) {
        uint256 currentValue = totalAssets();
        uint256 timeDelta = block.timestamp - lastFeeCollection;

        // Management fee
        fees = (currentValue * MANAGEMENT_FEE * timeDelta) / (365.25 days * FEE_PRECISION);

        // Performance fee
        if (currentValue > highWaterMark) {
            uint256 gains = currentValue - highWaterMark;
            fees += (gains * PERFORMANCE_FEE) / FEE_PRECISION;
        }
    }

    /// @notice Takes a yield snapshot
    function _takeYieldSnapshot() internal {
        (uint256 fees0, uint256 fees1) = liquidityManager.getCumulativeFees();
        int256 funding = hedgeManager.getCumulativeFunding();

        // Convert fees to USD value (assuming token1 is USDC and using current ETH price)
        uint256 ethPrice = getETHPrice();
        uint256 totalFees = YieldMath.calculateTotalFees(fees0, fees1, ethPrice * 1e10, 6);

        YieldMath.YieldSnapshot memory snapshot = YieldMath.YieldSnapshot({
            timestamp: block.timestamp,
            totalValue: totalAssets(),
            cumulativeFees: totalFees,
            cumulativeFunding: funding,
            cumulativeRebalanceCosts: 0 // Would track gas costs if needed
        });

        yieldSnapshots.push(snapshot);

        emit YieldSnapshotTaken(snapshot.timestamp, snapshot.totalValue, snapshot.cumulativeFees);
    }

    /// @notice Finds the nearest snapshot to a target timestamp
    /// @param targetTime Target timestamp
    /// @return snapshot The nearest snapshot
    function _findSnapshotNear(
        uint256 targetTime
    ) internal view returns (YieldMath.YieldSnapshot memory snapshot) {
        if (yieldSnapshots.length == 0) {
            return snapshot;
        }

        // Simple linear search (could be optimized with binary search)
        uint256 bestDiff = type(uint256).max;
        uint256 bestIndex = 0;

        for (uint256 i = 0; i < yieldSnapshots.length; i++) {
            uint256 diff = yieldSnapshots[i].timestamp > targetTime
                ? yieldSnapshots[i].timestamp - targetTime
                : targetTime - yieldSnapshots[i].timestamp;

            if (diff < bestDiff) {
                bestDiff = diff;
                bestIndex = i;
            }
        }

        // Only return if within 1 hour of target
        if (bestDiff < 1 hours) {
            snapshot = yieldSnapshots[bestIndex];
        }
    }
}
