// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract AgentPact is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum Initiator {
        BUYER,
        SELLER
    }

    enum Status {
        NEGOTIATING,
        FUNDED,
        IN_PROGRESS,
        PENDING_VERIFY,
        COMPLETED,
        DISPUTED,
        REFUNDED,
        PENDING_APPROVAL
    }

    struct Verification {
        uint8 score;
        bool hasSubmitted;
        bytes32 proof;
    }

    struct Amendment {
        uint256 payment;
        uint256 deadline;
        bytes32 specHash;
        address proposedBy;
        bool pending;
    }

    struct Pact {
        address buyer;
        address seller;
        uint256 payment;
        uint256 deadline;
        Status status;
        bytes32 specHash;
        bytes32 verificationHash;
        address[] oracles;
        uint8[] oracleWeights;
        uint8 verificationThreshold;
        address arbitrator;
        uint256 disputeFee;
        uint256 buyerStake;
        uint256 sellerStake;
        uint256 createdAt;
        Initiator initiator;
        uint256 reviewPeriod;
        uint256 verifiedAt;
        uint256 oracleFee;
        bool oracleFeesPaid;
        address paymentToken; // address(0) = native ETH
    }

    uint256 public nextPactId;
    uint256 public constant STAKE_PERCENT = 10;
    uint256 public constant DEFAULT_REVIEW_PERIOD = 3 days;

    mapping(uint256 => Pact) public pacts;
    mapping(uint256 => mapping(address => Verification)) public verifications;
    mapping(uint256 => Amendment) public amendments;

    struct Reputation {
        uint256 completedAsBuyer;
        uint256 completedAsSeller;
        uint256 disputesLost;
        uint256 totalVolumeWei;
    }

    mapping(address => Reputation) public reputation;

    // ── Discovery indexes ──
    uint256[] internal _openPactIds;                      // Pacts in NEGOTIATING status
    mapping(uint256 => uint256) internal _openPactIndex;  // pactId → index in _openPactIds (1-based, 0 = not present)
    mapping(address => uint256[]) internal _userPactIds;  // All pacts where address is buyer or seller

    event PactCreated(
        uint256 indexed pactId,
        address indexed creator,
        Initiator initiator,
        bytes32 specHash,
        uint256 payment,
        uint256 deadline
    );
    event PactAccepted(uint256 indexed pactId, address indexed accepter, Initiator role);
    event WorkStarted(uint256 indexed pactId);
    event WorkSubmitted(uint256 indexed pactId, bytes32 proofHash);
    event VerificationSubmitted(
        uint256 indexed pactId,
        address indexed oracle,
        uint8 score
    );
    event VerificationFinalized(uint256 indexed pactId, uint256 weightedScore, Status newStatus);
    event PactCompleted(uint256 indexed pactId);
    event WorkApproved(uint256 indexed pactId, address indexed approvedBy);
    event WorkRejected(uint256 indexed pactId, address indexed rejectedBy);
    event AutoApproved(uint256 indexed pactId, address indexed triggeredBy);
    event DisputeRaised(uint256 indexed pactId, address indexed raisedBy);
    event DisputeResolved(uint256 indexed pactId, bool sellerWins);
    event PactRefunded(uint256 indexed pactId);
    event TimeoutClaimed(uint256 indexed pactId, address indexed claimedBy);
    event AmendmentProposed(
        uint256 indexed pactId,
        address indexed proposedBy,
        uint256 payment,
        uint256 deadline,
        bytes32 specHash
    );
    event AmendmentAccepted(uint256 indexed pactId, address indexed acceptedBy);
    event ReputationUpdated(
        address indexed user,
        uint256 completedAsBuyer,
        uint256 completedAsSeller,
        uint256 disputesLost,
        uint256 totalVolumeWei
    );
    event OracleFeePaid(uint256 indexed pactId, address indexed oracle, uint256 amount);

    modifier onlyBuyer(uint256 pactId) {
        require(msg.sender == pacts[pactId].buyer, "Not buyer");
        _;
    }

    modifier onlySeller(uint256 pactId) {
        require(msg.sender == pacts[pactId].seller, "Not seller");
        _;
    }

    modifier inStatus(uint256 pactId, Status expected) {
        require(pacts[pactId].status == expected, "Invalid status");
        _;
    }

    // ──────────────────────────────────────────────
    // Pact Creation (bidirectional)
    // ──────────────────────────────────────────────

    function createPact(
        Initiator _initiator,
        bytes32 specHash,
        uint256 deadline,
        address[] calldata oracles,
        uint8[] calldata oracleWeights,
        uint8 verificationThreshold,
        uint256 paymentAmount,
        uint256 reviewPeriod,
        uint256 oracleFee,
        address paymentToken
    ) external payable returns (uint256) {
        require(oracles.length > 0, "Need at least one oracle");
        require(oracles.length == oracleWeights.length, "Oracles/weights mismatch");
        require(verificationThreshold <= 100, "Threshold must be <= 100");
        require(deadline > block.timestamp, "Deadline must be in the future");
        require(paymentAmount > 0, "Payment must be > 0");

        uint256 totalWeight = 0;
        for (uint256 i = 0; i < oracleWeights.length; i++) {
            totalWeight += oracleWeights[i];
        }
        require(totalWeight == 100, "Weights must sum to 100");

        uint256 pactId = nextPactId++;
        Pact storage pact = pacts[pactId];

        pact.payment = paymentAmount;
        pact.deadline = deadline;
        pact.status = Status.NEGOTIATING;
        pact.specHash = specHash;
        pact.oracles = oracles;
        pact.oracleWeights = oracleWeights;
        pact.verificationThreshold = verificationThreshold;
        pact.createdAt = block.timestamp;
        pact.initiator = _initiator;
        pact.reviewPeriod = reviewPeriod > 0 ? reviewPeriod : DEFAULT_REVIEW_PERIOD;
        pact.oracleFee = oracleFee;
        pact.paymentToken = paymentToken;

        if (_initiator == Initiator.BUYER) {
            // Buyer creates: deposits payment + oracleFee + 10% buyer stake
            uint256 requiredDeposit = paymentAmount + oracleFee + paymentAmount / STAKE_PERCENT;
            if (paymentToken == address(0)) {
                require(msg.value >= requiredDeposit, "Insufficient buyer deposit");
                pact.buyer = msg.sender;
                pact.buyerStake = msg.value - paymentAmount - oracleFee;
            } else {
                require(msg.value == 0, "ETH not accepted for token pact");
                IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), requiredDeposit);
                pact.buyer = msg.sender;
                pact.buyerStake = requiredDeposit - paymentAmount - oracleFee;
            }
        } else {
            // Seller creates: deposits 10% seller stake only (buyer pays oracle fee on accept)
            uint256 requiredStake = paymentAmount / STAKE_PERCENT;
            if (paymentToken == address(0)) {
                require(msg.value >= requiredStake, "Insufficient seller stake");
                pact.seller = msg.sender;
                pact.sellerStake = msg.value;
            } else {
                require(msg.value == 0, "ETH not accepted for token pact");
                IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), requiredStake);
                pact.seller = msg.sender;
                pact.sellerStake = requiredStake;
            }
        }

        // Index: add to open pacts and creator's pact list
        _openPactIds.push(pactId);
        _openPactIndex[pactId] = _openPactIds.length; // 1-based
        _userPactIds[msg.sender].push(pactId);

        emit PactCreated(pactId, msg.sender, _initiator, specHash, paymentAmount, deadline);
        return pactId;
    }

    // ──────────────────────────────────────────────
    // Accept Pact (bidirectional)
    // ──────────────────────────────────────────────

    function acceptPact(uint256 pactId)
        external
        payable
        inStatus(pactId, Status.NEGOTIATING)
    {
        Pact storage pact = pacts[pactId];
        require(block.timestamp < pact.deadline, "Pact expired");

        if (pact.initiator == Initiator.BUYER) {
            // Buyer created → accepter becomes seller
            require(msg.sender != pact.buyer, "Creator cannot accept own pact");
            uint256 requiredStake = pact.payment / STAKE_PERCENT;
            if (pact.paymentToken == address(0)) {
                require(msg.value >= requiredStake, "Insufficient seller stake");
                pact.seller = msg.sender;
                pact.sellerStake = msg.value;
            } else {
                require(msg.value == 0, "ETH not accepted for token pact");
                IERC20(pact.paymentToken).safeTransferFrom(msg.sender, address(this), requiredStake);
                pact.seller = msg.sender;
                pact.sellerStake = requiredStake;
            }
        } else {
            // Seller created → accepter becomes buyer (pays payment + oracleFee + buyerStake)
            require(msg.sender != pact.seller, "Creator cannot accept own pact");
            uint256 requiredDeposit = pact.payment + pact.oracleFee + pact.payment / STAKE_PERCENT;
            if (pact.paymentToken == address(0)) {
                require(msg.value >= requiredDeposit, "Insufficient buyer deposit");
                pact.buyer = msg.sender;
                pact.buyerStake = msg.value - pact.payment - pact.oracleFee;
            } else {
                require(msg.value == 0, "ETH not accepted for token pact");
                IERC20(pact.paymentToken).safeTransferFrom(msg.sender, address(this), requiredDeposit);
                pact.buyer = msg.sender;
                pact.buyerStake = requiredDeposit - pact.payment - pact.oracleFee;
            }
        }

        pact.status = Status.FUNDED;

        // Index: remove from open pacts, add accepter to user list
        _removeOpenPact(pactId);
        _userPactIds[msg.sender].push(pactId);

        emit PactAccepted(pactId, msg.sender, pact.initiator);
    }

    // ──────────────────────────────────────────────
    // Negotiation (Amendments)
    // ──────────────────────────────────────────────

    function proposeAmendment(
        uint256 pactId,
        uint256 newPayment,
        uint256 newDeadline,
        bytes32 newSpecHash
    ) external inStatus(pactId, Status.NEGOTIATING) {
        Pact storage pact = pacts[pactId];
        require(
            msg.sender == pact.buyer || msg.sender == pact.seller,
            "Not a party to this pact"
        );

        // Use current values if zero is passed (meaning "keep current")
        uint256 payment = newPayment > 0 ? newPayment : pact.payment;
        uint256 dl = newDeadline > 0 ? newDeadline : pact.deadline;
        bytes32 spec = newSpecHash != bytes32(0) ? newSpecHash : pact.specHash;

        amendments[pactId] = Amendment({
            payment: payment,
            deadline: dl,
            specHash: spec,
            proposedBy: msg.sender,
            pending: true
        });

        emit AmendmentProposed(pactId, msg.sender, payment, dl, spec);
    }

    function acceptAmendment(uint256 pactId)
        external
        payable
        inStatus(pactId, Status.NEGOTIATING)
    {
        Amendment storage amendment = amendments[pactId];
        require(amendment.pending, "No pending amendment");
        require(msg.sender != amendment.proposedBy, "Cannot accept own amendment");

        Pact storage pact = pacts[pactId];
        require(
            msg.sender == pact.buyer || msg.sender == pact.seller,
            "Not a party to this pact"
        );

        uint256 oldPayment = pact.payment;

        // Update pact terms
        pact.payment = amendment.payment;
        pact.deadline = amendment.deadline;
        pact.specHash = amendment.specHash;

        // Handle deposit adjustments for the creator who already has funds in
        if (pact.initiator == Initiator.BUYER && pact.buyer != address(0)) {
            // Buyer created and has funds deposited. Adjust buyer's deposit.
            if (amendment.payment > oldPayment) {
                uint256 extraPayment = amendment.payment - oldPayment;
                uint256 extraStake = extraPayment / STAKE_PERCENT;
                uint256 extraRequired = extraPayment + extraStake;
                if (pact.paymentToken == address(0)) {
                    require(msg.value >= extraRequired, "Insufficient additional deposit");
                    pact.buyerStake += msg.value - extraPayment;
                } else {
                    IERC20(pact.paymentToken).safeTransferFrom(msg.sender, address(this), extraRequired);
                    pact.buyerStake += extraStake;
                }
            } else if (amendment.payment < oldPayment) {
                uint256 reducedPayment = oldPayment - amendment.payment;
                uint256 reducedStake = reducedPayment / STAKE_PERCENT;
                uint256 refund = reducedPayment + reducedStake;
                pact.buyerStake -= reducedStake;
                _transferOut(pact.paymentToken, pact.buyer, refund);
            }
        } else if (pact.initiator == Initiator.SELLER && pact.seller != address(0)) {
            // Seller created and has stake deposited. Adjust seller's stake.
            if (amendment.payment > oldPayment) {
                uint256 extraStake = (amendment.payment - oldPayment) / STAKE_PERCENT;
                if (pact.paymentToken == address(0)) {
                    require(msg.value >= extraStake, "Insufficient additional stake");
                    pact.sellerStake += msg.value;
                } else {
                    IERC20(pact.paymentToken).safeTransferFrom(msg.sender, address(this), extraStake);
                    pact.sellerStake += extraStake;
                }
            } else if (amendment.payment < oldPayment) {
                uint256 reducedStake = (oldPayment - amendment.payment) / STAKE_PERCENT;
                pact.sellerStake -= reducedStake;
                _transferOut(pact.paymentToken, pact.seller, reducedStake);
            }
        }

        // Clear amendment
        amendment.pending = false;

        emit AmendmentAccepted(pactId, msg.sender);
    }

    function getAmendment(uint256 pactId) external view returns (
        uint256 payment,
        uint256 deadline_,
        bytes32 specHash,
        address proposedBy,
        bool pending
    ) {
        Amendment storage a = amendments[pactId];
        return (a.payment, a.deadline, a.specHash, a.proposedBy, a.pending);
    }

    // ──────────────────────────────────────────────
    // Work lifecycle
    // ──────────────────────────────────────────────

    function startWork(uint256 pactId)
        external
        onlySeller(pactId)
        inStatus(pactId, Status.FUNDED)
    {
        pacts[pactId].status = Status.IN_PROGRESS;
        emit WorkStarted(pactId);
    }

    function submitWork(uint256 pactId, bytes32 proofHash)
        external
        onlySeller(pactId)
        inStatus(pactId, Status.IN_PROGRESS)
    {
        require(block.timestamp < pacts[pactId].deadline, "Deadline passed");

        pacts[pactId].verificationHash = proofHash;
        pacts[pactId].status = Status.PENDING_VERIFY;

        emit WorkSubmitted(pactId, proofHash);
    }

    // ──────────────────────────────────────────────
    // Oracle verification
    // ──────────────────────────────────────────────

    function submitVerification(uint256 pactId, uint8 score, bytes32 proof)
        external
        inStatus(pactId, Status.PENDING_VERIFY)
    {
        Pact storage pact = pacts[pactId];

        bool isOracle = false;
        for (uint256 i = 0; i < pact.oracles.length; i++) {
            if (pact.oracles[i] == msg.sender) {
                isOracle = true;
                break;
            }
        }
        require(isOracle, "Not an oracle for this pact");
        require(!verifications[pactId][msg.sender].hasSubmitted, "Already submitted");
        require(score <= 100, "Score must be 0-100");

        verifications[pactId][msg.sender] = Verification({
            score: score,
            hasSubmitted: true,
            proof: proof
        });

        emit VerificationSubmitted(pactId, msg.sender, score);
    }

    function finalizeVerification(uint256 pactId)
        external
        nonReentrant
        inStatus(pactId, Status.PENDING_VERIFY)
    {
        Pact storage pact = pacts[pactId];

        // Check all oracles have submitted
        for (uint256 i = 0; i < pact.oracles.length; i++) {
            require(
                verifications[pactId][pact.oracles[i]].hasSubmitted,
                "Not all oracles have submitted"
            );
        }

        // Calculate weighted score
        uint256 weightedScore = 0;
        for (uint256 i = 0; i < pact.oracles.length; i++) {
            address oracle = pact.oracles[i];
            uint256 score = verifications[pactId][oracle].score;
            uint256 weight = pact.oracleWeights[i];
            weightedScore += score * weight;
        }
        weightedScore = weightedScore / 100; // Normalize since weights sum to 100

        // Pay oracle fees (oracles did their job regardless of pass/fail)
        _payOracleFees(pactId);

        if (weightedScore >= pact.verificationThreshold) {
            // Score passes → move to PENDING_APPROVAL for buyer review
            pact.status = Status.PENDING_APPROVAL;
            pact.verifiedAt = block.timestamp;
            emit VerificationFinalized(pactId, weightedScore, Status.PENDING_APPROVAL);
        } else {
            pact.status = Status.DISPUTED;
            emit VerificationFinalized(pactId, weightedScore, Status.DISPUTED);
            emit DisputeRaised(pactId, address(this));
        }
    }

    // ──────────────────────────────────────────────
    // Buyer Approval (post-verification)
    // ──────────────────────────────────────────────

    function approveWork(uint256 pactId)
        external
        nonReentrant
        onlyBuyer(pactId)
        inStatus(pactId, Status.PENDING_APPROVAL)
    {
        _releaseFunds(pactId);
        emit WorkApproved(pactId, msg.sender);
        emit PactCompleted(pactId);
    }

    function rejectWork(uint256 pactId)
        external
        onlyBuyer(pactId)
        inStatus(pactId, Status.PENDING_APPROVAL)
    {
        pacts[pactId].status = Status.DISPUTED;
        emit WorkRejected(pactId, msg.sender);
        emit DisputeRaised(pactId, msg.sender);
    }

    function autoApprove(uint256 pactId)
        external
        nonReentrant
        inStatus(pactId, Status.PENDING_APPROVAL)
    {
        Pact storage pact = pacts[pactId];
        require(
            block.timestamp > pact.verifiedAt + pact.reviewPeriod,
            "Review period not expired"
        );

        _releaseFunds(pactId);
        emit AutoApproved(pactId, msg.sender);
        emit PactCompleted(pactId);
    }

    function _updateReputation(
        address user,
        bool completedBuyer,
        bool completedSeller,
        uint256 volume
    ) internal {
        Reputation storage r = reputation[user];
        if (completedBuyer) r.completedAsBuyer++;
        if (completedSeller) r.completedAsSeller++;
        r.totalVolumeWei += volume;
        emit ReputationUpdated(user, r.completedAsBuyer, r.completedAsSeller, r.disputesLost, r.totalVolumeWei);
    }

    function _penalizeReputation(address user) internal {
        Reputation storage r = reputation[user];
        r.disputesLost++;
        emit ReputationUpdated(user, r.completedAsBuyer, r.completedAsSeller, r.disputesLost, r.totalVolumeWei);
    }

    function _transferOut(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool sent, ) = to.call{value: amount}("");
            require(sent, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _payOracleFees(uint256 pactId) internal {
        Pact storage pact = pacts[pactId];
        if (pact.oracleFee == 0 || pact.oracleFeesPaid) return;
        pact.oracleFeesPaid = true;

        uint256 remaining = pact.oracleFee;
        for (uint256 i = 0; i < pact.oracles.length; i++) {
            uint256 share;
            if (i == pact.oracles.length - 1) {
                share = remaining;
            } else {
                share = (pact.oracleFee * pact.oracleWeights[i]) / 100;
                remaining -= share;
            }
            if (share > 0) {
                _transferOut(pact.paymentToken, pact.oracles[i], share);
                emit OracleFeePaid(pactId, pact.oracles[i], share);
            }
        }
    }

    function _releaseFunds(uint256 pactId) internal {
        Pact storage pact = pacts[pactId];
        pact.status = Status.COMPLETED;

        // Update reputation for both parties
        _updateReputation(pact.buyer, true, false, pact.payment);
        _updateReputation(pact.seller, false, true, pact.payment);

        // Seller gets payment + seller stake
        uint256 sellerPayout = pact.payment + pact.sellerStake;
        // Buyer gets buyer stake back
        uint256 buyerReturn = pact.buyerStake;

        _transferOut(pact.paymentToken, pact.seller, sellerPayout);
        _transferOut(pact.paymentToken, pact.buyer, buyerReturn);
    }

    // ──────────────────────────────────────────────
    // Disputes
    // ──────────────────────────────────────────────

    function raiseDispute(uint256 pactId, address arbitrator) external {
        Pact storage pact = pacts[pactId];
        require(
            pact.status == Status.IN_PROGRESS ||
            pact.status == Status.PENDING_VERIFY ||
            pact.status == Status.PENDING_APPROVAL,
            "Cannot dispute in current status"
        );
        require(
            msg.sender == pact.buyer || msg.sender == pact.seller,
            "Not a party to this pact"
        );
        require(arbitrator != address(0), "Invalid arbitrator");

        pact.status = Status.DISPUTED;
        pact.arbitrator = arbitrator;

        emit DisputeRaised(pactId, msg.sender);
    }

    function resolveDispute(uint256 pactId, bool sellerWins)
        external
        nonReentrant
        inStatus(pactId, Status.DISPUTED)
    {
        Pact storage pact = pacts[pactId];
        require(msg.sender == pact.arbitrator, "Not arbitrator");

        uint256 unpaidFee = pact.oracleFeesPaid ? 0 : pact.oracleFee;

        if (sellerWins) {
            pact.status = Status.COMPLETED;

            // Seller vindicated: gets completion credit; buyer penalized
            _updateReputation(pact.seller, false, true, pact.payment);
            _penalizeReputation(pact.buyer);

            uint256 sellerPayout = pact.payment + unpaidFee + pact.sellerStake + pact.buyerStake;
            _transferOut(pact.paymentToken, pact.seller, sellerPayout);
        } else {
            pact.status = Status.REFUNDED;

            // Seller at fault: penalized
            _penalizeReputation(pact.seller);

            uint256 buyerRefund = pact.payment + unpaidFee + pact.buyerStake + pact.sellerStake;
            _transferOut(pact.paymentToken, pact.buyer, buyerRefund);
        }

        emit DisputeResolved(pactId, sellerWins);
    }

    // ──────────────────────────────────────────────
    // Timeout
    // ──────────────────────────────────────────────

    function claimTimeout(uint256 pactId) external nonReentrant {
        Pact storage pact = pacts[pactId];
        require(block.timestamp > pact.deadline, "Deadline not passed");

        if (pact.status == Status.NEGOTIATING) {
            // No one accepted — refund creator
            pact.status = Status.REFUNDED;
            _removeOpenPact(pactId);

            if (pact.initiator == Initiator.BUYER) {
                uint256 refund = pact.payment + pact.oracleFee + pact.buyerStake;
                _transferOut(pact.paymentToken, pact.buyer, refund);
            } else {
                uint256 refund = pact.sellerStake;
                _transferOut(pact.paymentToken, pact.seller, refund);
            }

            emit TimeoutClaimed(pactId, msg.sender);
            emit PactRefunded(pactId);
        } else if (
            pact.status == Status.FUNDED ||
            pact.status == Status.IN_PROGRESS ||
            pact.status == Status.PENDING_VERIFY
        ) {
            // Seller didn't deliver or verification stalled — refund buyer, forfeit seller stake
            pact.status = Status.REFUNDED;

            // Seller at fault for timeout
            _penalizeReputation(pact.seller);

            uint256 unpaidFee = pact.oracleFeesPaid ? 0 : pact.oracleFee;
            uint256 buyerRefund = pact.payment + unpaidFee + pact.buyerStake + pact.sellerStake;
            _transferOut(pact.paymentToken, pact.buyer, buyerRefund);

            emit TimeoutClaimed(pactId, msg.sender);
            emit PactRefunded(pactId);
        } else {
            revert("Cannot claim timeout in current status");
        }
    }

    // ──────────────────────────────────────────────
    // View functions
    // ──────────────────────────────────────────────

    function getPact(uint256 pactId) external view returns (
        address buyer,
        address seller,
        uint256 payment,
        uint256 deadline_,
        Status status,
        bytes32 specHash,
        uint8 verificationThreshold,
        uint256 buyerStake,
        uint256 sellerStake,
        Initiator initiator,
        uint256 reviewPeriod,
        uint256 verifiedAt,
        uint256 oracleFee,
        bool oracleFeesPaid,
        address paymentToken
    ) {
        Pact storage pact = pacts[pactId];
        return (
            pact.buyer,
            pact.seller,
            pact.payment,
            pact.deadline,
            pact.status,
            pact.specHash,
            pact.verificationThreshold,
            pact.buyerStake,
            pact.sellerStake,
            pact.initiator,
            pact.reviewPeriod,
            pact.verifiedAt,
            pact.oracleFee,
            pact.oracleFeesPaid,
            pact.paymentToken
        );
    }

    function getPactOracles(uint256 pactId) external view returns (
        address[] memory,
        uint8[] memory
    ) {
        return (pacts[pactId].oracles, pacts[pactId].oracleWeights);
    }

    function getVerification(uint256 pactId, address oracle) external view returns (
        uint8 score,
        bool hasSubmitted,
        bytes32 proof
    ) {
        Verification storage v = verifications[pactId][oracle];
        return (v.score, v.hasSubmitted, v.proof);
    }

    function getReputation(address user) external view returns (
        uint256 completedAsBuyer,
        uint256 completedAsSeller,
        uint256 disputesLost,
        uint256 totalVolumeWei
    ) {
        Reputation storage r = reputation[user];
        return (r.completedAsBuyer, r.completedAsSeller, r.disputesLost, r.totalVolumeWei);
    }

    // ──────────────────────────────────────────────
    // Discovery
    // ──────────────────────────────────────────────

    function _removeOpenPact(uint256 pactId) internal {
        uint256 idx = _openPactIndex[pactId];
        if (idx == 0) return; // not in list
        uint256 arrayIdx = idx - 1;
        uint256 lastIdx = _openPactIds.length - 1;
        if (arrayIdx != lastIdx) {
            uint256 lastPactId = _openPactIds[lastIdx];
            _openPactIds[arrayIdx] = lastPactId;
            _openPactIndex[lastPactId] = idx;
        }
        _openPactIds.pop();
        _openPactIndex[pactId] = 0;
    }

    function getOpenPacts(uint256 offset, uint256 limit) external view returns (uint256[] memory pactIds) {
        uint256 total = _openPactIds.length;
        if (offset >= total) return new uint256[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        pactIds = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            pactIds[i - offset] = _openPactIds[i];
        }
    }

    function getOpenPactCount() external view returns (uint256) {
        return _openPactIds.length;
    }

    function getPactsByAddress(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory pactIds) {
        uint256 total = _userPactIds[user].length;
        if (offset >= total) return new uint256[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        pactIds = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            pactIds[i - offset] = _userPactIds[user][i];
        }
    }

    function getUserPactCount(address user) external view returns (uint256) {
        return _userPactIds[user].length;
    }
}
