// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract AgentPact is ReentrancyGuard {
    enum Status {
        NEGOTIATING,
        FUNDED,
        IN_PROGRESS,
        PENDING_VERIFY,
        COMPLETED,
        DISPUTED,
        REFUNDED
    }

    struct Verification {
        uint8 score;
        bool hasSubmitted;
        bytes32 proof;
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
    }

    uint256 public nextPactId;
    uint256 public constant STAKE_PERCENT = 10;

    mapping(uint256 => Pact) public pacts;
    mapping(uint256 => mapping(address => Verification)) public verifications;

    event PactCreated(
        uint256 indexed pactId,
        address indexed buyer,
        bytes32 specHash,
        uint256 payment,
        uint256 deadline
    );
    event PactAccepted(uint256 indexed pactId, address indexed seller);
    event WorkStarted(uint256 indexed pactId);
    event WorkSubmitted(uint256 indexed pactId, bytes32 proofHash);
    event VerificationSubmitted(
        uint256 indexed pactId,
        address indexed oracle,
        uint8 score
    );
    event PactCompleted(uint256 indexed pactId, uint256 weightedScore);
    event DisputeRaised(uint256 indexed pactId, address indexed raisedBy);
    event DisputeResolved(uint256 indexed pactId, bool sellerWins);
    event PactRefunded(uint256 indexed pactId);
    event TimeoutClaimed(uint256 indexed pactId, address indexed claimedBy);

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

    function createPact(
        bytes32 specHash,
        uint256 deadline,
        address[] calldata oracles,
        uint8[] calldata oracleWeights,
        uint8 verificationThreshold
    ) external payable returns (uint256) {
        require(oracles.length > 0, "Need at least one oracle");
        require(oracles.length == oracleWeights.length, "Oracles/weights mismatch");
        require(verificationThreshold <= 100, "Threshold must be <= 100");
        require(deadline > block.timestamp, "Deadline must be in the future");

        uint256 totalWeight = 0;
        for (uint256 i = 0; i < oracleWeights.length; i++) {
            totalWeight += oracleWeights[i];
        }
        require(totalWeight == 100, "Weights must sum to 100");

        uint256 stake = msg.value / (STAKE_PERCENT + 1);
        uint256 payment = msg.value - stake;
        require(payment > 0, "Payment must be > 0");

        // Verify: stake ≈ 10% of payment (within rounding)
        // msg.value = payment + payment/10 = payment * 11/10
        // So payment = msg.value * 10 / 11, stake = msg.value * 1 / 11

        uint256 pactId = nextPactId++;

        Pact storage pact = pacts[pactId];
        pact.buyer = msg.sender;
        pact.payment = payment;
        pact.deadline = deadline;
        pact.status = Status.NEGOTIATING;
        pact.specHash = specHash;
        pact.oracles = oracles;
        pact.oracleWeights = oracleWeights;
        pact.verificationThreshold = verificationThreshold;
        pact.buyerStake = stake;
        pact.createdAt = block.timestamp;

        emit PactCreated(pactId, msg.sender, specHash, payment, deadline);
        return pactId;
    }

    function acceptPact(uint256 pactId)
        external
        payable
        inStatus(pactId, Status.NEGOTIATING)
    {
        Pact storage pact = pacts[pactId];
        require(msg.sender != pact.buyer, "Buyer cannot accept own pact");
        require(block.timestamp < pact.deadline, "Pact expired");

        uint256 requiredStake = pact.payment / STAKE_PERCENT;
        require(msg.value >= requiredStake, "Insufficient seller stake");

        pact.seller = msg.sender;
        pact.sellerStake = msg.value;
        pact.status = Status.FUNDED;

        emit PactAccepted(pactId, msg.sender);
    }

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
            pact.status = Status.COMPLETED;

            // Pay seller: payment + seller stake + buyer stake returned
            uint256 sellerPayout = pact.payment + pact.sellerStake;
            uint256 buyerReturn = pact.buyerStake;

            (bool sentSeller, ) = pact.seller.call{value: sellerPayout}("");
            require(sentSeller, "Failed to pay seller");

            (bool sentBuyer, ) = pact.buyer.call{value: buyerReturn}("");
            require(sentBuyer, "Failed to return buyer stake");

            emit PactCompleted(pactId, weightedScore);
        } else {
            pact.status = Status.DISPUTED;
            emit DisputeRaised(pactId, address(this));
        }
    }

    function raiseDispute(uint256 pactId, address arbitrator) external {
        Pact storage pact = pacts[pactId];
        require(
            pact.status == Status.IN_PROGRESS ||
            pact.status == Status.PENDING_VERIFY,
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

            uint256 sellerPayout = pact.payment + pact.sellerStake + pact.buyerStake;

            (bool sent, ) = pact.seller.call{value: sellerPayout}("");
            require(sent, "Failed to pay seller");
        } else {
            pact.status = Status.REFUNDED;

            uint256 buyerRefund = pact.payment + pact.buyerStake + pact.sellerStake;

            (bool sent, ) = pact.buyer.call{value: buyerRefund}("");
            require(sent, "Failed to refund buyer");
        }

        emit DisputeResolved(pactId, sellerWins);
    }

    function claimTimeout(uint256 pactId) external nonReentrant {
        Pact storage pact = pacts[pactId];
        require(block.timestamp > pact.deadline, "Deadline not passed");

        if (pact.status == Status.NEGOTIATING) {
            // No one accepted — refund buyer
            pact.status = Status.REFUNDED;

            uint256 refund = pact.payment + pact.buyerStake;
            (bool sent, ) = pact.buyer.call{value: refund}("");
            require(sent, "Failed to refund buyer");

            emit TimeoutClaimed(pactId, msg.sender);
            emit PactRefunded(pactId);
        } else if (pact.status == Status.FUNDED || pact.status == Status.IN_PROGRESS) {
            // Seller didn't deliver — refund buyer, forfeit seller stake
            pact.status = Status.REFUNDED;

            uint256 buyerRefund = pact.payment + pact.buyerStake + pact.sellerStake;
            (bool sent, ) = pact.buyer.call{value: buyerRefund}("");
            require(sent, "Failed to refund buyer");

            emit TimeoutClaimed(pactId, msg.sender);
            emit PactRefunded(pactId);
        } else {
            revert("Cannot claim timeout in current status");
        }
    }

    // View functions

    function getPact(uint256 pactId) external view returns (
        address buyer,
        address seller,
        uint256 payment,
        uint256 deadline,
        Status status,
        bytes32 specHash,
        uint8 verificationThreshold,
        uint256 buyerStake,
        uint256 sellerStake
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
            pact.sellerStake
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
}
