# Delta-Neutral Structured Product: Research & Implementation Plan

## Executive Summary

This document presents a comprehensive analysis and implementation plan for building a delta-neutral structured product on an EVM-compatible L2. The system will generate yield by providing concentrated liquidity on Uniswap v3 while hedging directional exposure through perpetual futures positions.

**Core Value Proposition**: Capture LP fees and potentially positive funding rates while eliminating directional price risk through continuous delta hedging.

---

## Part 1: Theoretical Foundation

### 1.1 Uniswap v3 LP Position as an Options-Like Instrument

A Uniswap v3 concentrated liquidity position is mathematically equivalent to a short put option (or covered call, depending on perspective). Guillaume Lambert's seminal work established that:

**Position Value Formula:**
```
V(S) = L * (2√S - √Pa - S/√Pb)    when Pa ≤ S ≤ Pb
V(S) = L * (√Pb - √Pa)            when S > Pb  (100% quote token)
V(S) = L * (1/√Pa - 1/√Pb) * S    when S < Pa  (100% base token)
```

Where:
- `L` = liquidity amount
- `S` = current spot price
- `Pa` = lower price bound
- `Pb` = upper price bound
- `K = √(Pa * Pb)` = strike price
- `r = √(Pb/Pa)` = range factor

### 1.2 Greeks of a Uniswap v3 Position

**Delta (∂V/∂S):**
```
δ(S) = L * (1/√S - 1/√Pb)    when Pa ≤ S ≤ Pb
δ(S) = 0                      when S > Pb
δ(S) = L * (1/√Pa - 1/√Pb)   when S < Pa
```

Key insight: Delta varies continuously within the range, starting at ~0.5 at the strike price (K) and approaching 0 as price moves toward Pb, and 1 as price moves toward Pa.

**Gamma (∂²V/∂S²):**
```
γ(S) = -L / (2 * S^(3/2))    when Pa ≤ S ≤ Pb
γ(S) = 0                      outside range
```

The negative gamma means the position loses value from price volatility (characteristic of short options).

**Practical Implications:**
- LP positions are inherently **short volatility**
- Higher volatility = higher impermanent loss
- Fee income must exceed IL + hedging costs for profitability

### 1.3 Delta-Neutral Strategy Mechanics

To achieve delta neutrality, we offset the LP position's delta with a short position in perpetual futures:

```
Net Delta = δ_LP + δ_Perp = 0
δ_Perp = -δ_LP

Short perp size = δ_LP * notional_value
```

**Example:**
- LP position: $100,000 in ETH/USDC pool
- Current delta: 0.45 (45% exposed to ETH)
- Required short: 0.45 * $100,000 = $45,000 notional short ETH-PERP

As price moves, delta changes, requiring **dynamic rebalancing**.

---

## Part 2: Protocol Selection Analysis

### 2.1 L2 Network Selection

| Network | Pros | Cons | Recommendation |
|---------|------|------|----------------|
| **Arbitrum** | GMX ecosystem, highest DeFi TVL, mature | Higher fees than Base | **Primary choice** |
| **Base** | Low fees, Coinbase backing, growing ecosystem | Synthetix sunsetting L2s | Secondary option |
| **Optimism** | Synthetix V2 (deprecated), Perp Protocol | Limited perp options now | Not recommended |

**Recommendation: Arbitrum** - Best perp protocol integration (GMX v2) with deep liquidity.

### 2.2 Perpetual Futures Protocol Selection

| Protocol | Network | Pros | Cons |
|----------|---------|------|------|
| **GMX v2** | Arbitrum | Deep liquidity, well-documented API, multi-asset | Keeper-based execution delay |
| **Synthetix Perps** | Moving to Mainnet | Oracle-based pricing | Sunsetting L2 deployments |
| **Hyperliquid** | Own L1 | 70%+ market share, low fees | Not EVM, no composability |

**Recommendation: GMX v2** - Best combination of liquidity, documentation, and smart contract composability.

### 2.3 Uniswap v3 Pool Selection Criteria

For this strategy to work, we need:

1. **USDC as quote token** - Stable side for deposits/withdrawals
2. **Base token available on perp market** - ETH, BTC (WBTC), etc.
3. **Sufficient trading volume** - Higher fees earned
4. **Appropriate fee tier** - Balance between fee income and IL

**Recommended Pools:**
- **ETH/USDC 0.05%** - Highest volume, tightest spreads
- **WBTC/USDC 0.3%** - Good volume, higher fees compensate for wider range
- **ARB/USDC 0.3%** - Native token, decent volume

---

## Part 3: System Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DeltaNeutralVault                           │
├─────────────────────────────────────────────────────────────────────┤
│  User Interface Layer                                               │
│  ├── deposit(uint256 amount)                                        │
│  ├── withdraw(uint256 shares)                                       │
│  ├── getYieldMetrics() → (1d, 7d, 30d APY)                         │
│  └── getPositionDetails() → (lpValue, perpValue, netDelta)         │
├─────────────────────────────────────────────────────────────────────┤
│  Strategy Layer                                                     │
│  ├── LiquidityManager (Uniswap v3)                                 │
│  │   ├── mintPosition()                                             │
│  │   ├── adjustRange()                                              │
│  │   ├── collectFees()                                              │
│  │   └── calculateDelta()                                           │
│  ├── HedgeManager (GMX v2)                                         │
│  │   ├── openShort()                                                │
│  │   ├── adjustPosition()                                           │
│  │   ├── closeShort()                                               │
│  │   └── collectFunding()                                           │
│  └── RebalanceController                                            │
│      ├── checkRebalanceNeeded()                                     │
│      └── executeRebalance()                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Data Layer                                                         │
│  ├── YieldAccounting                                                │
│  │   ├── trackFeeIncome()                                           │
│  │   ├── trackFundingPayments()                                     │
│  │   ├── trackRebalanceCosts()                                      │
│  │   └── calculateHistoricalYield()                                 │
│  └── PositionState                                                  │
│      ├── lpTokenId                                                  │
│      ├── perpPositionKey                                            │
│      └── lastRebalanceTimestamp                                     │
├─────────────────────────────────────────────────────────────────────┤
│  External Integrations                                              │
│  ├── Uniswap v3 NonfungiblePositionManager                         │
│  ├── GMX v2 ExchangeRouter + OrderVault                            │
│  ├── Chainlink Price Feeds                                         │
│  └── Chainlink Automation (Keepers)                                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      Keeper Infrastructure                          │
├─────────────────────────────────────────────────────────────────────┤
│  Chainlink Automation Upkeep                                        │
│  ├── checkUpkeep() - Off-chain delta monitoring                    │
│  └── performUpkeep() - Trigger rebalance when needed               │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Contract Structure

```
contracts/
├── core/
│   ├── DeltaNeutralVault.sol      # Main vault with ERC-4626
│   ├── LiquidityManager.sol       # Uniswap v3 integration
│   └── HedgeManager.sol           # GMX v2 integration
├── libraries/
│   ├── DeltaCalculator.sol        # LP position delta math
│   ├── TickMath.sol               # Price/tick conversions
│   └── YieldMath.sol              # APY calculations
├── periphery/
│   ├── SwapRouter.sol             # USDC ↔ ETH swaps
│   └── KeeperCompatible.sol       # Chainlink Automation
└── interfaces/
    ├── IUniswapV3.sol
    ├── IGMXV2.sol
    └── IChainlinkAutomation.sol
```

---

## Part 4: Core Implementation Details

### 4.1 Delta Calculation

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-core/contracts/libraries/FullMath.sol";

library DeltaCalculator {
    uint256 constant Q96 = 2**96;
    
    /// @notice Calculate delta of a Uniswap v3 LP position
    /// @param sqrtPriceX96 Current sqrt price
    /// @param sqrtPriceLowerX96 Lower bound sqrt price
    /// @param sqrtPriceUpperX96 Upper bound sqrt price  
    /// @param liquidity Position liquidity
    /// @return delta The position delta (scaled by 1e18)
    function calculateDelta(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) internal pure returns (int256 delta) {
        // If price below range: delta = L * (1/√Pa - 1/√Pb)
        if (sqrtPriceX96 <= sqrtPriceLowerX96) {
            // Full exposure to base token
            uint256 deltaAbs = FullMath.mulDiv(
                liquidity,
                uint256(sqrtPriceUpperX96 - sqrtPriceLowerX96),
                uint256(sqrtPriceLowerX96) * uint256(sqrtPriceUpperX96) / Q96
            );
            return int256(deltaAbs * 1e18 / Q96);
        }
        
        // If price above range: delta = 0
        if (sqrtPriceX96 >= sqrtPriceUpperX96) {
            return 0;
        }
        
        // In range: delta = L * (1/√S - 1/√Pb)
        uint256 deltaAbs = FullMath.mulDiv(
            liquidity,
            uint256(sqrtPriceUpperX96 - sqrtPriceX96),
            uint256(sqrtPriceX96) * uint256(sqrtPriceUpperX96) / Q96
        );
        
        return int256(deltaAbs * 1e18 / Q96);
    }
    
    /// @notice Get the amount of base token in a position (for delta verification)
    function getBaseTokenAmount(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount0) {
        if (sqrtPriceX96 <= sqrtPriceLowerX96) {
            // All base token
            amount0 = FullMath.mulDiv(
                liquidity,
                uint256(sqrtPriceUpperX96 - sqrtPriceLowerX96),
                uint256(sqrtPriceUpperX96)
            );
            amount0 = FullMath.mulDiv(amount0, Q96, sqrtPriceLowerX96);
        } else if (sqrtPriceX96 < sqrtPriceUpperX96) {
            // In range
            amount0 = FullMath.mulDiv(
                liquidity,
                uint256(sqrtPriceUpperX96 - sqrtPriceX96),
                uint256(sqrtPriceUpperX96)
            );
            amount0 = FullMath.mulDiv(amount0, Q96, sqrtPriceX96);
        }
        // else: all quote token, amount0 = 0
    }
}
```

### 4.2 GMX v2 Integration for Hedging

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./interfaces/IGMXV2.sol";

contract HedgeManager {
    IExchangeRouter public immutable exchangeRouter;
    IOrderVault public immutable orderVault;
    IDataStore public immutable dataStore;
    
    address public immutable market; // ETH/USD market
    address public immutable USDC;
    address public immutable WETH;
    
    bytes32 public currentPositionKey;
    
    struct HedgeParams {
        uint256 sizeDeltaUsd;     // Position size change in USD (30 decimals)
        uint256 collateralDelta;  // Collateral change
        bool isIncrease;          // true = increase short, false = decrease
    }
    
    /// @notice Open or increase a short position on GMX v2
    function adjustHedge(HedgeParams calldata params) external returns (bytes32 orderKey) {
        uint256 executionFee = getExecutionFee();
        
        // Transfer collateral to OrderVault
        if (params.isIncrease && params.collateralDelta > 0) {
            IERC20(USDC).transfer(address(orderVault), params.collateralDelta);
        }
        
        IExchangeRouter.CreateOrderParams memory orderParams = IExchangeRouter.CreateOrderParams({
            receiver: address(this),
            cancellationReceiver: address(this),
            callbackContract: address(this),
            uiFeeReceiver: address(0),
            market: market,
            initialCollateralToken: USDC,
            swapPath: new address[](0),
            orderType: params.isIncrease 
                ? IExchangeRouter.OrderType.MarketIncrease 
                : IExchangeRouter.OrderType.MarketDecrease,
            decreasePositionSwapType: IExchangeRouter.DecreasePositionSwapType.NoSwap,
            sizeDeltaUsd: params.sizeDeltaUsd,
            initialCollateralDeltaAmount: params.collateralDelta,
            triggerPrice: 0,
            acceptablePrice: type(uint256).max, // Market order
            executionFee: executionFee,
            callbackGasLimit: 0,
            minOutputAmount: 0,
            isLong: false, // SHORT position
            shouldUnwrapNativeToken: false,
            autoCancel: false,
            referralCode: bytes32(0)
        });
        
        orderKey = exchangeRouter.createOrder{value: executionFee}(orderParams);
    }
    
    /// @notice Get current short position size
    function getShortPositionSize() public view returns (uint256 sizeInUsd, uint256 collateral) {
        if (currentPositionKey == bytes32(0)) return (0, 0);
        
        // Read position from GMX DataStore
        bytes32 positionKey = keccak256(abi.encode(
            address(this),
            market,
            USDC,
            false // isLong
        ));
        
        // Position data stored in DataStore
        sizeInUsd = dataStore.getUint(
            keccak256(abi.encode(positionKey, "sizeInUsd"))
        );
        collateral = dataStore.getUint(
            keccak256(abi.encode(positionKey, "collateralAmount"))
        );
    }
    
    /// @notice Calculate required execution fee
    function getExecutionFee() public view returns (uint256) {
        return dataStore.getUint(
            keccak256(abi.encode("INCREASE_ORDER_GAS_LIMIT"))
        ) * tx.gasprice;
    }
}
```

### 4.3 Rebalancing Logic

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";

contract RebalanceController is AutomationCompatibleInterface {
    uint256 public constant DELTA_THRESHOLD = 5e16; // 5% delta deviation
    uint256 public constant MIN_REBALANCE_INTERVAL = 1 hours;
    uint256 public constant MAX_REBALANCE_INTERVAL = 24 hours;
    
    DeltaNeutralVault public vault;
    uint256 public lastRebalanceTime;
    
    struct RebalanceMetrics {
        int256 currentDelta;
        int256 targetDelta;
        int256 deltaDrift;
        bool needsRebalance;
        uint256 gasEstimate;
    }
    
    /// @notice Chainlink Automation check function (runs off-chain)
    function checkUpkeep(bytes calldata)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        RebalanceMetrics memory metrics = calculateRebalanceMetrics();
        
        // Rebalance needed if:
        // 1. Delta drift exceeds threshold, OR
        // 2. Max interval exceeded (forced rebalance)
        bool deltaExceeded = abs(metrics.deltaDrift) > DELTA_THRESHOLD;
        bool timeExceeded = block.timestamp > lastRebalanceTime + MAX_REBALANCE_INTERVAL;
        bool minIntervalPassed = block.timestamp > lastRebalanceTime + MIN_REBALANCE_INTERVAL;
        
        upkeepNeeded = minIntervalPassed && (deltaExceeded || timeExceeded);
        performData = abi.encode(metrics);
    }
    
    /// @notice Execute rebalance (called by Chainlink Keeper)
    function performUpkeep(bytes calldata performData) external override {
        RebalanceMetrics memory metrics = abi.decode(performData, (RebalanceMetrics));
        
        // Re-verify conditions on-chain
        require(
            abs(metrics.deltaDrift) > DELTA_THRESHOLD ||
            block.timestamp > lastRebalanceTime + MAX_REBALANCE_INTERVAL,
            "Rebalance not needed"
        );
        
        // Execute rebalance
        vault.rebalance(metrics.deltaDrift);
        lastRebalanceTime = block.timestamp;
        
        emit Rebalanced(metrics.currentDelta, metrics.targetDelta, block.timestamp);
    }
    
    function calculateRebalanceMetrics() public view returns (RebalanceMetrics memory) {
        // Get LP position delta
        int256 lpDelta = vault.calculateLPDelta();
        
        // Get current short position (negative delta)
        (uint256 shortSize,) = vault.getShortPosition();
        int256 hedgeDelta = -int256(shortSize);
        
        // Net delta should be 0
        int256 netDelta = lpDelta + hedgeDelta;
        
        return RebalanceMetrics({
            currentDelta: netDelta,
            targetDelta: 0,
            deltaDrift: netDelta, // Distance from target
            needsRebalance: abs(netDelta) > DELTA_THRESHOLD,
            gasEstimate: estimateRebalanceGas(netDelta)
        });
    }
    
    function abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
```

### 4.4 Yield Tracking System

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

library YieldAccounting {
    struct YieldSnapshot {
        uint256 timestamp;
        uint256 totalValue;
        uint256 cumulativeFees;
        int256 cumulativeFunding;
        uint256 cumulativeRebalanceCosts;
    }
    
    struct YieldMetrics {
        uint256 apy1Day;
        uint256 apy7Day;
        uint256 apy30Day;
        uint256 totalFeeIncome;
        int256 totalFundingIncome;
        uint256 totalRebalanceCosts;
        uint256 netYield;
    }
    
    /// @notice Calculate APY over a time period
    /// @param startSnapshot Starting snapshot
    /// @param endSnapshot Ending snapshot
    /// @return apy Annual percentage yield (scaled by 1e18)
    function calculateAPY(
        YieldSnapshot memory startSnapshot,
        YieldSnapshot memory endSnapshot
    ) internal pure returns (uint256 apy) {
        if (startSnapshot.totalValue == 0) return 0;
        
        uint256 timeDelta = endSnapshot.timestamp - startSnapshot.timestamp;
        if (timeDelta == 0) return 0;
        
        // Net income = fees + funding - rebalance costs
        uint256 feeIncome = endSnapshot.cumulativeFees - startSnapshot.cumulativeFees;
        int256 fundingIncome = endSnapshot.cumulativeFunding - startSnapshot.cumulativeFunding;
        uint256 rebalanceCosts = endSnapshot.cumulativeRebalanceCosts - startSnapshot.cumulativeRebalanceCosts;
        
        int256 netIncome = int256(feeIncome) + fundingIncome - int256(rebalanceCosts);
        
        if (netIncome <= 0) return 0;
        
        // APY = (netIncome / startValue) * (365 days / timeDelta) * 100%
        uint256 periodReturn = uint256(netIncome) * 1e18 / startSnapshot.totalValue;
        apy = periodReturn * 365 days / timeDelta;
    }
}

contract YieldTracker {
    using YieldAccounting for *;
    
    mapping(uint256 => YieldAccounting.YieldSnapshot) public dailySnapshots;
    uint256 public snapshotCount;
    
    uint256 public cumulativeFees;
    int256 public cumulativeFunding;
    uint256 public cumulativeRebalanceCosts;
    
    /// @notice Record daily snapshot (called by keeper)
    function recordSnapshot(uint256 totalValue) external {
        dailySnapshots[snapshotCount] = YieldAccounting.YieldSnapshot({
            timestamp: block.timestamp,
            totalValue: totalValue,
            cumulativeFees: cumulativeFees,
            cumulativeFunding: cumulativeFunding,
            cumulativeRebalanceCosts: cumulativeRebalanceCosts
        });
        snapshotCount++;
    }
    
    /// @notice Get yield metrics for display
    function getYieldMetrics() external view returns (YieldAccounting.YieldMetrics memory metrics) {
        if (snapshotCount == 0) return metrics;
        
        YieldAccounting.YieldSnapshot memory current = dailySnapshots[snapshotCount - 1];
        
        // 1-day APY
        if (snapshotCount >= 2) {
            metrics.apy1Day = YieldAccounting.calculateAPY(
                dailySnapshots[snapshotCount - 2],
                current
            );
        }
        
        // 7-day APY
        if (snapshotCount >= 8) {
            metrics.apy7Day = YieldAccounting.calculateAPY(
                dailySnapshots[snapshotCount - 8],
                current
            );
        }
        
        // 30-day APY
        if (snapshotCount >= 31) {
            metrics.apy30Day = YieldAccounting.calculateAPY(
                dailySnapshots[snapshotCount - 31],
                current
            );
        }
        
        metrics.totalFeeIncome = cumulativeFees;
        metrics.totalFundingIncome = cumulativeFunding;
        metrics.totalRebalanceCosts = cumulativeRebalanceCosts;
        
        int256 net = int256(cumulativeFees) + cumulativeFunding - int256(cumulativeRebalanceCosts);
        metrics.netYield = net > 0 ? uint256(net) : 0;
    }
}
```

### 4.5 Main Vault Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";

contract DeltaNeutralVault is ERC4626, ReentrancyGuard {
    using DeltaCalculator for *;
    
    // External contracts
    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter public immutable swapRouter;
    HedgeManager public immutable hedgeManager;
    YieldTracker public immutable yieldTracker;
    
    // Pool configuration
    address public immutable pool;
    address public immutable baseToken; // ETH
    address public immutable quoteToken; // USDC
    int24 public tickLower;
    int24 public tickUpper;
    
    // Position state
    uint256 public lpTokenId;
    
    // Strategy parameters
    uint256 public targetRangeWidth = 1000; // ~10% range
    uint256 public minLiquidityRatio = 8000; // 80% in LP
    
    constructor(
        IERC20 _usdc,
        address _pool,
        address _baseToken,
        INonfungiblePositionManager _positionManager,
        ISwapRouter _swapRouter,
        HedgeManager _hedgeManager
    ) ERC4626(_usdc) ERC20("Delta Neutral LP", "dnLP") {
        pool = _pool;
        baseToken = _baseToken;
        quoteToken = address(_usdc);
        positionManager = _positionManager;
        swapRouter = _swapRouter;
        hedgeManager = _hedgeManager;
    }
    
    /// @notice Deposit USDC and deploy into delta-neutral strategy
    function deposit(uint256 assets, address receiver) 
        public 
        override 
        nonReentrant 
        returns (uint256 shares) 
    {
        shares = super.deposit(assets, receiver);
        _deployCapital(assets);
    }
    
    /// @notice Withdraw USDC by unwinding positions
    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        shares = previewWithdraw(assets);
        _unwindCapital(assets);
        return super.withdraw(assets, receiver, owner);
    }
    
    /// @notice Deploy capital into LP + hedge
    function _deployCapital(uint256 usdcAmount) internal {
        // 1. Calculate optimal allocation
        (uint256 lpAmount, uint256 hedgeCollateral) = _calculateAllocation(usdcAmount);
        
        // 2. Swap portion to base token for LP
        uint256 swapAmount = _calculateSwapAmount(lpAmount);
        uint256 baseAmount = _swapQuoteToBase(swapAmount);
        
        // 3. Add liquidity to Uniswap v3
        _addLiquidity(baseAmount, lpAmount - swapAmount);
        
        // 4. Open/increase short hedge
        int256 lpDelta = calculateLPDelta();
        uint256 hedgeSize = uint256(lpDelta) * _getBasePrice() / 1e18;
        
        hedgeManager.adjustHedge(HedgeManager.HedgeParams({
            sizeDeltaUsd: hedgeSize * 1e30 / 1e18, // Convert to 30 decimals
            collateralDelta: hedgeCollateral,
            isIncrease: true
        }));
    }
    
    /// @notice Rebalance hedge to maintain delta neutrality
    function rebalance(int256 deltaDrift) external {
        require(msg.sender == address(rebalanceController), "Only controller");
        
        // Collect any accrued fees first
        _collectFees();
        
        // Adjust hedge position
        bool isIncrease = deltaDrift > 0; // Need more short if delta positive
        uint256 adjustmentSize = abs(deltaDrift) * _getBasePrice() / 1e18;
        
        hedgeManager.adjustHedge(HedgeManager.HedgeParams({
            sizeDeltaUsd: adjustmentSize * 1e30 / 1e18,
            collateralDelta: 0, // No collateral change for rebalance
            isIncrease: isIncrease
        }));
        
        emit Rebalanced(deltaDrift, block.timestamp);
    }
    
    /// @notice Compound accrued yield
    function compound() external {
        // 1. Collect LP fees
        uint256 feeAmount = _collectFees();
        
        // 2. Claim funding if positive
        int256 funding = hedgeManager.claimFunding();
        
        // 3. Reinvest
        if (feeAmount > 0 || funding > 0) {
            uint256 reinvestAmount = feeAmount;
            if (funding > 0) reinvestAmount += uint256(funding);
            
            _deployCapital(reinvestAmount);
            
            emit Compounded(feeAmount, funding, block.timestamp);
        }
    }
    
    /// @notice Get total vault value in USDC
    function totalAssets() public view override returns (uint256) {
        uint256 lpValue = _getLPValue();
        (uint256 hedgeSize, uint256 hedgeCollateral) = hedgeManager.getShortPositionSize();
        int256 hedgePnL = _calculateHedgePnL(hedgeSize);
        
        return lpValue + hedgeCollateral + (hedgePnL > 0 ? uint256(hedgePnL) : 0);
    }
    
    /// @notice Calculate current LP position delta
    function calculateLPDelta() public view returns (int256) {
        if (lpTokenId == 0) return 0;
        
        (,, address token0,,, int24 _tickLower, int24 _tickUpper, uint128 liquidity,,,,) = 
            positionManager.positions(lpTokenId);
            
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        
        return DeltaCalculator.calculateDelta(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(_tickLower),
            TickMath.getSqrtRatioAtTick(_tickUpper),
            liquidity
        );
    }
    
    // Internal helper functions...
    function _addLiquidity(uint256 amount0, uint256 amount1) internal {
        // Implementation details for Uniswap v3 liquidity provision
    }
    
    function _collectFees() internal returns (uint256) {
        // Collect from Uniswap position
    }
    
    function _swapQuoteToBase(uint256 amount) internal returns (uint256) {
        // Swap via Uniswap router
    }
    
    function _getBasePrice() internal view returns (uint256) {
        // Get price from Chainlink or pool
    }
}
```

---

## Part 5: Keeper System Design

### 5.1 Chainlink Automation Integration

```solidity
// Keeper contract for monitoring and triggering rebalances
contract DeltaNeutralKeeper is AutomationCompatibleInterface {
    DeltaNeutralVault public vault;
    
    uint256 public constant DELTA_THRESHOLD = 5e16;  // 5%
    uint256 public constant COMPOUND_INTERVAL = 1 days;
    uint256 public constant SNAPSHOT_INTERVAL = 1 days;
    
    uint256 public lastCompoundTime;
    uint256 public lastSnapshotTime;
    
    enum UpkeepType { REBALANCE, COMPOUND, SNAPSHOT }
    
    function checkUpkeep(bytes calldata)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        // Priority 1: Check for rebalance need
        int256 netDelta = vault.getNetDelta();
        if (abs(netDelta) > DELTA_THRESHOLD) {
            return (true, abi.encode(UpkeepType.REBALANCE, netDelta));
        }
        
        // Priority 2: Check for compound
        if (block.timestamp > lastCompoundTime + COMPOUND_INTERVAL) {
            uint256 pendingFees = vault.getPendingFees();
            if (pendingFees > MIN_COMPOUND_AMOUNT) {
                return (true, abi.encode(UpkeepType.COMPOUND, pendingFees));
            }
        }
        
        // Priority 3: Daily snapshot
        if (block.timestamp > lastSnapshotTime + SNAPSHOT_INTERVAL) {
            return (true, abi.encode(UpkeepType.SNAPSHOT, uint256(0)));
        }
        
        return (false, "");
    }
    
    function performUpkeep(bytes calldata performData) external override {
        (UpkeepType upkeepType, int256 data) = abi.decode(performData, (UpkeepType, int256));
        
        if (upkeepType == UpkeepType.REBALANCE) {
            vault.rebalance(data);
        } else if (upkeepType == UpkeepType.COMPOUND) {
            vault.compound();
            lastCompoundTime = block.timestamp;
        } else if (upkeepType == UpkeepType.SNAPSHOT) {
            vault.yieldTracker().recordSnapshot(vault.totalAssets());
            lastSnapshotTime = block.timestamp;
        }
    }
}
```

### 5.2 Off-Chain Monitoring Script (Backup/Supplementary)

```typescript
// keeper/src/monitor.ts
import { ethers } from 'ethers';
import { DeltaNeutralVault__factory } from './typechain';

interface MonitorConfig {
  rpcUrl: string;
  vaultAddress: string;
  privateKey: string;
  deltaThreshold: number;  // e.g., 0.05 for 5%
  checkIntervalMs: number; // e.g., 60000 for 1 minute
}

async function monitorVault(config: MonitorConfig) {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const vault = DeltaNeutralVault__factory.connect(config.vaultAddress, wallet);
  
  console.log('Starting delta-neutral vault monitor...');
  
  setInterval(async () => {
    try {
      // 1. Get current positions
      const lpDelta = await vault.calculateLPDelta();
      const [shortSize] = await vault.hedgeManager().getShortPositionSize();
      const hedgeDelta = -shortSize;
      
      const netDelta = lpDelta + hedgeDelta;
      const totalValue = await vault.totalAssets();
      const deltaPct = Number(netDelta) / Number(totalValue);
      
      console.log(`Net Delta: ${deltaPct.toFixed(4)} (${(deltaPct * 100).toFixed(2)}%)`);
      
      // 2. Check if rebalance needed
      if (Math.abs(deltaPct) > config.deltaThreshold) {
        console.log('Delta threshold exceeded, triggering rebalance...');
        
        const tx = await vault.rebalance(netDelta, {
          gasLimit: 1_000_000,
        });
        
        const receipt = await tx.wait();
        console.log(`Rebalance executed: ${receipt.hash}`);
      }
      
      // 3. Check for pending fees to compound
      const pendingFees = await vault.getPendingFees();
      if (pendingFees > ethers.parseUnits('100', 6)) { // > 100 USDC
        console.log('Compounding fees...');
        const tx = await vault.compound({ gasLimit: 800_000 });
        await tx.wait();
      }
      
    } catch (error) {
      console.error('Monitor error:', error);
    }
  }, config.checkIntervalMs);
}
```

---

## Part 6: Risk Analysis & Mitigations

### 6.1 Risk Categories

| Risk Category | Risk | Severity | Mitigation |
|--------------|------|----------|------------|
| **Market Risk** | Extreme price moves outside LP range | High | Wide range, automatic range adjustment |
| **Market Risk** | Negative funding rates | Medium | Monitor and exit if persistent |
| **Protocol Risk** | GMX liquidation | High | Conservative leverage (2-3x max) |
| **Protocol Risk** | Uniswap v3 pool manipulation | Medium | TWAP price checks |
| **Execution Risk** | Rebalance front-running | Medium | Private mempool, slippage limits |
| **Execution Risk** | Keeper failure | High | Multiple keeper redundancy |
| **Smart Contract Risk** | Bugs in vault logic | Critical | Audits, formal verification |
| **Smart Contract Risk** | Integration bugs (GMX/Uni) | High | Extensive testing, gradual rollout |

### 6.2 Position Sizing Guardrails

```solidity
// Risk parameters
uint256 public constant MAX_LEVERAGE = 3e18;           // 3x max leverage on perp
uint256 public constant MAX_SINGLE_TX_PCT = 10e16;     // 10% of vault per tx
uint256 public constant MIN_HEDGE_RATIO = 80e16;       // Hedge at least 80% of delta
uint256 public constant MAX_HEDGE_RATIO = 120e16;      // Don't over-hedge beyond 120%
uint256 public constant EMERGENCY_DELTA_THRESHOLD = 20e16; // Emergency unwind at 20% drift
```

### 6.3 Circuit Breakers

```solidity
contract EmergencyModule {
    bool public paused;
    uint256 public lastPauseTime;
    
    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }
    
    /// @notice Emergency pause if delta exceeds critical threshold
    function checkEmergencyConditions() external returns (bool shouldPause) {
        int256 netDelta = vault.getNetDelta();
        uint256 totalValue = vault.totalAssets();
        
        // Pause if delta drift > 20%
        if (abs(netDelta) * 1e18 / totalValue > EMERGENCY_DELTA_THRESHOLD) {
            _pause("Critical delta drift");
            return true;
        }
        
        // Pause if GMX position near liquidation
        (,, uint256 liqPrice) = vault.hedgeManager().getPositionHealth();
        uint256 currentPrice = _getPrice();
        if (currentPrice > liqPrice * 90 / 100) { // Within 10% of liquidation
            _pause("Near liquidation");
            return true;
        }
        
        return false;
    }
    
    /// @notice Emergency full unwind
    function emergencyUnwind() external onlyOwner {
        _pause("Manual emergency");
        
        // 1. Close all perp positions
        vault.hedgeManager().emergencyClose();
        
        // 2. Remove all LP liquidity
        vault.emergencyRemoveLiquidity();
        
        // 3. All assets now in USDC, users can withdraw
        emit EmergencyUnwind(block.timestamp);
    }
}
```

---

## Part 7: Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)

**Deliverables:**
- [ ] Core smart contract structure
- [ ] Delta calculation library with tests
- [ ] Basic Uniswap v3 integration (mint/burn/collect)
- [ ] Unit tests for delta math

**Milestones:**
1. Deploy delta calculator with >99% accuracy vs reference implementation
2. Successfully create/manage Uniswap v3 positions on testnet

### Phase 2: Hedging Integration (Weeks 3-4)

**Deliverables:**
- [ ] GMX v2 integration for opening/closing shorts
- [ ] Position sizing logic
- [ ] Funding rate tracking

**Milestones:**
1. Successfully open/close short positions programmatically
2. Verify hedge accurately offsets LP delta

### Phase 3: Automation & Yield Tracking (Weeks 5-6)

**Deliverables:**
- [ ] Chainlink Automation integration
- [ ] Yield tracking and APY calculation
- [ ] Compound functionality
- [ ] Off-chain keeper script

**Milestones:**
1. Automated rebalancing within 5% delta threshold
2. Accurate 1/7/30 day yield reporting

### Phase 4: Security & Testing (Weeks 7-8)

**Deliverables:**
- [ ] Comprehensive test suite (unit + integration + fuzzing)
- [ ] Emergency procedures and circuit breakers
- [ ] Internal audit and fixes
- [ ] Gas optimization

**Milestones:**
1. 100% code coverage on critical paths
2. Pass internal security review
3. Gas costs < 500k for rebalance operation

### Phase 5: Deployment & Monitoring (Weeks 9-10)

**Deliverables:**
- [ ] Mainnet deployment (start with cap)
- [ ] Monitoring dashboard
- [ ] Documentation
- [ ] External audit engagement

**Milestones:**
1. Live on Arbitrum mainnet with $10k cap
2. 2 weeks stable operation before cap increase

---

## Part 8: Expected Economics

### 8.1 Revenue Sources

| Source | Expected Range | Notes |
|--------|---------------|-------|
| LP Fees (ETH/USDC 0.05%) | 5-15% APY | Volume dependent |
| LP Fees (ETH/USDC 0.3%) | 10-25% APY | Higher fee tier |
| Perp Funding (when receiving) | 0-20% APY | Market dependent |

### 8.2 Cost Sources

| Cost | Expected Range | Notes |
|------|---------------|-------|
| Perp Funding (when paying) | 0-30% APY | Market dependent |
| Rebalance gas | 0.1-0.5% APY | Frequency dependent |
| Swap slippage | 0.05-0.2% per rebalance | Size dependent |
| GMX borrowing fees | 0.01-0.1% per day | Utilization dependent |

### 8.3 Target Net Yield

**Conservative estimate**: 5-15% APY in normal market conditions
**Bull case**: 20-30% APY with favorable funding rates
**Bear case**: 0-5% APY with negative funding

---

## Part 9: Technology Stack Summary

```
Smart Contracts:
├── Solidity 0.8.19+
├── OpenZeppelin (ERC4626, ReentrancyGuard)
├── Uniswap v3 SDK
└── Chainlink Automation

External Protocols:
├── Uniswap v3 (Arbitrum)
├── GMX v2 (Arbitrum)
├── Chainlink (Price Feeds + Automation)
└── (Optional) Gelato as backup keeper

Development:
├── Foundry (testing + deployment)
├── Hardhat (optional, for coverage)
└── TypeScript (keeper scripts)

Monitoring:
├── Tenderly (transaction simulation)
├── OpenZeppelin Defender (alerts)
└── Custom dashboard (yield metrics)
```

---

## Part 10: Multi-Market Configuration

The system is designed to support multiple token pairs beyond ETH/USDC, enabling deployment of specialized vaults like harmonia-ETH, harmonia-BTC, harmonia-ARB with different yield/risk characteristics.

### 10.1 Supported Markets

| Market | Base Token | Uniswap Pool | GMX Market | Expected APY | Risk Level |
|--------|------------|--------------|------------|--------------|------------|
| **ETH** | WETH (18 dec) | ETH/USDC 0.05% | ETH/USD | 5-20% | Moderate |
| **BTC** | WBTC (8 dec) | WBTC/USDC 0.3% | BTC/USD | 3-15% | Moderate |
| **ARB** | ARB (18 dec) | ARB/USDC 0.3% | ARB/USD | 10-40% | Aggressive |
| **LINK** | LINK (18 dec) | LINK/USDC 0.3% | LINK/USD | 8-30% | Aggressive |

### 10.2 Market Configuration Structure

Each market requires:
1. **Uniswap V3 Pool** - For LP position
2. **GMX V2 Market** - For perpetual hedge
3. **Chainlink Price Feed** - For price verification
4. **Matching tokens** - Base token must match across all components

```typescript
interface MarketConfig {
  id: string;                    // "ETH", "BTC", "ARB"
  baseToken: TokenConfig;        // Volatile token (what we hedge)
  quoteToken: TokenConfig;       // Stable token (USDC)
  uniswapPool: UniswapPoolConfig;
  gmxMarket: GMXMarketConfig;
  chainlinkFeed: ChainlinkFeedConfig;
  baseTokenIsToken0: boolean;    // Token ordering in pool
  strategyParams: StrategyParams;
}
```

### 10.3 Scripts

```bash
# Validate a market configuration
MARKET=ETH npx hardhat run scripts/validate-market.ts --network hardhat

# Discover viable markets for a token
TOKEN=GMX npx hardhat run scripts/discover-markets.ts --network hardhat

# Evaluate custom contract addresses
UNISWAP_POOL=0x... GMX_MARKET=0x... CHAINLINK_FEED=0x... \
  npx hardhat run scripts/evaluate-custom-market.ts --network hardhat

# Deploy a vault for a market
MARKET=ETH npx hardhat run scripts/deploy-vault.ts --network arbitrum
```

### 10.4 Deployment Process

1. **Select Market**: Choose from pre-configured markets or create new config
2. **Validate**: Run `validate-market.ts` to verify all components
3. **Deploy**: Run `deploy-vault.ts` with appropriate market
4. **Configure**: Set strategy parameters and keeper
5. **Seed**: Provide initial liquidity
6. **Enable**: Open deposits

### 10.5 Adding New Markets

To add support for a new token pair:

1. **Discover components**:
   ```bash
   TOKEN=NEW_TOKEN npx hardhat run scripts/discover-markets.ts
   ```

2. **Add to registry** (`src/markets/registry.ts`):
   ```typescript
   export const NEW_MARKET: MarketConfig = {
     id: "NEW",
     name: "Harmonia NEW",
     // ... configuration from discovery output
   };
   ```

3. **Validate configuration**:
   ```bash
   MARKET=NEW npx hardhat run scripts/validate-market.ts
   ```

4. **Deploy**:
   ```bash
   MARKET=NEW npx hardhat run scripts/deploy-vault.ts --network arbitrum
   ```

### 10.6 Token Decimal Handling

Different tokens have different decimal places, which affects price calculations:

| Token | Decimals | Decimal Adjustment vs USDC |
|-------|----------|---------------------------|
| WETH | 18 | 10^12 |
| ARB | 18 | 10^12 |
| LINK | 18 | 10^12 |
| WBTC | 8 | 10^2 |
| USDC | 6 | - |

The `MarketConfig.decimalAdjustment` field handles this automatically.

---

## Appendix A: Key Contract Addresses (Arbitrum)

### Protocol Infrastructure (shared across all markets)

```
Uniswap v3:
- Factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984
- NonfungiblePositionManager: 0xC36442b4a4522E871399CD717aBDD847Ab11FE88
- SwapRouter: 0xE592427A0AEce92De3Edee1F18E0157C05861564
- Quoter: 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6

GMX v2:
- ExchangeRouter: 0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8
- OrderVault: 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5
- DataStore: 0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8
- Reader: 0xf60becbba223EEA9495Da3f606753867eC10d139

Chainlink:
- Automation Registry: 0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1
```

### Market-Specific Addresses

```
ETH Market:
- Uniswap Pool (ETH/USDC 0.05%): 0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443
- GMX Market (ETH/USD): 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336
- Chainlink Feed (ETH/USD): 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612

BTC Market:
- Uniswap Pool (WBTC/USDC 0.3%): 0xac70bD92F89e6739B3a08Db9B6081a923912f73D
- GMX Market (BTC/USD): 0x47c031236e19d024b42f8AE6780E44A573170703
- Chainlink Feed (BTC/USD): 0x6ce185860a4963106506C203335A2910525d22AD

ARB Market:
- Uniswap Pool (ARB/USDC 0.3%): 0xC6F780497A95e246EB9449f5e4770916DCd6396A
- GMX Market (ARB/USD): 0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407
- Chainlink Feed (ARB/USD): 0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6

LINK Market:
- Uniswap Pool (LINK/USDC 0.3%): 0x655B739E0b3BB00D6b74BBCd5C9169aEb0aa2e68
- GMX Market (LINK/USD): 0x7f1fa204bb700853D36994DA19F830b6Ad18455C
- Chainlink Feed (LINK/USD): 0x86E53CF1B870786351Da77A57575e79CB55812CB
```

### Tokens

```
Stablecoins:
- USDC (Native): 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
- USDC.e (Bridged): 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8

Base Tokens:
- WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
- WBTC: 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f
- ARB: 0x912CE59144191C1204E64559FE8253a0e49E6548
- LINK: 0xf97f4df75117a78c1A5a0DBb814Af92458539FB4
```

---

## Appendix B: References

1. Lambert, G. "Pricing Uniswap v3 LP Positions: Towards a New Options Paradigm" (2021)
2. Lambert, G. "Understanding the Value of Uniswap v3 Liquidity Positions" (2021)
3. Khakhar, A. & Chen, X. "Delta Hedging Liquidity Positions on Automated Market Makers" (2022)
4. Elsts, A. "Liquidity Math in Uniswap V3" Technical Note
5. GMX Documentation: https://docs.gmx.io/
6. Uniswap v3 Documentation: https://docs.uniswap.org/
7. Chainlink Automation Documentation: https://docs.chain.link/chainlink-automation

---

*Document prepared for Sean - January 2026*
