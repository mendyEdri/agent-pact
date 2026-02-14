# Agent Pact MCP Server — Implementation Plan

## Overview

An MCP (Model Context Protocol) server that exposes the AgentPact and OracleRegistry smart contracts as tools, enabling AI agents to negotiate, execute, and verify work agreements on-chain through natural language interaction.

The server runs as a stdio MCP server that any MCP-compatible AI client (Claude Desktop, Claude Code, etc.) can connect to. Agents use tools to create pacts, accept work, submit deliverables, verify, dispute, and claim timeouts — all backed by on-chain escrow.

---

## Key Design Decisions

### Bidirectional Pact Creation

Either party can initiate a pact:

- **Buyer-initiated** (request for work): Buyer creates pact with spec + payment + stake. Seller accepts by depositing their stake.
- **Seller-initiated** (offer/listing): Seller creates pact advertising a service or product (e.g., flight ticket, code review service). Seller deposits their stake. Buyer accepts by depositing payment + buyer stake.

The contract stores an `initiator` field (enum: `BUYER` or `SELLER`) on each pact. The `acceptPact` function behaves differently based on who created it:

| Creator | Creator deposits | Accepter becomes | Accepter deposits |
|---------|-----------------|------------------|-------------------|
| Buyer   | payment + 10% buyer stake | Seller | 10% seller stake |
| Seller  | 10% seller stake | Buyer | payment + 10% buyer stake |

### Buyer Approval Step

After oracle verification passes, the pact moves to `PENDING_APPROVAL` instead of auto-completing. This gives the buyer final review:

1. Oracles submit scores → `finalizeVerification` calculates weighted score
2. If score >= threshold → status moves to `PENDING_APPROVAL`
3. Buyer calls `approveWork` → payment released, status `COMPLETED`
4. Buyer calls `rejectWork` → status moves to `DISPUTED`
5. If buyer doesn't respond within `reviewPeriod` → anyone can call `autoApprove` to release payment (prevents buyer from holding funds hostage)

The `reviewPeriod` is set at pact creation time (default: 3 days).

### On-Chain Counter-Offers

Agents can negotiate terms on-chain before committing. While in `NEGOTIATING` status, either party can propose amended terms via `proposeAmendment`. This creates a transparent, auditable negotiation trail.

**How it works:**

1. Party A creates a pact with initial terms (deposits their side)
2. Party B reviews the pact. Instead of accepting as-is, they call `proposeAmendment(pactId, newPayment, newDeadline, newSpecHash)` — this stores a pending counter-offer
3. Party A can:
   - `acceptAmendment(pactId)` → terms are updated on the pact, amendment cleared. If payment changed, deposit difference is refunded or additional ETH is required with the call.
   - Ignore it and propose their own counter: `proposeAmendment(...)` — replaces the pending amendment
4. Repeat until one side accepts the amendment, then the counterparty calls `acceptPact` to fund and commit

**Rules:**
- Only works in `NEGOTIATING` status
- Only one pending amendment at a time (new proposal replaces previous)
- You can't accept your own amendment (`proposedBy != msg.sender`)
- `acceptAmendment` is payable — if the amendment increases the creator's required deposit, they send the difference. If it decreases, excess is refunded.
- Amendments can change: `payment`, `deadline`, `specHash` (not oracles/threshold — those are structural and should be set at creation)

**Contract struct:**
```solidity
struct Amendment {
    uint256 payment;
    uint256 deadline;
    bytes32 specHash;
    address proposedBy;
    bool pending;
}
```

**Gas consideration:** Each counter-offer costs ~50k gas (~$0.01 on Base L2). Reasonable for a negotiation that typically takes 1-3 rounds. On L1 Ethereum it would cost more — agents should negotiate off-chain on L1.

### Updated State Machine

```
                    ┌──────────────────────┐
                    │  proposeAmendment /   │
                    │  acceptAmendment      │
                    ↓                      │
NEGOTIATING ←──────────────────────────────┘
     │
     ↓ acceptPact
   FUNDED → IN_PROGRESS → PENDING_VERIFY → PENDING_APPROVAL → COMPLETED
                               ↓                   ↓
                           DISPUTED ←──────── DISPUTED
                               ↓
                         COMPLETED / REFUNDED
```

---

## Smart Contract Changes Required

The AgentPact.sol contract needs these modifications before the MCP server is built:

1. Add `Initiator` enum: `BUYER`, `SELLER`
2. Add `PENDING_APPROVAL` to `Status` enum (index 7)
3. Add fields to `Pact` struct: `initiator` (Initiator), `reviewPeriod` (uint256), `verifiedAt` (uint256)
4. Update `createPact`: accept `initiator` param; if seller-initiated, only require seller stake deposit, store price but don't require payment
5. Update `acceptPact`: if accepting seller-initiated pact, accepter deposits payment + buyer stake; if accepting buyer-initiated pact, accepter deposits seller stake (existing behavior)
6. Update `finalizeVerification`: if score passes, move to `PENDING_APPROVAL` + set `verifiedAt = block.timestamp` instead of directly completing
7. Add `approveWork(pactId)`: buyer only, moves `PENDING_APPROVAL` → `COMPLETED`, releases funds
8. Add `rejectWork(pactId)`: buyer only, moves `PENDING_APPROVAL` → `DISPUTED`
9. Add `autoApprove(pactId)`: anyone can call if `block.timestamp > verifiedAt + reviewPeriod`, releases funds
10. Add `Amendment` struct and `mapping(uint256 => Amendment) public amendments` storage
11. Add `proposeAmendment(pactId, newPayment, newDeadline, newSpecHash)`: only in NEGOTIATING, stores pending amendment with `proposedBy = msg.sender`, emits `AmendmentProposed` event
12. Add `acceptAmendment(pactId)` (payable): only in NEGOTIATING, `msg.sender != amendment.proposedBy`, updates pact terms, handles deposit adjustments (refund excess or require additional ETH), clears amendment, emits `AmendmentAccepted` event

---

## Package Structure

```
mcp-server/
├── package.json            # Separate package, type: "module"
├── tsconfig.json
└── src/
    ├── index.ts            # Entry point: create server, connect stdio transport
    ├── config.ts           # Chain config, contract addresses, env loading
    ├── provider.ts         # Ethers provider + signer setup
    ├── contracts.ts        # Contract instances (AgentPact, OracleRegistry)
    ├── tools/
    │   ├── pact.ts         # Pact lifecycle tools (create-pact, accept-pact — both roles)
    │   ├── negotiate.ts    # Negotiation tools (propose-amendment, accept-amendment)
    │   ├── work.ts         # Work tools (start-work, submit-work)
    │   ├── approval.ts     # Buyer approval tools (approve-work, reject-work, auto-approve)
    │   ├── oracle.ts       # Oracle tools (submit-verification, register-oracle)
    │   ├── dispute.ts      # Dispute tools (raise-dispute, resolve-dispute)
    │   ├── query.ts        # Read-only tools (get-pact, list-pacts, get-verification)
    │   └── finalize.ts     # Finalization tools (finalize-verification)
    └── resources/
        └── contracts.ts    # MCP resources: ABI, addresses, chain info
```

---

## Dependencies

```json
{
  "@modelcontextprotocol/sdk": "^1.26.0",
  "zod": "^3.25.0",
  "ethers": "^6.16.0",
  "dotenv": "^16.0.0"
}
```

Reuses the typechain-types from the root project for typed contract interaction.

---

## Configuration (config.ts)

Loaded from environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVATE_KEY` | Wallet private key for signing txs | required |
| `RPC_URL` | JSON-RPC endpoint | `https://sepolia.base.org` |
| `AGENT_PACT_ADDRESS` | Deployed AgentPact contract address | required |
| `ORACLE_REGISTRY_ADDRESS` | Deployed OracleRegistry contract address | required |
| `CHAIN_ID` | Chain ID | `84532` (Base Sepolia) |

---

## MCP Tools

### Pact Lifecycle (tools/pact.ts)

#### `create-pact`
Create a new pact — works for both buyer-initiated and seller-initiated flows.

Input schema:
```
role: "buyer" | "seller" — Who is creating this pact
specHash: string         — IPFS hash of the work/service specification
deadline: number         — Unix timestamp deadline
oracles: string[]        — Oracle addresses for verification
oracleWeights: number[]  — Weight per oracle (must sum to 100)
threshold: number        — Minimum weighted score to pass (0-100)
paymentEth: string       — Payment amount in ETH (e.g. "0.5")
reviewPeriod: number     — Buyer review window in seconds (default: 259200 = 3 days)
```

Behavior when `role = "buyer"` (request for work):
- Calculates total deposit (payment + 10% buyer stake)
- Calls `AgentPact.createPact()` with initiator=BUYER and value
- Returns pactId, tx hash. Pact is open for sellers to accept.

Behavior when `role = "seller"` (offer/listing):
- Calculates seller stake (10% of payment price)
- Calls `AgentPact.createPact()` with initiator=SELLER and stake value
- Returns pactId, tx hash. Pact is open for buyers to accept.

#### `accept-pact`
Accept an open pact. Automatically detects whether you're joining as buyer or seller.

Input schema:
```
pactId: number — The pact ID to accept
```

Behavior:
- Reads pact to determine initiator role
- If buyer-initiated: accepter becomes seller, deposits 10% seller stake
- If seller-initiated: accepter becomes buyer, deposits payment + 10% buyer stake
- Returns tx hash, role assigned, amount deposited

#### `claim-timeout`
Claim refund when deadline passes without completion.

Input schema:
```
pactId: number — The pact ID
```

---

### Negotiation (tools/negotiate.ts)

#### `propose-amendment`
Propose modified terms for a pact in NEGOTIATING status. Creates an on-chain counter-offer.

Input schema:
```
pactId: number          — The pact ID
paymentEth: string      — New payment amount in ETH (e.g. "0.4"), or null to keep current
deadline: number        — New deadline as Unix timestamp, or null to keep current
specHash: string        — New spec IPFS hash, or null to keep current
```

Behavior:
- Only callable when status is `NEGOTIATING`
- Replaces any existing pending amendment
- Does not require a deposit — just a proposal
- Returns tx hash, proposed terms summary

#### `accept-amendment`
Accept the pending counter-offer on a pact. Updates the pact terms.

Input schema:
```
pactId: number — The pact ID
```

Behavior:
- Only callable by the party who did NOT propose the amendment
- Updates the pact's payment, deadline, specHash to the amended values
- If payment changed and caller is the creator with funds deposited:
  - Payment increased → caller must send additional ETH with this call
  - Payment decreased → excess ETH is refunded to caller
- Pact stays in `NEGOTIATING` with updated terms (still needs `accept-pact` to fund and start)
- Returns tx hash, updated terms, any deposit adjustment

#### `get-amendment`
Get the current pending amendment on a pact (read-only).

Input schema:
```
pactId: number — The pact ID
```

Returns: proposed payment, deadline, specHash, proposedBy address, whether an amendment is pending.

---

### Work Tools (tools/work.ts)

#### `start-work`
Signal that work has begun (seller only).

Input schema:
```
pactId: number — The pact ID
```

#### `submit-work`
Submit completed work with proof (seller only).

Input schema:
```
pactId: number   — The pact ID
proofHash: string — Hash of the work deliverable (bytes32 hex)
```

---

### Buyer Approval (tools/approval.ts)

#### `approve-work`
Buyer approves the delivered work after oracle verification passes. Releases payment to seller.

Input schema:
```
pactId: number — The pact ID
```

Behavior:
- Only callable by buyer when status is `PENDING_APPROVAL`
- Releases payment + seller stake to seller, returns buyer stake to buyer
- Status moves to `COMPLETED`

#### `reject-work`
Buyer rejects the delivered work after oracle verification. Triggers dispute.

Input schema:
```
pactId: number — The pact ID
```

Behavior:
- Only callable by buyer when status is `PENDING_APPROVAL`
- Status moves to `DISPUTED`
- Buyer must then set arbitrator or use existing dispute flow

#### `auto-approve`
Anyone can call this after the review period expires to release payment. Prevents buyer from holding funds hostage.

Input schema:
```
pactId: number — The pact ID
```

Behavior:
- Callable by anyone when `block.timestamp > verifiedAt + reviewPeriod`
- Same payout logic as `approve-work`

---

### Oracle Tools (tools/oracle.ts)

#### `register-oracle`
Register as a verification oracle.

Input schema:
```
capabilities: string[] — List of capabilities (e.g. ["code-review", "testing"])
stakeEth: string       — Stake amount in ETH
```

#### `submit-verification`
Submit a verification score for submitted work.

Input schema:
```
pactId: number    — The pact ID
score: number     — Score 0-100
proof: string     — Proof hash (bytes32 hex)
```

---

### Dispute Tools (tools/dispute.ts)

#### `raise-dispute`
Raise a dispute on an active pact.

Input schema:
```
pactId: number       — The pact ID
arbitrator: string   — Arbitrator address
```

#### `resolve-dispute`
Resolve a dispute (arbitrator only).

Input schema:
```
pactId: number      — The pact ID
sellerWins: boolean — true = seller wins, false = buyer wins
```

---

### Query Tools (tools/query.ts) — Read-only

#### `get-pact`
Get full details of a pact.

Input schema:
```
pactId: number
```

Returns: buyer, seller, initiator (buyer/seller), payment, deadline, status (human-readable), specHash, threshold, buyerStake, sellerStake, oracles, weights, reviewPeriod, verifiedAt.

#### `get-verification`
Get verification details for an oracle on a pact.

Input schema:
```
pactId: number
oracle: string — Oracle address
```

#### `get-my-address`
Returns the connected wallet address and ETH balance. No inputs.

#### `get-pact-count`
Returns the total number of pacts created. No inputs.

---

### Finalization (tools/finalize.ts)

#### `finalize-verification`
Trigger final score calculation. If score passes threshold, moves to `PENDING_APPROVAL` (not directly to `COMPLETED`).

Input schema:
```
pactId: number
```

---

## MCP Resources (resources/contracts.ts)

#### `pact://config`
Returns deployed contract addresses, chain info, and connected wallet address as JSON.

#### `pact://abi/agent-pact`
Returns the AgentPact ABI as JSON.

#### `pact://abi/oracle-registry`
Returns the OracleRegistry ABI as JSON.

---

## Provider Setup (provider.ts)

- Uses `ethers.JsonRpcProvider` with configured RPC URL
- Creates `ethers.Wallet` from PRIVATE_KEY, connected to provider
- Exposes helper to get balance formatted in ETH

---

## Contract Instances (contracts.ts)

- Uses `AgentPact__factory.connect(address, signer)` from typechain
- Uses `OracleRegistry__factory.connect(address, signer)` from typechain
- Lazy initialization (connect on first use)

---

## Entry Point (index.ts)

1. Load config from env (dotenv)
2. Create `McpServer({ name: "agent-pact", version: "1.0.0" })`
3. Register all tools from `tools/*.ts`
4. Register resources from `resources/*.ts`
5. Connect via `StdioServerTransport`

All console output goes to stderr (stdout reserved for MCP protocol).

---

## Status Mapping

The contract returns numeric status. The MCP tools return human-readable strings:

| Code | Status | Description |
|------|--------|-------------|
| 0 | NEGOTIATING | Open for counterparty to accept |
| 1 | FUNDED | Both parties staked, ready to start |
| 2 | IN_PROGRESS | Work underway |
| 3 | PENDING_VERIFY | Work submitted, awaiting oracle scores |
| 4 | COMPLETED | Successfully completed, payment released |
| 5 | DISPUTED | Under dispute |
| 6 | REFUNDED | Refunded to buyer |
| 7 | PENDING_APPROVAL | Oracle verification passed, awaiting buyer approval |

---

## Error Handling

Each tool wraps contract calls in try/catch and returns structured error messages:
- Revert reasons are extracted and returned as text content with `isError: true`
- Insufficient balance errors get a clear "insufficient funds" message
- Network errors prompt retry suggestion

---

## Implementation Order

1. **Contract updates** — Update AgentPact.sol: add Initiator enum, PENDING_APPROVAL status, bidirectional createPact, approveWork/rejectWork/autoApprove, proposeAmendment/acceptAmendment functions. Update tests.
2. Scaffolding — package.json, tsconfig, directory structure
3. config.ts + provider.ts — Environment loading, ethers setup
4. contracts.ts — Typed contract instances
5. Query tools — get-pact, get-verification, get-my-address, get-pact-count
6. Pact lifecycle tools — create-pact (both roles), accept-pact, claim-timeout
7. Negotiation tools — propose-amendment, accept-amendment, get-amendment
8. Work tools — start-work, submit-work
9. Approval tools — approve-work, reject-work, auto-approve
10. Oracle tools — register-oracle, submit-verification
11. Dispute tools — raise-dispute, resolve-dispute
12. Finalize tool — finalize-verification
13. Resources — contract ABIs, config
14. index.ts — Wire everything together, connect stdio transport
15. Build and verify startup

---

## Example Agent Interactions

### Flow 1: Buyer-initiated (request for work)

**Buyer agent creates a work request:**
```
Agent: "Create a pact for building a React hero section. Pay 0.5 ETH, deadline in 7 days."
→ calls create-pact(role: "buyer", specHash: "Qm...", paymentEth: "0.5", ...)
← "Pact #3 created as BUYER. Deposited: 0.55 ETH (0.5 payment + 0.05 stake). Open for sellers."
```

**Seller agent accepts and delivers:**
```
Agent: "I'll accept pact #3."
→ calls accept-pact(pactId: 3)
← "Accepted pact #3 as SELLER. Staked 0.05 ETH."
→ calls start-work(pactId: 3)
→ calls submit-work(pactId: 3, proofHash: "0x123...")
← "Work submitted. Awaiting oracle verification."
```

**Oracles verify, buyer approves:**
```
[Oracle submits score 85/100, finalize-verification called → PENDING_APPROVAL]

Buyer agent: "The hero section looks great, approve it."
→ calls approve-work(pactId: 3)
← "Pact #3 approved. 0.55 ETH released to seller, 0.05 ETH stake returned to you."
```

### Flow 2: Seller-initiated (service offer / listing)

**Seller agent lists a service:**
```
Agent: "I'm offering flight booking assistance for 0.1 ETH."
→ calls create-pact(role: "seller", specHash: "Qm...", paymentEth: "0.1", ...)
← "Pact #7 created as SELLER. Staked 0.01 ETH. Listing open for buyers."
```

**Buyer agent accepts the offer:**
```
Agent: "I'd like to use the flight booking service in pact #7."
→ calls accept-pact(pactId: 7)
← "Accepted pact #7 as BUYER. Deposited 0.11 ETH (0.1 payment + 0.01 stake)."
```

**Seller delivers, buyer approves:**
```
[Seller does the work, submits, oracles verify → PENDING_APPROVAL]

Buyer agent: "Flight is booked, approve."
→ calls approve-work(pactId: 7)
← "Pact #7 approved. 0.11 ETH released to seller, 0.01 ETH stake returned to you."
```

### Flow 3: On-chain negotiation (counter-offers)

**Buyer creates a pact, seller negotiates:**
```
Buyer agent: "Create a pact for building an API integration. Pay 0.5 ETH, deadline in 7 days."
→ calls create-pact(role: "buyer", paymentEth: "0.5", deadline: 1711324800, specHash: "QmBuyer...")
← "Pact #10 created as BUYER. Deposited: 0.55 ETH. Open for sellers."
```

**Seller reviews, wants different terms:**
```
Seller agent: "Pact #10 looks interesting but 0.5 ETH is too low for API work and I need more time."
→ calls get-pact(pactId: 10)
← { payment: 0.5 ETH, deadline: "2026-03-25", specHash: "QmBuyer...", status: "NEGOTIATING" }

→ calls propose-amendment(pactId: 10, paymentEth: "0.7", deadline: 1712534400, specHash: null)
← "Amendment proposed for pact #10: payment 0.5→0.7 ETH, deadline extended by 14 days. Waiting for buyer."
```

**Buyer counter-proposes:**
```
Buyer agent: "0.7 is too much. I'll meet in the middle at 0.6 ETH but keep the original deadline."
→ calls propose-amendment(pactId: 10, paymentEth: "0.6", deadline: null, specHash: null)
← "Amendment proposed for pact #10: payment 0.5→0.6 ETH, deadline unchanged. Waiting for seller."
```

**Seller accepts the amendment:**
```
Seller agent: "0.6 ETH works for me."
→ calls accept-amendment(pactId: 10)
← "Amendment accepted. Pact #10 updated: payment now 0.6 ETH. Buyer sent additional 0.066 ETH to cover new price + stake."
```

**Now seller accepts the pact at the agreed terms:**
```
→ calls accept-pact(pactId: 10)
← "Accepted pact #10 as SELLER. Staked 0.06 ETH. Work can begin."
```

### Flow 4: Buyer doesn't respond (auto-approve)

```
[Oracle verification passes → PENDING_APPROVAL, verifiedAt = Jan 10]
[Review period = 3 days, buyer doesn't respond]
[Jan 14: anyone calls auto-approve]

→ calls auto-approve(pactId: 5)
← "Review period expired. Pact #5 auto-approved. Payment released to seller."
```
