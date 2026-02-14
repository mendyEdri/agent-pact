// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract OracleRegistry is Ownable, ReentrancyGuard {
    struct Oracle {
        bool isRegistered;
        uint256 stake;
        string[] capabilities;
        uint256 completedVerifications;
        uint256 challengeCount;
    }

    uint256 public minStake;
    mapping(address => Oracle) public oracles;
    address[] public oracleList;

    event OracleRegistered(address indexed oracle, uint256 stake, string[] capabilities);
    event OracleUnregistered(address indexed oracle);
    event OracleChallenged(address indexed oracle, address indexed challenger, string evidence);
    event OracleSlashed(address indexed oracle, uint256 amount);
    event MinStakeUpdated(uint256 newMinStake);

    constructor(uint256 _minStake) Ownable(msg.sender) {
        minStake = _minStake;
    }

    function registerOracle(string[] calldata capabilities) external payable {
        require(!oracles[msg.sender].isRegistered, "Already registered");
        require(msg.value >= minStake, "Insufficient stake");
        require(capabilities.length > 0, "Must have capabilities");

        oracles[msg.sender] = Oracle({
            isRegistered: true,
            stake: msg.value,
            capabilities: capabilities,
            completedVerifications: 0,
            challengeCount: 0
        });
        oracleList.push(msg.sender);

        emit OracleRegistered(msg.sender, msg.value, capabilities);
    }

    function unregisterOracle() external nonReentrant {
        Oracle storage oracle = oracles[msg.sender];
        require(oracle.isRegistered, "Not registered");

        uint256 stakeToReturn = oracle.stake;
        oracle.isRegistered = false;
        oracle.stake = 0;

        (bool sent, ) = msg.sender.call{value: stakeToReturn}("");
        require(sent, "Failed to return stake");

        emit OracleUnregistered(msg.sender);
    }

    function challengeOracle(address oracle, string calldata evidence) external {
        require(oracles[oracle].isRegistered, "Oracle not registered");
        oracles[oracle].challengeCount++;
        emit OracleChallenged(oracle, msg.sender, evidence);
    }

    function slashOracle(address oracle, uint256 amount) external onlyOwner nonReentrant {
        Oracle storage o = oracles[oracle];
        require(o.isRegistered, "Oracle not registered");
        require(amount <= o.stake, "Amount exceeds stake");

        o.stake -= amount;

        (bool sent, ) = owner().call{value: amount}("");
        require(sent, "Failed to send slashed amount");

        emit OracleSlashed(oracle, amount);
    }

    function incrementVerifications(address oracle) external {
        require(oracles[oracle].isRegistered, "Oracle not registered");
        oracles[oracle].completedVerifications++;
    }

    function setMinStake(uint256 _minStake) external onlyOwner {
        minStake = _minStake;
        emit MinStakeUpdated(_minStake);
    }

    function isRegistered(address oracle) external view returns (bool) {
        return oracles[oracle].isRegistered;
    }

    function getOracleStake(address oracle) external view returns (uint256) {
        return oracles[oracle].stake;
    }

    function getOracleCapabilities(address oracle) external view returns (string[] memory) {
        return oracles[oracle].capabilities;
    }

    function getOracleCount() external view returns (uint256) {
        return oracleList.length;
    }
}
