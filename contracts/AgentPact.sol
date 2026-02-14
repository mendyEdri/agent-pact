// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract AgentPact is ReentrancyGuard {
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
        uint256 reviewPeriod
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

        if (_initiator == Initiator.BUYER) {
            // Buyer creates: deposits payment + 10% buyer stake
            uint256 requiredDeposit = paymentAmount + paymentAmount / STAKE_PERCENT;
            require(msg.value >= requiredDeposit, "Insufficient buyer deposit");
            pact.buyer = msg.sender;
            pact.buyerStake = msg.value - paymentAmount;
        } else {
            // Seller creates: deposits 10% seller stake only
            uint256 requiredStake = paymentAmount / STAKE_PERCENT;
            require(msg.value >= requiredStake, "Insufficient seller stake");
            pact.seller = msg.sender;
            pact.sellerStake = msg.value;
        }

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
            require(msg.value >= requiredStake, "Insufficient seller stake");
            pact.seller = msg.sender;
            pact.sellerStake = msg.value;
        } else {
            // Seller created → accepter becomes buyer
            require(msg.sender != pact.seller, "Creator cannot accept own pact");
            uint256 requiredDeposit = pact.payment + pact.payment / STAKE_PERCENT;
            require(msg.value >= requiredDeposit, "Insufficient buyer deposit");
            pact.buyer = msg.sender;
            pact.buyerStake = msg.value - pact.payment;
        }

        pact.status = Status.FUNDED;
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
                // Payment increased — buyer must send additional ETH
                uint256 extraPayment = amendment.payment - oldPayment;
                uint256 extraStake = extraPayment / STAKE_PERCENT;
                uint256 extraRequired = extraPayment + extraStake;
                require(msg.value >= extraRequired, "Insufficient additional deposit");
                pact.buyerStake += msg.value - extraPayment;
            } else if (amendment.payment < oldPayment) {
                // Payment decreased — refund excess to buyer
                uint256 reducedPayment = oldPayment - amendment.payment;
                uint256 reducedStake = reducedPayment / STAKE_PERCENT;
                uint256 refund = reducedPayment + reducedStake;
                pact.buyerStake -= reducedStake;
                (bool sent, ) = pact.buyer.call{value: refund}("");
                require(sent, "Failed to refund buyer");
            }
        } else if (pact.initiator == Initiator.SELLER && pact.seller != address(0)) {
            // Seller created and has stake deposited. Adjust seller's stake.
            if (amendment.payment > oldPayment) {
                // Payment increased — seller's required stake increases
                uint256 extraStake = (amendment.payment - oldPayment) / STAKE_PERCENT;
                require(msg.value >= extraStake, "Insufficient additional stake");
                pact.sellerStake += msg.value;
            } else if (amendment.payment < oldPayment) {
                // Payment decreased — refund excess stake to seller
                uint256 reducedStake = (oldPayment - amendment.payment) / STAKE_PERCENT;
                pact.sellerStake -= reducedStake;
                (bool sent, ) = pact.seller.call{value: reducedStake}("");
                require(sent, "Failed to refund seller");
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

        (bool sentSeller, ) = pact.seller.call{value: sellerPayout}("");
        require(sentSeller, "Failed to pay seller");

        (bool sentBuyer, ) = pact.buyer.call{value: buyerReturn}("");
        require(sentBuyer, "Failed to return buyer stake");
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

        if (sellerWins) {
            pact.status = Status.COMPLETED;

            // Seller vindicated: gets completion credit; buyer penalized
            _updateReputation(pact.seller, false, true, pact.payment);
            _penalizeReputation(pact.buyer);

            uint256 sellerPayout = pact.payment + pact.sellerStake + pact.buyerStake;

            (bool sent, ) = pact.seller.call{value: sellerPayout}("");
            require(sent, "Failed to pay seller");
        } else {
            pact.status = Status.REFUNDED;

            // Seller at fault: penalized
            _penalizeReputation(pact.seller);

            uint256 buyerRefund = pact.payment + pact.buyerStake + pact.sellerStake;

            (bool sent, ) = pact.buyer.call{value: buyerRefund}("");
            require(sent, "Failed to refund buyer");
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

            if (pact.initiator == Initiator.BUYER) {
                uint256 refund = pact.payment + pact.buyerStake;
                (bool sent, ) = pact.buyer.call{value: refund}("");
                require(sent, "Failed to refund buyer");
            } else {
                uint256 refund = pact.sellerStake;
                (bool sent, ) = pact.seller.call{value: refund}("");
                require(sent, "Failed to refund seller");
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

            uint256 buyerRefund = pact.payment + pact.buyerStake + pact.sellerStake;
            (bool sent, ) = pact.buyer.call{value: buyerRefund}("");
            require(sent, "Failed to refund buyer");

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
        uint256 verifiedAt
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
            pact.verifiedAt
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
}
