// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title AgentPolicyModule
/// @notice Safe module that enforces spending policies for AI agent session keys.
/// @dev The owner (human) grants scoped session keys to agents. Each key has
///      per-tx, daily, and weekly spending limits plus contract/function allowlists.
///      Designed to be used as a Safe module — the Safe calls `validateTransaction`
///      before executing any transaction initiated by a session key.
contract AgentPolicyModule is Ownable {
    struct AgentPolicy {
        uint256 maxPerTx;
        uint256 maxDaily;
        uint256 maxWeekly;
        uint256 humanApprovalAbove;
        address[] allowedContracts;
        bytes4[] allowedFunctions;
        address[] allowedTokens;
        uint256 expiresAt;
        bool active;
    }

    struct SpendingTracker {
        uint256 dailySpent;
        uint256 weeklySpent;
        uint256 lastDayReset;
        uint256 lastWeekReset;
    }

    mapping(address => AgentPolicy) internal _policies;
    mapping(address => SpendingTracker) public spending;

    uint256 public sessionCount;

    event SessionGranted(
        address indexed sessionKey,
        uint256 maxPerTx,
        uint256 maxDaily,
        uint256 maxWeekly,
        uint256 expiresAt
    );
    event SessionRevoked(address indexed sessionKey);
    event TransactionValidated(
        address indexed sessionKey,
        address indexed target,
        uint256 value
    );
    event TransactionRejected(
        address indexed sessionKey,
        address indexed target,
        uint256 value,
        string reason
    );
    event SpendingLimitHit(
        address indexed sessionKey,
        string limitType,
        uint256 spent,
        uint256 limit
    );

    constructor() Ownable(msg.sender) {}

    // ──────────────────────────────────────────────
    // Session Management (owner only)
    // ──────────────────────────────────────────────

    function grantSession(
        address sessionKey,
        uint256 maxPerTx,
        uint256 maxDaily,
        uint256 maxWeekly,
        uint256 humanApprovalAbove,
        address[] calldata allowedContracts,
        bytes4[] calldata allowedFunctions,
        address[] calldata allowedTokens,
        uint256 expiresAt
    ) external onlyOwner {
        require(sessionKey != address(0), "Invalid session key");
        require(expiresAt > block.timestamp, "Expiry must be in the future");
        require(maxPerTx > 0, "maxPerTx must be > 0");
        require(maxDaily >= maxPerTx, "maxDaily must be >= maxPerTx");
        require(maxWeekly >= maxDaily, "maxWeekly must be >= maxDaily");
        require(allowedContracts.length > 0, "Need at least one allowed contract");

        _policies[sessionKey] = AgentPolicy({
            maxPerTx: maxPerTx,
            maxDaily: maxDaily,
            maxWeekly: maxWeekly,
            humanApprovalAbove: humanApprovalAbove,
            allowedContracts: allowedContracts,
            allowedFunctions: allowedFunctions,
            allowedTokens: allowedTokens,
            expiresAt: expiresAt,
            active: true
        });

        // Initialize spending tracker
        spending[sessionKey] = SpendingTracker({
            dailySpent: 0,
            weeklySpent: 0,
            lastDayReset: block.timestamp,
            lastWeekReset: block.timestamp
        });

        sessionCount++;

        emit SessionGranted(sessionKey, maxPerTx, maxDaily, maxWeekly, expiresAt);
    }

    function revokeSession(address sessionKey) external onlyOwner {
        require(_policies[sessionKey].active, "Session not active");
        _policies[sessionKey].active = false;
        sessionCount--;
        emit SessionRevoked(sessionKey);
    }

    // ──────────────────────────────────────────────
    // Transaction Validation
    // ──────────────────────────────────────────────

    /// @notice Validates a transaction against the session key's policy.
    /// @dev Called by the Safe before executing a transaction. Returns true
    ///      if the transaction is allowed, reverts otherwise.
    function validateTransaction(
        address sessionKey,
        address to,
        uint256 value,
        bytes calldata data
    ) external returns (bool) {
        AgentPolicy storage policy = _policies[sessionKey];

        // Check session is active
        if (!policy.active) {
            emit TransactionRejected(sessionKey, to, value, "Session not active");
            revert("Session not active");
        }

        // Check session hasn't expired
        if (block.timestamp > policy.expiresAt) {
            policy.active = false;
            emit TransactionRejected(sessionKey, to, value, "Session expired");
            revert("Session expired");
        }

        // Check target contract is allowed
        bool contractAllowed = false;
        for (uint256 i = 0; i < policy.allowedContracts.length; i++) {
            if (policy.allowedContracts[i] == to) {
                contractAllowed = true;
                break;
            }
        }
        if (!contractAllowed) {
            emit TransactionRejected(sessionKey, to, value, "Contract not allowed");
            revert("Contract not allowed");
        }

        // Check function selector is allowed (if function allowlist is set)
        if (policy.allowedFunctions.length > 0 && data.length >= 4) {
            bytes4 selector = bytes4(data[:4]);
            bool functionAllowed = false;
            for (uint256 i = 0; i < policy.allowedFunctions.length; i++) {
                if (policy.allowedFunctions[i] == selector) {
                    functionAllowed = true;
                    break;
                }
            }
            if (!functionAllowed) {
                emit TransactionRejected(sessionKey, to, value, "Function not allowed");
                revert("Function not allowed");
            }
        }

        // Check per-transaction limit
        if (value > policy.maxPerTx) {
            emit TransactionRejected(sessionKey, to, value, "Exceeds per-tx limit");
            emit SpendingLimitHit(sessionKey, "per-tx", value, policy.maxPerTx);
            revert("Exceeds per-tx limit");
        }

        // Check requires human approval
        if (policy.humanApprovalAbove > 0 && value > policy.humanApprovalAbove) {
            emit TransactionRejected(sessionKey, to, value, "Requires human approval");
            revert("Requires human approval");
        }

        // Reset daily/weekly counters if windows have rolled over
        SpendingTracker storage tracker = spending[sessionKey];
        if (block.timestamp > tracker.lastDayReset + 1 days) {
            tracker.dailySpent = 0;
            tracker.lastDayReset = block.timestamp;
        }
        if (block.timestamp > tracker.lastWeekReset + 7 days) {
            tracker.weeklySpent = 0;
            tracker.lastWeekReset = block.timestamp;
        }

        // Check daily limit
        if (tracker.dailySpent + value > policy.maxDaily) {
            emit TransactionRejected(sessionKey, to, value, "Exceeds daily limit");
            emit SpendingLimitHit(sessionKey, "daily", tracker.dailySpent + value, policy.maxDaily);
            revert("Exceeds daily limit");
        }

        // Check weekly limit
        if (tracker.weeklySpent + value > policy.maxWeekly) {
            emit TransactionRejected(sessionKey, to, value, "Exceeds weekly limit");
            emit SpendingLimitHit(sessionKey, "weekly", tracker.weeklySpent + value, policy.maxWeekly);
            revert("Exceeds weekly limit");
        }

        // All checks passed — record spending
        tracker.dailySpent += value;
        tracker.weeklySpent += value;

        emit TransactionValidated(sessionKey, to, value);
        return true;
    }

    // ──────────────────────────────────────────────
    // View functions
    // ──────────────────────────────────────────────

    function getSession(address sessionKey) external view returns (
        uint256 maxPerTx,
        uint256 maxDaily,
        uint256 maxWeekly,
        uint256 humanApprovalAbove,
        address[] memory allowedContracts,
        bytes4[] memory allowedFunctions,
        address[] memory allowedTokens,
        uint256 expiresAt,
        bool active
    ) {
        AgentPolicy storage p = _policies[sessionKey];
        return (
            p.maxPerTx,
            p.maxDaily,
            p.maxWeekly,
            p.humanApprovalAbove,
            p.allowedContracts,
            p.allowedFunctions,
            p.allowedTokens,
            p.expiresAt,
            p.active
        );
    }

    function getSpending(address sessionKey) external view returns (
        uint256 dailySpent,
        uint256 weeklySpent,
        uint256 lastDayReset,
        uint256 lastWeekReset
    ) {
        SpendingTracker storage t = spending[sessionKey];
        return (t.dailySpent, t.weeklySpent, t.lastDayReset, t.lastWeekReset);
    }

    function isSessionActive(address sessionKey) external view returns (bool) {
        AgentPolicy storage p = _policies[sessionKey];
        return p.active && block.timestamp <= p.expiresAt;
    }
}
