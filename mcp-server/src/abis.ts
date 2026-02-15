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
  "function createPact(uint8 _initiator, bytes32 specHash, uint256 deadline, address[] oracles, uint8[] oracleWeights, uint8 verificationThreshold, uint256 paymentAmount, uint256 reviewPeriod, uint256 oracleFee, address paymentToken) payable returns (uint256)",
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
  "function getPact(uint256 pactId) view returns (address buyer, address seller, uint256 payment, uint256 deadline_, uint8 status, bytes32 specHash, uint8 verificationThreshold, uint256 buyerStake, uint256 sellerStake, uint8 initiator, uint256 reviewPeriod, uint256 verifiedAt, uint256 oracleFee, bool oracleFeesPaid, address paymentToken)",
  "function getPactOracles(uint256 pactId) view returns (address[], uint8[])",
  "function getVerification(uint256 pactId, address oracle) view returns (uint8 score, bool hasSubmitted, bytes32 proof)",
  "function getAmendment(uint256 pactId) view returns (uint256 payment, uint256 deadline_, bytes32 specHash, address proposedBy, bool pending)",
  "function getReputation(address user) view returns (uint256 completedAsBuyer, uint256 completedAsSeller, uint256 disputesLost, uint256 totalVolumeWei)",
  "function getOpenPacts(uint256 offset, uint256 limit) view returns (uint256[])",
  "function getOpenPactCount() view returns (uint256)",
  "function getPactsByAddress(address user, uint256 offset, uint256 limit) view returns (uint256[])",
  "function getUserPactCount(address user) view returns (uint256)",

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
  "event ReputationUpdated(address indexed user, uint256 completedAsBuyer, uint256 completedAsSeller, uint256 disputesLost, uint256 totalVolumeWei)",
  "event OracleFeePaid(uint256 indexed pactId, address indexed oracle, uint256 amount)",
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
  "function getOraclesByCapability(string capability) view returns (address[])",
  "function getRegisteredOracles(uint256 offset, uint256 limit) view returns (address[], uint256[], uint256[])",
  "function minStake() view returns (uint256)",

  "event OracleRegistered(address indexed oracle, uint256 stake, string[] capabilities)",
  "event OracleUnregistered(address indexed oracle, uint256 stakeReturned)",
  "event OracleChallenged(address indexed oracle, address indexed challenger, string evidence)",
  "event OracleSlashed(address indexed oracle, uint256 amount)",
  "event MinStakeUpdated(uint256 oldMinStake, uint256 newMinStake)",
];

export const ORACLE_ROUTER_ABI = [
  // Validator registration
  "function registerValidator(bytes32[] categories, string endpoint) payable",
  "function deactivateValidator()",
  "function addCategory(bytes32 category)",
  "function removeCategory(bytes32 category)",

  // Verification job flow
  "function requestVerification(address pactContract, uint256 pactId, bytes32 category, bytes32 specHash, address paymentToken) payable returns (uint256)",
  "function claimJob(uint256 jobId)",
  "function submitValidation(uint256 jobId, uint8 score, bytes32 proof)",
  "function expireJob(uint256 jobId)",
  "function cancelJob(uint256 jobId)",

  // Earnings
  "function claimEarnings(address token)",
  "function claimProtocolRevenue(address token)",

  // Slashing
  "function slashValidator(address validator, uint256 amount, string reason)",

  // Admin
  "function setRouterFeeBps(uint256 feeBps)",
  "function setDefaultJobTimeout(uint256 timeout)",
  "function setMinValidatorStake(uint256 minStake)",
  "function setPactWhitelistEnabled(bool enabled)",
  "function setAllowedPactContract(address pactContract, bool allowed)",

  // View functions
  "function getJob(uint256 jobId) view returns (uint256 pactId, address pactContract, bytes32 category, bytes32 specHash, address assignedValidator, uint256 fee, uint256 requestedAt, uint256 deadline, uint8 status, uint8 score, bytes32 proof, address paymentToken)",
  "function getValidatorInfo(address validator) view returns (bool isActive, uint256 stake, uint256 completedJobs, uint256 failedJobs, uint256 totalEarned, string endpoint)",
  "function getValidatorCategories(address validator) view returns (bytes32[])",
  "function getValidatorsForCategory(bytes32 category) view returns (address[], uint256[], uint256[], uint256[])",
  "function getBestValidator(bytes32 category) view returns (address)",
  "function getCategoryValidatorCount(bytes32 category) view returns (uint256)",
  "function getValidatorCount() view returns (uint256)",
  "function pendingEarnings(address validator, address token) view returns (uint256)",
  "function protocolRevenue(address token) view returns (uint256)",
  "function pactToJobId(address pactContract, uint256 pactId) view returns (uint256)",
  "function pactHasJob(address pactContract, uint256 pactId) view returns (bool)",
  "function nextJobId() view returns (uint256)",
  "function minValidatorStake() view returns (uint256)",
  "function routerFeeBps() view returns (uint256)",
  "function defaultJobTimeout() view returns (uint256)",

  // Events
  "event ValidatorRegistered(address indexed validator, uint256 stake, string endpoint)",
  "event ValidatorDeactivated(address indexed validator)",
  "event ValidatorCategoryAdded(address indexed validator, bytes32 indexed category)",
  "event ValidatorCategoryRemoved(address indexed validator, bytes32 indexed category)",
  "event ValidatorSlashed(address indexed validator, uint256 amount, string reason)",
  "event JobRequested(uint256 indexed jobId, uint256 indexed pactId, address pactContract, bytes32 category, address requester, uint256 fee)",
  "event JobAssigned(uint256 indexed jobId, address indexed validator)",
  "event JobCompleted(uint256 indexed jobId, address indexed validator, uint8 score)",
  "event JobExpired(uint256 indexed jobId, address indexed validator)",
  "event EarningsClaimed(address indexed validator, address indexed token, uint256 amount)",
  "event ProtocolRevenueClaimed(address indexed token, uint256 amount)",
];

export const AGENT_POLICY_MODULE_ABI = [
  "function grantSession(address sessionKey, uint256 maxPerTx, uint256 maxDaily, uint256 maxWeekly, uint256 humanApprovalAbove, address[] allowedContracts, bytes4[] allowedFunctions, address[] allowedTokens, uint256 expiresAt)",
  "function revokeSession(address sessionKey)",
  "function executeTransaction(address to, uint256 value, bytes data) returns (bool)",
  "function validateTransaction(address sessionKey, address to, uint256 value, bytes data) returns (bool)",
  "function getSession(address sessionKey) view returns (uint256 maxPerTx, uint256 maxDaily, uint256 maxWeekly, uint256 humanApprovalAbove, address[] allowedContracts, bytes4[] allowedFunctions, address[] allowedTokens, uint256 expiresAt, bool active)",
  "function getSpending(address sessionKey) view returns (uint256 dailySpent, uint256 weeklySpent, uint256 lastDayReset, uint256 lastWeekReset)",
  "function isSessionActive(address sessionKey) view returns (bool)",
  "function safe() view returns (address)",
  "function sessionCount() view returns (uint256)",
  "function owner() view returns (address)",

  // Shared budget
  "function setSharedBudget(uint256 maxDaily, uint256 maxWeekly)",
  "function disableSharedBudget()",
  "function getSharedBudget() view returns (bool enabled, uint256 maxDaily, uint256 maxWeekly, uint256 dailySpent, uint256 weeklySpent, uint256 totalReserved)",
  "function getAvailableBudget() view returns (uint256)",

  // Budget reservations
  "function reserveBudget(uint256 amount) returns (uint256)",
  "function releaseBudget(uint256 reservationId)",
  "function getReservation(uint256 reservationId) view returns (address sessionKey, uint256 amount, bool active)",
  "function getSessionReservations(address sessionKey) view returns (uint256[])",

  "event SessionGranted(address indexed sessionKey, uint256 maxPerTx, uint256 maxDaily, uint256 maxWeekly, uint256 expiresAt)",
  "event SessionRevoked(address indexed sessionKey)",
  "event TransactionValidated(address indexed sessionKey, address indexed target, uint256 value)",
  "event TransactionExecuted(address indexed sessionKey, address indexed target, uint256 value)",
  "event TransactionRejected(address indexed sessionKey, address indexed target, uint256 value, string reason)",
  "event SpendingLimitHit(address indexed sessionKey, string limitType, uint256 spent, uint256 limit)",
  "event SharedBudgetSet(uint256 maxDaily, uint256 maxWeekly)",
  "event BudgetReserved(uint256 indexed reservationId, address indexed sessionKey, uint256 amount)",
  "event BudgetReleased(uint256 indexed reservationId, uint256 amount)",
];
