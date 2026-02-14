// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockSafe
/// @notice Minimal mock of a Gnosis Safe for testing AgentPolicyModule.
///         Implements execTransactionFromModule by forwarding the call.
contract MockSafe {
    event ExecutedFromModule(address indexed module, address to, uint256 value, bytes data);

    /// @notice Accept ETH deposits (so the Safe can hold funds).
    receive() external payable {}

    /// @notice Execute a transaction from an enabled module.
    /// @dev In a real Safe, this checks that msg.sender is an enabled module.
    ///      For testing, we accept all callers.
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        uint8 /* operation */
    ) external returns (bool success) {
        // Execute the call (operation 0 = Call)
        (success, ) = to.call{value: value}(data);
        emit ExecutedFromModule(msg.sender, to, value, data);
    }
}
