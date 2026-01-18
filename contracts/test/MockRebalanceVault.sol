// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockRebalanceVault
/// @notice Minimal mock of DeltaNeutralVault for testing RebalanceController
contract MockRebalanceVault {
    // ============ State Variables ============

    /// @notice Current delta ratio (scaled by 1e18)
    int256 public deltaRatio;

    /// @notice Threshold for triggering rebalance (scaled by 1e18)
    uint256 public deltaThreshold;

    /// @notice Timestamp of last rebalance
    uint256 public lastRebalanceTime;

    /// @notice Total assets under management (for snapshot tests)
    uint256 public totalAssetsValue;

    /// @notice Total fees collected (for snapshot tests)
    uint256 public totalFeesCollected;

    /// @notice Total funding received/paid (for snapshot tests)
    int256 public totalFundingReceived;

    /// @notice Number of times rebalance has been called
    uint256 public rebalanceCallCount;

    /// @notice Last target hedge size passed to rebalance
    uint256 public lastRebalanceTargetSize;

    /// @notice Number of times compound has been called
    uint256 public compoundCallCount;

    // ============ Constructor ============

    /// @param _deltaThreshold Initial delta threshold (scaled by 1e18)
    constructor(uint256 _deltaThreshold) {
        deltaThreshold = _deltaThreshold;
    }

    // ============ External Admin Functions ============

    /// @notice Set the simulated delta ratio
    function setDeltaRatio(int256 _deltaRatio) external {
        deltaRatio = _deltaRatio;
    }

    /// @notice Set the simulated last rebalance timestamp
    function setLastRebalanceTime(uint256 timestamp) external {
        lastRebalanceTime = timestamp;
    }

    /// @notice Set snapshot-related totals
    function setTotals(
        uint256 _totalAssets,
        uint256 _totalFeesCollected,
        int256 _totalFundingReceived
    ) external {
        totalAssetsValue = _totalAssets;
        totalFeesCollected = _totalFeesCollected;
        totalFundingReceived = _totalFundingReceived;
    }

    // ============ Vault Interface ============

    /// @notice Mirror of DeltaNeutralVault.getDeltaRatio()
    function getDeltaRatio() external view returns (int256) {
        return deltaRatio;
    }

    /// @notice Mirror of ERC4626.totalAssets()
    function totalAssets() external view returns (uint256) {
        return totalAssetsValue;
    }

    /// @notice Simulated rebalance call
    function rebalance(uint256 targetHedgeSize) external {
        rebalanceCallCount += 1;
        lastRebalanceTargetSize = targetHedgeSize;
        lastRebalanceTime = block.timestamp;
    }

    /// @notice Simulated compound call
    function compound() external {
        compoundCallCount += 1;
    }
}
