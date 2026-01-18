// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AutomationCompatibleInterface} from "../interfaces/IChainlink.sol";

/// @notice Minimal interface for the delta-neutral vault used by the controller
interface IDeltaNeutralVaultMinimal {
    function getDeltaRatio() external view returns (int256);

    function deltaThreshold() external view returns (uint256);

    function lastRebalanceTime() external view returns (uint256);

    function rebalance(uint256 targetHedgeSize) external;

    function compound() external;

    function totalAssets() external view returns (uint256);

    function totalFeesCollected() external view returns (uint256);

    function totalFundingReceived() external view returns (int256);
}

/// @title Delta-Neutral Rebalance Controller
/// @notice Chainlink Automation-compatible keeper for delta monitoring and maintenance tasks
contract RebalanceController is AutomationCompatibleInterface, OwnableUpgradeable, UUPSUpgradeable {
    // ============ Types ============

    /// @notice Type of upkeep operation to perform
    enum UpkeepType {
        None,
        Rebalance,
        Compound,
        Snapshot
    }

    // ============ Constants ============

    /// @notice Precision for percentage calculations (1e18 = 100%)
    uint256 public constant PRECISION = 1e18;

    // ============ State Variables ============

    /// @notice Minimum interval between rebalances under normal conditions (default 1 hour)
    uint256 public minRebalanceInterval;

    /// @notice Maximum interval between rebalances (safety backstop) (default 24 hours)
    uint256 public maxRebalanceInterval;

    /// @notice Minimum interval between compound operations (default 1 day)
    uint256 public minCompoundInterval;

    /// @notice Minimum interval between yield snapshots (default 6 hours)
    uint256 public minSnapshotInterval;

    /// @notice Delta-neutral vault controlled by this keeper
    IDeltaNeutralVaultMinimal public vault;

    /// @notice Timestamp of last compound operation
    uint256 public lastCompoundTime;

    /// @notice Timestamp of last snapshot operation
    uint256 public lastSnapshotTime;

    // ============ Gap for Upgradeability ============
    uint256[50] private __gap;

    // ============ Events ============

    /// @notice Emitted when an upkeep is successfully executed
    /// @param upkeepType Type of upkeep performed
    /// @param deltaRatio Current net delta ratio at execution
    /// @param timestamp Block timestamp when upkeep was executed
    event UpkeepPerformed(UpkeepType indexed upkeepType, int256 deltaRatio, uint256 timestamp);

    /// @notice Emitted when a yield snapshot is recorded
    /// @param totalAssets Current total assets reported by vault
    /// @param totalFeesCollected Cumulative fees collected
    /// @param totalFundingReceived Cumulative funding income/expense
    /// @param timestamp Block timestamp when snapshot was recorded
    event SnapshotRecorded(
        uint256 totalAssets,
        uint256 totalFeesCollected,
        int256 totalFundingReceived,
        uint256 timestamp
    );

    /// @notice Emitted when vault address is updated
    event VaultUpdated(address indexed oldVault, address indexed newVault);

    /// @notice Emitted when rebalance intervals are updated
    event RebalanceIntervalsUpdated(uint256 minInterval, uint256 maxInterval);

    /// @notice Emitted when compound interval is updated
    event CompoundIntervalUpdated(uint256 oldInterval, uint256 newInterval);

    /// @notice Emitted when snapshot interval is updated
    event SnapshotIntervalUpdated(uint256 oldInterval, uint256 newInterval);

    /// @notice Thrown when a zero address is provided where not allowed
    error ZeroAddress();

    // ============ Initializer ============

    /// @param _vault Address of the DeltaNeutralVault contract
    /// @param _owner Owner address for administrative control
    function initialize(address _vault, address _owner) public initializer {
        if (_vault == address(0)) revert ZeroAddress();

        __Ownable_init(_owner);
        __UUPSUpgradeable_init();

        vault = IDeltaNeutralVaultMinimal(_vault);

        // Initialize configurable parameters
        minRebalanceInterval = 1 hours;
        maxRebalanceInterval = 24 hours;
        minCompoundInterval = 1 days;
        minSnapshotInterval = 6 hours;
    }

    /// @dev Authorize upgrade - only owner can upgrade
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ============ External Functions ============

    /// @notice Set the vault address
    /// @param _vault New vault address
    function setVault(address _vault) external onlyOwner {
        if (_vault == address(0)) revert ZeroAddress();
        address oldVault = address(vault);
        vault = IDeltaNeutralVaultMinimal(_vault);
        emit VaultUpdated(oldVault, _vault);
    }

    /// @notice Set rebalance intervals
    /// @param _minInterval Minimum interval between rebalances
    /// @param _maxInterval Maximum interval between rebalances
    function setRebalanceIntervals(uint256 _minInterval, uint256 _maxInterval) external onlyOwner {
        require(_minInterval <= _maxInterval, "Invalid intervals");
        minRebalanceInterval = _minInterval;
        maxRebalanceInterval = _maxInterval;
        emit RebalanceIntervalsUpdated(_minInterval, _maxInterval);
    }

    /// @notice Set compound interval
    /// @param _interval New compound interval
    function setCompoundInterval(uint256 _interval) external onlyOwner {
        uint256 oldInterval = minCompoundInterval;
        minCompoundInterval = _interval;
        emit CompoundIntervalUpdated(oldInterval, _interval);
    }

    /// @notice Set snapshot interval
    /// @param _interval New snapshot interval
    function setSnapshotInterval(uint256 _interval) external onlyOwner {
        uint256 oldInterval = minSnapshotInterval;
        minSnapshotInterval = _interval;
        emit SnapshotIntervalUpdated(oldInterval, _interval);
    }

    // ============ Chainlink Automation Interface ============

    /// @inheritdoc AutomationCompatibleInterface
    function checkUpkeep(
        bytes calldata /* checkData */
    ) external view override returns (bool upkeepNeeded, bytes memory performData) {
        UpkeepType upkeepType;
        (upkeepNeeded, upkeepType, ) = _selectUpkeepType();

        if (!upkeepNeeded) {
            return (false, bytes(""));
        }

        // Encode upkeep type for off-chain transparency
        performData = abi.encode(uint8(upkeepType));
    }

    /// @inheritdoc AutomationCompatibleInterface
    function performUpkeep(bytes calldata /* performData */) external override {
        (bool upkeepNeeded, UpkeepType upkeepType, int256 deltaRatio) = _selectUpkeepType();

        if (!upkeepNeeded || upkeepType == UpkeepType.None) {
            // No-op to avoid reverting and wasting keeper gas
            return;
        }

        if (upkeepType == UpkeepType.Rebalance) {
            // NOTE: target hedge sizing is determined inside the vault.
            // We pass 0 and let the vault compute the appropriate adjustment.
            vault.rebalance(0);
        } else if (upkeepType == UpkeepType.Compound) {
            vault.compound();
            lastCompoundTime = block.timestamp;
        } else if (upkeepType == UpkeepType.Snapshot) {
            _recordSnapshot();
        }

        emit UpkeepPerformed(upkeepType, deltaRatio, block.timestamp);
    }

    // ============ Internal Helpers ============

    /// @notice Determine which upkeep (if any) should be executed
    /// @return upkeepNeeded True if any upkeep should be performed
    /// @return upkeepType Type of upkeep to perform
    /// @return deltaRatio Current net delta ratio from the vault
    function _selectUpkeepType()
        internal
        view
        returns (bool upkeepNeeded, UpkeepType upkeepType, int256 deltaRatio)
    {
        deltaRatio = vault.getDeltaRatio();

        // Compute absolute delta ratio
        int256 absRatioSigned = deltaRatio >= 0 ? deltaRatio : -deltaRatio;
        uint256 absRatio = uint256(absRatioSigned);

        uint256 threshold = vault.deltaThreshold();
        uint256 lastRebalance = vault.lastRebalanceTime();

        bool hasRebalanced = lastRebalance != 0;
        uint256 timeSinceRebalance = hasRebalanced ? block.timestamp - lastRebalance : 0;
        bool deltaExceeded = absRatio > threshold;
        bool minIntervalPassed = !hasRebalanced || timeSinceRebalance >= minRebalanceInterval;
        bool maxIntervalExceeded = hasRebalanced && timeSinceRebalance >= maxRebalanceInterval;

        // Priority 1: Rebalance when delta drift or max interval reached
        if ((deltaExceeded && minIntervalPassed) || maxIntervalExceeded) {
            return (true, UpkeepType.Rebalance, deltaRatio);
        }

        // Priority 2: Compound on interval
        uint256 timeSinceCompound = lastCompoundTime == 0
            ? type(uint256).max
            : block.timestamp - lastCompoundTime;
        if (timeSinceCompound >= minCompoundInterval) {
            return (true, UpkeepType.Compound, deltaRatio);
        }

        // Priority 3: Snapshot on shorter interval
        uint256 timeSinceSnapshot = lastSnapshotTime == 0
            ? type(uint256).max
            : block.timestamp - lastSnapshotTime;
        if (timeSinceSnapshot >= minSnapshotInterval) {
            return (true, UpkeepType.Snapshot, deltaRatio);
        }

        return (false, UpkeepType.None, deltaRatio);
    }

    /// @notice Record a lightweight on-chain yield snapshot via event
    function _recordSnapshot() internal {
        uint256 assets = vault.totalAssets();
        uint256 fees = vault.totalFeesCollected();
        int256 funding = vault.totalFundingReceived();

        lastSnapshotTime = block.timestamp;

        emit SnapshotRecorded(assets, fees, funding, block.timestamp);
    }
}
