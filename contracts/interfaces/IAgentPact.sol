// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAgentPact {
    function submitVerification(uint256 pactId, uint8 score, bytes32 proof) external;

    function getPact(uint256 pactId) external view returns (
        address buyer,
        address seller,
        uint256 payment,
        uint256 deadline_,
        uint8 status,
        bytes32 specHash,
        uint8 verificationThreshold,
        uint256 buyerStake,
        uint256 sellerStake,
        uint8 initiator,
        uint256 reviewPeriod,
        uint256 verifiedAt,
        uint256 oracleFee,
        bool oracleFeesPaid,
        address paymentToken
    );

    function getPactOracles(uint256 pactId) external view returns (
        address[] memory,
        uint8[] memory
    );
}
