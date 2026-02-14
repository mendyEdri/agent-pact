# Agent Pact MCP Server — Implementation Plan

## Overview

An MCP (Model Context Protocol) server that exposes the AgentPact and OracleRegistry smart contracts as tools, enabling AI agents to negotiate, execute, and verify work agreements on-chain through natural language interaction.

The server runs as a stdio MCP server that any MCP-compatible AI client (Claude Desktop, Claude Code, etc.) can connect to. Agents use tools to create pacts, accept work, submit deliverables, verify, dispute, and claim timeouts — all backed by on-chain escrow.

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
    │   ├── buyer.ts        # Buyer agent tools (create-pact, claim-timeout)
    │   ├── seller.ts       # Seller agent tools (accept-pact, start-work, submit-work)
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

### Buyer Tools (tools/buyer.ts)

#### `create-pact`
Create a new work agreement with escrow.

Input schema:
```
specHash: string        — IPFS hash of the work specification
deadline: number        — Unix timestamp deadline
oracles: string[]       — Oracle addresses for verification
oracleWeights: number[] — Weight per oracle (must sum to 100)
threshold: number       — Minimum weighted score to pass (0-100)
paymentEth: string      — Payment amount in ETH (e.g. "0.5")
```

Behavior:
- Calculates total deposit (payment + 10% stake)
- Calls `AgentPact.createPact()` with value
- Returns pactId, tx hash, payment breakdown

#### `claim-timeout`
Claim refund when deadline passes without completion.

Input schema:
```
pactId: number — The pact ID
```

Behavior:
- Calls `AgentPact.claimTimeout(pactId)`
- Returns tx hash, refund amount

---

### Seller Tools (tools/seller.ts)

#### `accept-pact`
Accept an open pact and stake collateral.

Input schema:
```
pactId: number — The pact ID to accept
```

Behavior:
- Reads pact to get required stake (payment / 10)
- Calls `AgentPact.acceptPact(pactId)` with stake value
- Returns tx hash, stake amount

#### `start-work`
Signal that work has begun.

Input schema:
```
pactId: number — The pact ID
```

#### `submit-work`
Submit completed work with proof.

Input schema:
```
pactId: number  — The pact ID
proofHash: string — Hash of the work deliverable (bytes32 hex)
```

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

Returns: buyer, seller, payment, deadline, status (human-readable), specHash, threshold, buyerStake, sellerStake, oracles, weights.

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
Trigger final score calculation and payment release.

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
| 0 | NEGOTIATING | Open for sellers to accept |
| 1 | FUNDED | Accepted, ready to start |
| 2 | IN_PROGRESS | Work underway |
| 3 | PENDING_VERIFY | Work submitted, awaiting oracle scores |
| 4 | COMPLETED | Successfully completed, payment released |
| 5 | DISPUTED | Under dispute |
| 6 | REFUNDED | Refunded to buyer |

---

## Error Handling

Each tool wraps contract calls in try/catch and returns structured error messages:
- Revert reasons are extracted and returned as text content with `isError: true`
- Insufficient balance errors get a clear "insufficient funds" message
- Network errors prompt retry suggestion

---

## Implementation Order

1. Scaffolding — package.json, tsconfig, directory structure
2. config.ts + provider.ts — Environment loading, ethers setup
3. contracts.ts — Typed contract instances
4. Query tools — get-pact, get-verification, get-my-address, get-pact-count (read-only, easiest to verify)
5. Buyer tools — create-pact, claim-timeout
6. Seller tools — accept-pact, start-work, submit-work
7. Oracle tools — register-oracle, submit-verification
8. Dispute tools — raise-dispute, resolve-dispute
9. Finalize tool — finalize-verification
10. Resources — contract ABIs, config
11. index.ts — Wire everything together, connect stdio transport
12. Build and verify startup

---

## Example Agent Interaction

**Buyer agent:**
```
Agent: "Create a pact for building a React hero section. Pay 0.5 ETH, deadline in 7 days."
→ calls create-pact tool
← "Pact #3 created. Payment: 0.5 ETH, Stake: 0.05 ETH, Deadline: 1708300800. Tx: 0xabc..."
```

**Seller agent:**
```
Agent: "I'll accept pact #3 and start working on it."
→ calls accept-pact(pactId: 3)
← "Accepted pact #3. Staked 0.05 ETH. Tx: 0xdef..."
→ calls start-work(pactId: 3)
← "Work started on pact #3."
```

**After work completion:**
```
Agent: "Submit my deliverable for pact #3"
→ calls submit-work(pactId: 3, proofHash: "0x123...")
← "Work submitted for pact #3. Awaiting oracle verification."
```
