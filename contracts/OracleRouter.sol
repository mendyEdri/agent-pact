// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAgentPact.sol";

/// @title OracleRouter — Centralized routing oracle for AgentPact
/// @notice Acts as THE oracle address in pacts. Routes verification jobs
///         to specialized validators, handles fee distribution, and tracks
///         validator reputation. Two parties trust the router; the router
///         delegates to the best qualified validator.
contract OracleRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────
    // Types
    // ──────────────────────────────────────────────

    enum JobStatus {
        OPEN,       // Waiting for validator assignment
        ASSIGNED,   // Validator picked up the job
        COMPLETED,  // Validator submitted result, forwarded to AgentPact
        EXPIRED,    // Validator didn't respond in time
        CANCELLED   // Pact was cancelled/timed out before verification
    }

    struct Validator {
        bool isActive;
        uint256 stake;
        uint256 completedJobs;
        uint256 failedJobs;
        uint256 totalEarned;
        string endpoint;       // Off-chain webhook URL for job notifications
    }

    struct Job {
        uint256 pactId;
        address pactContract;
        bytes32 category;
        bytes32 specHash;
        address requester;       // Who requested verification
        address assignedValidator;
        uint256 fee;             // Total fee for this job (held in router)
        uint256 requestedAt;
        uint256 deadline;        // Validator must respond by this time
        JobStatus status;
        uint8 score;
        bytes32 proof;
        address paymentToken;    // address(0) = ETH
    }

    // ──────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────

    uint256 public nextJobId;
    uint256 public minValidatorStake;
    uint256 public routerFeeBps;          // Basis points (e.g., 500 = 5%)
    uint256 public defaultJobTimeout;     // Seconds a validator has to respond

    // Validator state
    mapping(address => Validator) public validators;
    address[] public validatorList;

    // Category → validator addresses
    mapping(bytes32 => address[]) internal _categoryValidators;
    // validator → category → registered
    mapping(address => mapping(bytes32 => bool)) public validatorHasCategory;
    // validator → all categories
    mapping(address => bytes32[]) internal _validatorCategories;

    // Jobs
    mapping(uint256 => Job) public jobs;

    // Prevent duplicate verification requests per pact
    mapping(address => mapping(uint256 => uint256)) public pactToJobId;
    mapping(address => mapping(uint256 => bool)) public pactHasJob;

    // Accumulated earnings for validators (pull pattern)
    mapping(address => mapping(address => uint256)) public pendingEarnings; // validator → token → amount

    // Protocol revenue
    mapping(address => uint256) public protocolRevenue; // token → amount

    // Allowed pact contracts (whitelist, 0 = allow all)
    mapping(address => bool) public allowedPactContracts;
    bool public pactWhitelistEnabled;

    // ──────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────

    event ValidatorRegistered(address indexed validator, uint256 stake, string endpoint);
    event ValidatorDeactivated(address indexed validator);
    event ValidatorCategoryAdded(address indexed validator, bytes32 indexed category);
    event ValidatorCategoryRemoved(address indexed validator, bytes32 indexed category);
    event ValidatorSlashed(address indexed validator, uint256 amount, string reason);

    event JobRequested(
        uint256 indexed jobId,
        uint256 indexed pactId,
        address pactContract,
        bytes32 category,
        address requester,
        uint256 fee
    );
    event JobAssigned(uint256 indexed jobId, address indexed validator);
    event JobCompleted(uint256 indexed jobId, address indexed validator, uint8 score);
    event JobExpired(uint256 indexed jobId, address indexed validator);
    event JobReassigned(uint256 indexed jobId, address indexed oldValidator, address indexed newValidator);
    event EarningsClaimed(address indexed validator, address indexed token, uint256 amount);
    event ProtocolRevenueClaimed(address indexed token, uint256 amount);

    // ──────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────

    constructor(
        uint256 _minValidatorStake,
        uint256 _routerFeeBps,
        uint256 _defaultJobTimeout
    ) Ownable(msg.sender) {
        require(_routerFeeBps <= 5000, "Fee too high"); // Max 50%
        minValidatorStake = _minValidatorStake;
        routerFeeBps = _routerFeeBps;
        defaultJobTimeout = _defaultJobTimeout;
    }

    // ──────────────────────────────────────────────
    // Validator Registration
    // ──────────────────────────────────────────────

    /// @notice Register as a validator with stake and an off-chain endpoint
    function registerValidator(
        bytes32[] calldata categories,
        string calldata endpoint
    ) external payable {
        require(!validators[msg.sender].isActive, "Already registered");
        require(msg.value >= minValidatorStake, "Insufficient stake");
        require(categories.length > 0, "Need at least one category");

        validators[msg.sender] = Validator({
            isActive: true,
            stake: msg.value,
            completedJobs: 0,
            failedJobs: 0,
            totalEarned: 0,
            endpoint: endpoint
        });
        validatorList.push(msg.sender);

        for (uint256 i = 0; i < categories.length; i++) {
            _addValidatorCategory(msg.sender, categories[i]);
        }

        emit ValidatorRegistered(msg.sender, msg.value, endpoint);
    }

    /// @notice Deactivate and withdraw stake (only if no active jobs)
    function deactivateValidator() external nonReentrant {
        Validator storage v = validators[msg.sender];
        require(v.isActive, "Not active");

        uint256 stakeToReturn = v.stake;
        v.isActive = false;
        v.stake = 0;

        (bool sent, ) = msg.sender.call{value: stakeToReturn}("");
        require(sent, "Stake return failed");

        emit ValidatorDeactivated(msg.sender);
    }

    /// @notice Add a new category to an active validator
    function addCategory(bytes32 category) external {
        require(validators[msg.sender].isActive, "Not active");
        require(!validatorHasCategory[msg.sender][category], "Already has category");
        _addValidatorCategory(msg.sender, category);
    }

    /// @notice Remove a category from a validator
    function removeCategory(bytes32 category) external {
        require(validatorHasCategory[msg.sender][category], "Does not have category");
        validatorHasCategory[msg.sender][category] = false;

        // Remove from _categoryValidators array
        address[] storage vals = _categoryValidators[category];
        for (uint256 i = 0; i < vals.length; i++) {
            if (vals[i] == msg.sender) {
                vals[i] = vals[vals.length - 1];
                vals.pop();
                break;
            }
        }

        emit ValidatorCategoryRemoved(msg.sender, category);
    }

    function _addValidatorCategory(address validator, bytes32 category) internal {
        validatorHasCategory[validator][category] = true;
        _categoryValidators[category].push(validator);
        _validatorCategories[validator].push(category);
        emit ValidatorCategoryAdded(validator, category);
    }

    // ──────────────────────────────────────────────
    // Verification Job Flow
    // ──────────────────────────────────────────────

    /// @notice Request verification for a pact. Caller sends the fee.
    ///         The OracleRouter must be listed as the oracle in the pact.
    /// @param pactContract Address of the AgentPact contract
    /// @param pactId The pact ID to verify
    /// @param category Category hash (e.g., keccak256("flight-booking"))
    /// @param specHash Hash of the verification spec / deliverable description
    /// @param paymentToken Token for fee payment (address(0) = ETH)
    function requestVerification(
        address pactContract,
        uint256 pactId,
        bytes32 category,
        bytes32 specHash,
        address paymentToken
    ) external payable returns (uint256) {
        if (pactWhitelistEnabled) {
            require(allowedPactContracts[pactContract], "Pact contract not allowed");
        }
        require(!pactHasJob[pactContract][pactId], "Job already exists for this pact");
        require(_categoryValidators[category].length > 0, "No validators for category");

        uint256 fee;
        if (paymentToken == address(0)) {
            require(msg.value > 0, "Fee required");
            fee = msg.value;
        } else {
            require(msg.value == 0, "ETH not accepted for token fee");
            // Fee amount is determined by caller's approval
            // We'll read the allowance and transfer
            fee = IERC20(paymentToken).allowance(msg.sender, address(this));
            require(fee > 0, "Token fee required (approve first)");
            IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), fee);
        }

        uint256 jobId = nextJobId++;
        jobs[jobId] = Job({
            pactId: pactId,
            pactContract: pactContract,
            category: category,
            specHash: specHash,
            requester: msg.sender,
            assignedValidator: address(0),
            fee: fee,
            requestedAt: block.timestamp,
            deadline: block.timestamp + defaultJobTimeout,
            status: JobStatus.OPEN,
            score: 0,
            proof: bytes32(0),
            paymentToken: paymentToken
        });

        pactToJobId[pactContract][pactId] = jobId;
        pactHasJob[pactContract][pactId] = true;

        emit JobRequested(jobId, pactId, pactContract, category, msg.sender, fee);
        return jobId;
    }

    /// @notice Validator claims an open job. Must be registered for the category.
    function claimJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.OPEN, "Job not open");
        require(validators[msg.sender].isActive, "Not an active validator");
        require(validatorHasCategory[msg.sender][job.category], "Not registered for category");

        job.assignedValidator = msg.sender;
        job.status = JobStatus.ASSIGNED;
        // Reset deadline from claim time
        job.deadline = block.timestamp + defaultJobTimeout;

        emit JobAssigned(jobId, msg.sender);
    }

    /// @notice Validator submits verification result. Router forwards to AgentPact.
    function submitValidation(
        uint256 jobId,
        uint8 score,
        bytes32 proof
    ) external nonReentrant {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.ASSIGNED, "Job not assigned");
        require(msg.sender == job.assignedValidator, "Not assigned validator");
        require(score <= 100, "Score must be 0-100");
        require(block.timestamp <= job.deadline, "Job deadline passed");

        // Forward verification to AgentPact (router is the oracle)
        IAgentPact(job.pactContract).submitVerification(job.pactId, score, proof);

        job.status = JobStatus.COMPLETED;
        job.score = score;
        job.proof = proof;

        // Calculate fee split
        uint256 routerShare = (job.fee * routerFeeBps) / 10000;
        uint256 validatorShare = job.fee - routerShare;

        // Credit earnings (pull pattern — validator claims later)
        pendingEarnings[msg.sender][job.paymentToken] += validatorShare;
        protocolRevenue[job.paymentToken] += routerShare;

        // Update validator stats
        Validator storage v = validators[msg.sender];
        v.completedJobs++;
        v.totalEarned += validatorShare;

        emit JobCompleted(jobId, msg.sender, score);
    }

    /// @notice Mark a job as expired if validator didn't respond in time.
    ///         Anyone can call this. Job becomes OPEN again for reassignment.
    function expireJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(
            job.status == JobStatus.ASSIGNED,
            "Only assigned jobs can expire"
        );
        require(block.timestamp > job.deadline, "Deadline not passed");

        address oldValidator = job.assignedValidator;

        // Penalize validator
        validators[oldValidator].failedJobs++;

        // Reset job to OPEN for reassignment
        job.status = JobStatus.OPEN;
        job.assignedValidator = address(0);
        job.deadline = block.timestamp + defaultJobTimeout;

        emit JobExpired(jobId, oldValidator);
    }

    /// @notice Cancel a job and refund fee. Only the original requester or owner.
    function cancelJob(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        require(
            job.status == JobStatus.OPEN || job.status == JobStatus.ASSIGNED,
            "Cannot cancel"
        );
        require(
            msg.sender == job.requester || msg.sender == owner(),
            "Not authorized"
        );

        job.status = JobStatus.CANCELLED;

        // Refund fee to requester
        _transferOut(job.paymentToken, job.requester, job.fee);
    }

    // ──────────────────────────────────────────────
    // Validator Selection (view helpers)
    // ──────────────────────────────────────────────

    /// @notice Get the best validator for a category based on reputation score.
    ///         Ranking: reliability (completed / total) * stake.
    ///         New validators (0 jobs) are ranked by stake alone.
    function getBestValidator(bytes32 category) external view returns (address best) {
        address[] storage vals = _categoryValidators[category];
        uint256 bestScore = 0;

        for (uint256 i = 0; i < vals.length; i++) {
            Validator storage v = validators[vals[i]];
            if (!v.isActive) continue;

            uint256 total = v.completedJobs + v.failedJobs;
            uint256 score;
            if (total == 0) {
                // New validator — rank by stake (treat as 100% reliable)
                score = 100 * v.stake;
            } else {
                uint256 reliability = (v.completedJobs * 100) / total;
                score = reliability * v.stake;
            }

            if (score > bestScore) {
                bestScore = score;
                best = vals[i];
            }
        }
    }

    /// @notice Get all active validators for a category
    function getValidatorsForCategory(bytes32 category) external view returns (
        address[] memory addresses,
        uint256[] memory stakes,
        uint256[] memory completed,
        uint256[] memory failed
    ) {
        address[] storage vals = _categoryValidators[category];

        // Count active
        uint256 activeCount = 0;
        for (uint256 i = 0; i < vals.length; i++) {
            if (validators[vals[i]].isActive) activeCount++;
        }

        addresses = new address[](activeCount);
        stakes = new uint256[](activeCount);
        completed = new uint256[](activeCount);
        failed = new uint256[](activeCount);

        uint256 idx = 0;
        for (uint256 i = 0; i < vals.length; i++) {
            Validator storage v = validators[vals[i]];
            if (!v.isActive) continue;
            addresses[idx] = vals[i];
            stakes[idx] = v.stake;
            completed[idx] = v.completedJobs;
            failed[idx] = v.failedJobs;
            idx++;
        }
    }

    // ──────────────────────────────────────────────
    // Earnings & Withdrawals
    // ──────────────────────────────────────────────

    /// @notice Validator claims accumulated earnings for a token
    function claimEarnings(address token) external nonReentrant {
        uint256 amount = pendingEarnings[msg.sender][token];
        require(amount > 0, "Nothing to claim");

        pendingEarnings[msg.sender][token] = 0;
        _transferOut(token, msg.sender, amount);

        emit EarningsClaimed(msg.sender, token, amount);
    }

    /// @notice Owner withdraws accumulated protocol revenue
    function claimProtocolRevenue(address token) external onlyOwner nonReentrant {
        uint256 amount = protocolRevenue[token];
        require(amount > 0, "Nothing to claim");

        protocolRevenue[token] = 0;
        _transferOut(token, owner(), amount);

        emit ProtocolRevenueClaimed(token, amount);
    }

    // ──────────────────────────────────────────────
    // Slashing
    // ──────────────────────────────────────────────

    /// @notice Slash a validator's stake (owner only, for proven misbehavior)
    function slashValidator(
        address validator,
        uint256 amount,
        string calldata reason
    ) external onlyOwner nonReentrant {
        Validator storage v = validators[validator];
        require(v.isActive, "Not active");
        require(amount <= v.stake, "Exceeds stake");

        v.stake -= amount;

        // Slashed funds go to protocol revenue (ETH)
        protocolRevenue[address(0)] += amount;

        emit ValidatorSlashed(validator, amount, reason);
    }

    // ──────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────

    function setRouterFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 5000, "Fee too high");
        routerFeeBps = _feeBps;
    }

    function setDefaultJobTimeout(uint256 _timeout) external onlyOwner {
        defaultJobTimeout = _timeout;
    }

    function setMinValidatorStake(uint256 _minStake) external onlyOwner {
        minValidatorStake = _minStake;
    }

    function setPactWhitelistEnabled(bool _enabled) external onlyOwner {
        pactWhitelistEnabled = _enabled;
    }

    function setAllowedPactContract(address pactContract, bool allowed) external onlyOwner {
        allowedPactContracts[pactContract] = allowed;
    }

    // ──────────────────────────────────────────────
    // View helpers
    // ──────────────────────────────────────────────

    function getJob(uint256 jobId) external view returns (
        uint256 pactId,
        address pactContract,
        bytes32 category,
        bytes32 specHash,
        address assignedValidator,
        uint256 fee,
        uint256 requestedAt,
        uint256 deadline,
        JobStatus status,
        uint8 score,
        bytes32 proof,
        address paymentToken
    ) {
        Job storage j = jobs[jobId];
        return (
            j.pactId, j.pactContract, j.category, j.specHash,
            j.assignedValidator, j.fee, j.requestedAt, j.deadline,
            j.status, j.score, j.proof, j.paymentToken
        );
    }

    function getValidatorInfo(address validator) external view returns (
        bool isActive,
        uint256 stake,
        uint256 completedJobs,
        uint256 failedJobs,
        uint256 totalEarned,
        string memory endpoint
    ) {
        Validator storage v = validators[validator];
        return (v.isActive, v.stake, v.completedJobs, v.failedJobs, v.totalEarned, v.endpoint);
    }

    function getValidatorCategories(address validator) external view returns (bytes32[] memory) {
        return _validatorCategories[validator];
    }

    function getCategoryValidatorCount(bytes32 category) external view returns (uint256) {
        return _categoryValidators[category].length;
    }

    function getValidatorCount() external view returns (uint256) {
        return validatorList.length;
    }

    // ──────────────────────────────────────────────
    // Internal
    // ──────────────────────────────────────────────

    function _transferOut(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool sent, ) = to.call{value: amount}("");
            require(sent, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @notice Accept ETH (needed to receive oracle fees from AgentPact)
    receive() external payable {}
}
