# Agent Pact — Implementation Plan

## Phase 1: Project Scaffolding & Core Contract

### Step 1: Initialize Hardhat Project
- Run `npx hardhat init` with TypeScript configuration
- Install dependencies: `@nomicfoundation/hardhat-toolbox`, `@openzeppelin/contracts`
- Configure `hardhat.config.ts` for Base Sepolia (chainId 84532)
- Add `.gitignore` for node_modules, artifacts, cache, .env
- Add `.env.example` with placeholder keys (PRIVATE_KEY, BASE_SEPOLIA_RPC, BASESCAN_API_KEY)

### Step 2: Implement AgentPact.sol
Core state machine contract with these states:
- `NEGOTIATING` → `FUNDED` → `IN_PROGRESS` → `PENDING_VERIFY` → `COMPLETED` / `DISPUTED` / `REFUNDED`

Functions to implement:
- `createContract(specHash, deadline, oracles[], weights[], threshold)` — payable, buyer deposits payment + 10% stake, emits `ContractCreated`
- `acceptContract()` — payable, seller deposits 10% stake, moves to FUNDED, emits `ContractAccepted`
- `startWork()` — seller only, moves FUNDED → IN_PROGRESS, emits `WorkStarted`
- `submitWork(proofHash)` — seller only, moves IN_PROGRESS → PENDING_VERIFY, emits `WorkSubmitted`
- `submitVerification(score, proof)` — oracle only, records 0-100 score, emits `VerificationSubmitted`
- `finalizeVerification()` — anyone can call, checks weighted score ≥ threshold, releases payment + stakes if pass, moves to COMPLETED or DISPUTED
- `raiseDispute(arbitrator)` — either party, moves to DISPUTED, emits `DisputeRaised`
- `resolveDispute(sellerWins)` — arbitrator only, distributes funds, emits `DisputeResolved`
- `claimTimeout()` — handles deadline expiry (refund buyer if no accept; refund buyer if no delivery)

Storage:
- Struct `Pact` with: buyer, seller, payment, deadline, status, specHash, verificationHash, oracles[], oracleWeights[], verificationThreshold, arbitrator, disputeFee, buyerStake, sellerStake
- Mapping of oracle address → score for each contract
- Mapping of oracle address → bool (hasSubmitted)

Design decisions:
- Use ReentrancyGuard from OpenZeppelin
- 10% stake calculated as `payment / 10`
- Support multiple contracts via a mapping (contractId → Pact) with auto-incrementing ID
- Factory pattern: single deployment handles all pacts

### Step 3: Implement OracleRegistry.sol
- `registerOracle(capabilities[])` — payable, stake ETH, store oracle info
- `challengeOracle(oracle, evidence)` — challenge bad verification
- `slashOracle(oracle)` — owner/governance can slash stake
- `getOracle(address)` — view oracle info
- `isRegistered(address)` — view check
- Minimum stake requirement configurable by owner

### Step 4: Write Unit Tests

Test file: `test/AgentPact.test.ts`

Happy path tests:
1. Create contract with correct payment + stake
2. Accept contract with correct stake
3. Start work
4. Submit work with proof hash
5. Oracle submits passing verification (score ≥ threshold)
6. Finalize releases payment to seller + returns both stakes
7. Full happy path end-to-end in single test

Failure/edge case tests:
1. Cannot accept own contract
2. Cannot accept without correct stake
3. Cannot start work if not seller
4. Cannot submit work if not IN_PROGRESS
5. Only registered oracles can verify
6. Verification below threshold triggers dispute path
7. Cannot finalize before all oracles submit
8. Timeout: buyer claims refund if no acceptance before deadline
9. Timeout: buyer claims refund if no delivery before deadline

Dispute tests:
1. Raise dispute moves to DISPUTED
2. Only arbitrator can resolve
3. Resolve in seller's favor releases payment to seller
4. Resolve in buyer's favor refunds buyer
5. Stakes distributed correctly on dispute resolution

Test file: `test/OracleRegistry.test.ts`
1. Register oracle with sufficient stake
2. Reject registration with insufficient stake
3. Challenge oracle
4. Slash oracle reduces stake

### Step 5: Deployment Script
- `scripts/deploy.ts` — deploys OracleRegistry then AgentPact
- Verifies contracts on BaseScan
- Logs deployed addresses

---

## Phase 2: Specification System (future — not in this PR)
- JSON schema validation for spec format
- IPFS upload/retrieval helpers via Pinata SDK
- Example spec templates

## Phase 3: Frontend (future — not in this PR)
- Next.js app with ethers.js
- Create/view/manage contracts UI

## Phase 4: Oracle Service (future — not in this PR)
- Off-chain oracle server listening for WorkSubmitted events

---

## File Structure (Phase 1 deliverables)

```
agent-pact/
├── contracts/
│   ├── AgentPact.sol
│   └── OracleRegistry.sol
├── test/
│   ├── AgentPact.test.ts
│   └── OracleRegistry.test.ts
├── scripts/
│   └── deploy.ts
├── hardhat.config.ts
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example
└── PLAN.md
```

## Implementation Order
1. Scaffolding (hardhat init, deps, config)
2. OracleRegistry.sol (simpler, dependency of AgentPact)
3. AgentPact.sol (core contract)
4. Tests for OracleRegistry
5. Tests for AgentPact
6. Deployment script
7. Compile + run all tests green
8. Commit and push
