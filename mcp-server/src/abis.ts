/**
 * Contract ABIs in ethers.js human-readable format.
 * These match the deployed contracts in ../contracts/
 */

export const AGENT_PACT_ABI = [
  // State variables
  "function nextPactId() view returns (uint256)",
  "function STAKE_PERCENT() view returns (uint256)",
  "function DEFAULT_REVIEW_PERIOD() view returns (uint256)",

  // Pact lifecycle
  "function createPact(uint8 _initiator, bytes32 specHash, uint256 deadline, address[] oracles, uint8[] oracleWeights, uint8 verificationThreshold, uint256 paymentAmount, uint256 reviewPeriod) payable returns (uint256)",
  "function acceptPact(uint256 pactId) payable",
  "function startWork(uint256 pactId)",
  "function submitWork(uint256 pactId, bytes32 proofHash)",

  // Verification
  "function submitVerification(uint256 pactId, uint8 score, bytes32 proof)",
  "function finalizeVerification(uint256 pactId)",

  // Approval
  "function approveWork(uint256 pactId)",
  "function rejectWork(uint256 pactId)",
  "function autoApprove(uint256 pactId)",

  // Negotiation
  "function proposeAmendment(uint256 pactId, uint256 newPayment, uint256 newDeadline, bytes32 newSpecHash)",
  "function acceptAmendment(uint256 pactId) payable",

  // Disputes
  "function raiseDispute(uint256 pactId, address arbitrator)",
  "function resolveDispute(uint256 pactId, bool sellerWins)",
  "function claimTimeout(uint256 pactId)",

  // View functions
  "function getPact(uint256 pactId) view returns (address buyer, address seller, uint256 payment, uint256 deadline_, uint8 status, bytes32 specHash, uint8 verificationThreshold, uint256 buyerStake, uint256 sellerStake, uint8 initiator, uint256 reviewPeriod, uint256 verifiedAt)",
  "function getPactOracles(uint256 pactId) view returns (address[], uint8[])",
  "function getVerification(uint256 pactId, address oracle) view returns (uint8 score, bool hasSubmitted, bytes32 proof)",
  "function getAmendment(uint256 pactId) view returns (uint256 payment, uint256 deadline_, bytes32 specHash, address proposedBy, bool pending)",

  // Events
  "event PactCreated(uint256 indexed pactId, address indexed creator, uint8 initiator, bytes32 specHash, uint256 payment, uint256 deadline)",
  "event PactAccepted(uint256 indexed pactId, address indexed accepter, uint8 role)",
  "event WorkStarted(uint256 indexed pactId)",
  "event WorkSubmitted(uint256 indexed pactId, bytes32 proofHash)",
  "event VerificationSubmitted(uint256 indexed pactId, address indexed oracle, uint8 score)",
  "event VerificationFinalized(uint256 indexed pactId, uint256 weightedScore, uint8 newStatus)",
  "event PactCompleted(uint256 indexed pactId)",
  "event WorkApproved(uint256 indexed pactId, address indexed approvedBy)",
  "event WorkRejected(uint256 indexed pactId, address indexed rejectedBy)",
  "event AutoApproved(uint256 indexed pactId, address indexed triggeredBy)",
  "event DisputeRaised(uint256 indexed pactId, address indexed raisedBy)",
  "event DisputeResolved(uint256 indexed pactId, bool sellerWins)",
  "event PactRefunded(uint256 indexed pactId)",
  "event TimeoutClaimed(uint256 indexed pactId, address indexed claimedBy)",
  "event AmendmentProposed(uint256 indexed pactId, address indexed proposedBy, uint256 payment, uint256 deadline, bytes32 specHash)",
  "event AmendmentAccepted(uint256 indexed pactId, address indexed acceptedBy)",
];

export const ORACLE_REGISTRY_ABI = [
  "function registerOracle(string[] capabilities) payable",
  "function unregisterOracle()",
  "function challengeOracle(address oracle, string evidence)",
  "function slashOracle(address oracle, uint256 amount)",
  "function incrementVerifications(address oracle)",
  "function setMinStake(uint256 newMinStake)",
  "function isRegistered(address oracle) view returns (bool)",
  "function getOracleStake(address oracle) view returns (uint256)",
  "function getOracleCapabilities(address oracle) view returns (string[])",
  "function getOracleCount() view returns (uint256)",
  "function minStake() view returns (uint256)",

  "event OracleRegistered(address indexed oracle, uint256 stake, string[] capabilities)",
  "event OracleUnregistered(address indexed oracle, uint256 stakeReturned)",
  "event OracleChallenged(address indexed oracle, address indexed challenger, string evidence)",
  "event OracleSlashed(address indexed oracle, uint256 amount)",
  "event MinStakeUpdated(uint256 oldMinStake, uint256 newMinStake)",
];

export const AGENT_POLICY_MODULE_ABI = [
  "function grantSession(address sessionKey, uint256 maxPerTx, uint256 maxDaily, uint256 maxWeekly, uint256 humanApprovalAbove, address[] allowedContracts, bytes4[] allowedFunctions, address[] allowedTokens, uint256 expiresAt)",
  "function revokeSession(address sessionKey)",
  "function validateTransaction(address sessionKey, address to, uint256 value, bytes data) returns (bool)",
  "function getSession(address sessionKey) view returns (uint256 maxPerTx, uint256 maxDaily, uint256 maxWeekly, uint256 humanApprovalAbove, address[] allowedContracts, bytes4[] allowedFunctions, address[] allowedTokens, uint256 expiresAt, bool active)",
  "function getSpending(address sessionKey) view returns (uint256 dailySpent, uint256 weeklySpent, uint256 lastDayReset, uint256 lastWeekReset)",
  "function isSessionActive(address sessionKey) view returns (bool)",
  "function sessionCount() view returns (uint256)",
  "function owner() view returns (address)",

  "event SessionGranted(address indexed sessionKey, uint256 maxPerTx, uint256 maxDaily, uint256 maxWeekly, uint256 expiresAt)",
  "event SessionRevoked(address indexed sessionKey)",
  "event TransactionValidated(address indexed sessionKey, address indexed target, uint256 value)",
  "event TransactionRejected(address indexed sessionKey, address indexed target, uint256 value, string reason)",
  "event SpendingLimitHit(address indexed sessionKey, string limitType, uint256 spent, uint256 limit)",
];
