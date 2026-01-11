// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title Chainlink Price Feed Interface
/// @notice Interface for reading price data from Chainlink oracles
interface AggregatorV3Interface {
    /// @notice Returns the number of decimals in the price feed
    function decimals() external view returns (uint8);

    /// @notice Returns a human-readable description of the price feed
    function description() external view returns (string memory);

    /// @notice Returns the version of the aggregator
    function version() external view returns (uint256);

    /// @notice Gets data about a specific round
    function getRoundData(uint80 _roundId)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    /// @notice Gets data about the latest round
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @title Chainlink Automation Compatible Interface
/// @notice Interface for contracts that can be automated via Chainlink Automation
interface AutomationCompatibleInterface {
    /// @notice Called by the Chainlink Keeper to check if upkeep is needed
    /// @param checkData Arbitrary bytes passed when the upkeep was registered
    /// @return upkeepNeeded Whether upkeep is needed
    /// @return performData Data to pass to performUpkeep if upkeep is needed
    function checkUpkeep(bytes calldata checkData)
        external
        returns (bool upkeepNeeded, bytes memory performData);

    /// @notice Called by the Chainlink Keeper when upkeep is needed
    /// @param performData Data returned by checkUpkeep
    function performUpkeep(bytes calldata performData) external;
}

/// @title Chainlink Automation Registry Interface
/// @notice Interface for interacting with the Chainlink Automation Registry
interface IAutomationRegistry {
    struct UpkeepInfo {
        address target;
        uint32 executeGas;
        bytes checkData;
        uint96 balance;
        address admin;
        uint64 maxValidBlocknumber;
        uint32 lastPerformedBlockNumber;
        uint96 amountSpent;
        bool paused;
    }

    /// @notice Gets information about an upkeep
    function getUpkeep(uint256 id) external view returns (UpkeepInfo memory);

    /// @notice Gets the minimum balance required for an upkeep
    function getMinBalanceForUpkeep(uint256 id) external view returns (uint96);

    /// @notice Adds funds to an upkeep
    function addFunds(uint256 id, uint96 amount) external;

    /// @notice Pauses an upkeep
    function pauseUpkeep(uint256 id) external;

    /// @notice Unpauses an upkeep
    function unpauseUpkeep(uint256 id) external;

    /// @notice Cancels an upkeep
    function cancelUpkeep(uint256 id) external;

    /// @notice Withdraws funds from a cancelled upkeep
    function withdrawFunds(uint256 id, address to) external;
}

/// @title Chainlink Registrar Interface
/// @notice Interface for registering new upkeeps
interface IAutomationRegistrar {
    struct RegistrationParams {
        string name;
        bytes encryptedEmail;
        address upkeepContract;
        uint32 gasLimit;
        address adminAddress;
        uint8 triggerType;
        bytes checkData;
        bytes triggerConfig;
        bytes offchainConfig;
        uint96 amount;
    }

    /// @notice Registers a new upkeep
    function registerUpkeep(RegistrationParams calldata requestParams)
        external
        returns (uint256);
}
