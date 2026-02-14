# Agent Reputation System — Implementation Plan

## Overview

Add on-chain reputation tracking to AgentPact.sol so agents can assess counterparty trustworthiness before committing funds. Track completions, disputes lost, and volume per address. Expose via a view function and MCP query tool.

---

## Step 1: Add Reputation struct and mapping to AgentPact.sol

**File:** `contracts/AgentPact.sol`

Add after line 64 (after the `amendments` mapping):

```solidity
struct Reputation {
    uint256 completedAsBuyer;
    uint256 completedAsSeller;
    uint256 disputesLost;
    uint256 totalVolumeWei;
}

mapping(address => Reputation) public reputation;

event ReputationUpdated(address indexed user, uint256 completedAsBuyer, uint256 completedAsSeller, uint256 disputesLost, uint256 totalVolumeWei);
```

**Why a struct:** Keeps all reputation data co-located for a single SLOAD when querying. Four uint256 fields = 4 storage slots per address, but only written on pact completion (infrequent).

---

## Step 2: Update `_releaseFunds` to track successful completions

**File:** `contracts/AgentPact.sol`, lines 445-459

After `pact.status = Status.COMPLETED` (line 447), add reputation increments:

```solidity
function _releaseFunds(uint256 pactId) internal {
    Pact storage pact = pacts[pactId];
    pact.status = Status.COMPLETED;

    // ── NEW: Update reputation ──
    reputation[pact.buyer].completedAsBuyer++;
    reputation[pact.buyer].totalVolumeWei += pact.payment;
    reputation[pact.seller].completedAsSeller++;
    reputation[pact.seller].totalVolumeWei += pact.payment;
    emit ReputationUpdated(pact.buyer, reputation[pact.buyer].completedAsBuyer, reputation[pact.buyer].completedAsSeller, reputation[pact.buyer].disputesLost, reputation[pact.buyer].totalVolumeWei);
    emit ReputationUpdated(pact.seller, reputation[pact.seller].completedAsBuyer, reputation[pact.seller].completedAsSeller, reputation[pact.seller].disputesLost, reputation[pact.seller].totalVolumeWei);
    // ── END NEW ──

    // ... existing payout logic unchanged ...
}
```

**Gas impact:** +~40k gas per completion (4 SSTOREs, 2 cold + 2 warm). Acceptable since completions are infrequent high-value operations.

**Coverage:** This is called from three paths:
- `approveWork()` (line 414) — buyer explicitly approves
- `autoApprove()` (line 440) — review period expired
- Both emit `PactCompleted` already, so reputation is always updated on success

---

## Step 3: Update `resolveDispute` to track dispute losses

**File:** `contracts/AgentPact.sol`, lines 485-510

Add reputation penalty for the losing party:

```solidity
function resolveDispute(uint256 pactId, bool sellerWins) external nonReentrant inStatus(pactId, Status.DISPUTED) {
    Pact storage pact = pacts[pactId];
    require(msg.sender == pact.arbitrator, "Not arbitrator");

    if (sellerWins) {
        pact.status = Status.COMPLETED;

        // ── NEW: Buyer lost dispute ──
        reputation[pact.buyer].disputesLost++;
        // Seller still gets completion credit
        reputation[pact.seller].completedAsSeller++;
        reputation[pact.seller].totalVolumeWei += pact.payment;
        emit ReputationUpdated(pact.buyer, ...);
        emit ReputationUpdated(pact.seller, ...);
        // ── END NEW ──

        uint256 sellerPayout = pact.payment + pact.sellerStake + pact.buyerStake;
        (bool sent, ) = pact.seller.call{value: sellerPayout}("");
        require(sent, "Failed to pay seller");
    } else {
        pact.status = Status.REFUNDED;

        // ── NEW: Seller lost dispute ──
        reputation[pact.seller].disputesLost++;
        emit ReputationUpdated(pact.seller, ...);
        // ── END NEW ──

        uint256 buyerRefund = pact.payment + pact.buyerStake + pact.sellerStake;
        (bool sent, ) = pact.buyer.call{value: buyerRefund}("");
        require(sent, "Failed to refund buyer");
    }

    emit DisputeResolved(pactId, sellerWins);
}
```

**Design decision:** When seller wins dispute, seller gets `completedAsSeller++` because they delivered and were vindicated. Buyer gets `disputesLost++` because they wrongly rejected. When buyer wins, only seller gets `disputesLost++` — buyer doesn't get completion credit since they were refunded.

---

## Step 4: Update `claimTimeout` to track seller fault

**File:** `contracts/AgentPact.sol`, lines 516-553

In the `FUNDED/IN_PROGRESS/PENDING_VERIFY` timeout branch (lines 536-549), the seller failed to deliver. Penalize:

```solidity
} else if (
    pact.status == Status.FUNDED ||
    pact.status == Status.IN_PROGRESS ||
    pact.status == Status.PENDING_VERIFY
) {
    pact.status = Status.REFUNDED;

    // ── NEW: Seller timed out → treat as dispute loss ──
    reputation[pact.seller].disputesLost++;
    emit ReputationUpdated(pact.seller, ...);
    // ── END NEW ──

    uint256 buyerRefund = pact.payment + pact.buyerStake + pact.sellerStake;
    // ... existing logic ...
}
```

**Note:** The `NEGOTIATING` timeout (lines 520-535) does NOT penalize anyone — nobody accepted, so no fault.

---

## Step 5: Add `getReputation` view function

**File:** `contracts/AgentPact.sol`, after line 604 (after `getVerification`)

```solidity
function getReputation(address user) external view returns (
    uint256 completedAsBuyer,
    uint256 completedAsSeller,
    uint256 disputesLost,
    uint256 totalVolumeWei
) {
    Reputation storage r = reputation[user];
    return (r.completedAsBuyer, r.completedAsSeller, r.disputesLost, r.totalVolumeWei);
}
```

---

## Step 6: Add ABI entry

**File:** `mcp-server/src/abis.ts`

Add to `AGENT_PACT_ABI` array after the existing view functions (after line 40):

```typescript
"function getReputation(address user) view returns (uint256 completedAsBuyer, uint256 completedAsSeller, uint256 disputesLost, uint256 totalVolumeWei)",

"event ReputationUpdated(address indexed user, uint256 completedAsBuyer, uint256 completedAsSeller, uint256 disputesLost, uint256 totalVolumeWei)",
```

---

## Step 7: Add MCP query tools

**File:** `mcp-server/src/tools/query.ts`

Add two new tools inside `registerQueryTools`:

### Tool: `get-reputation`

```typescript
server.tool(
  "get-reputation",
  "Look up an address's pact history — completions as buyer/seller, disputes lost, total volume",
  { address: z.string().describe("The Ethereum address to check") },
  async ({ address }) => {
    const contract = getAgentPact(config);
    const r = await contract.getReputation(address);
    const total = Number(r.completedAsBuyer) + Number(r.completedAsSeller);
    const disputeRate = total > 0
      ? ((Number(r.disputesLost) / total) * 100).toFixed(1) + "%"
      : "N/A (no pacts)";
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          address,
          completedAsBuyer: Number(r.completedAsBuyer),
          completedAsSeller: Number(r.completedAsSeller),
          totalCompleted: total,
          disputesLost: Number(r.disputesLost),
          disputeRate,
          totalVolume: ethers.formatEther(r.totalVolumeWei) + " ETH",
        }, null, 2),
      }],
    };
  }
);
```

### Tool: `check-counterparty`

```typescript
server.tool(
  "check-counterparty",
  "Before accepting a pact, check the other party's reputation and get a risk assessment",
  { pactId: z.number().int().nonnegative().describe("The pact ID to check the counterparty for") },
  async ({ pactId }) => {
    const contract = getAgentPact(config);
    const wallet = getSigner(config);
    const p = await contract.getPact(pactId);

    // Determine who the counterparty is
    const myAddr = config.safeAddress ?? wallet.address;
    let counterparty: string;
    if (p.buyer.toLowerCase() === myAddr.toLowerCase()) {
      counterparty = p.seller;
    } else if (p.seller.toLowerCase() === myAddr.toLowerCase()) {
      counterparty = p.buyer;
    } else {
      // We're neither party yet — check who initiated
      counterparty = p.initiator === 0n ? p.buyer : p.seller;
    }

    const r = await contract.getReputation(counterparty);
    const total = Number(r.completedAsBuyer) + Number(r.completedAsSeller);
    const disputeRate = total > 0 ? Number(r.disputesLost) / total : 0;

    let risk: string;
    if (total === 0) risk = "UNKNOWN — no pact history";
    else if (disputeRate > 0.3) risk = "HIGH — dispute rate above 30%";
    else if (disputeRate > 0.1) risk = "MEDIUM — dispute rate above 10%";
    else risk = "LOW — good track record";

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          counterparty,
          completedAsBuyer: Number(r.completedAsBuyer),
          completedAsSeller: Number(r.completedAsSeller),
          totalCompleted: total,
          disputesLost: Number(r.disputesLost),
          disputeRate: (disputeRate * 100).toFixed(1) + "%",
          totalVolume: ethers.formatEther(r.totalVolumeWei) + " ETH",
          riskAssessment: risk,
        }, null, 2),
      }],
    };
  }
);
```

---

## Step 8: Tests

**File:** `test/AgentPact.test.ts`

Add a new `describe("Reputation")` block with these test cases:

| Test | What it verifies |
|------|-----------------|
| `starts at zero for all addresses` | `getReputation(addr)` returns all zeros for a fresh address |
| `increments buyer/seller on approveWork` | After full lifecycle → approveWork, both buyer and seller have completedAs* = 1 and volume = payment |
| `increments on autoApprove` | Same as above but via autoApprove path |
| `tracks disputesLost for buyer when seller wins` | resolveDispute(sellerWins=true) → buyer.disputesLost = 1, seller.completedAsSeller = 1 |
| `tracks disputesLost for seller when buyer wins` | resolveDispute(sellerWins=false) → seller.disputesLost = 1, buyer.completedAsBuyer stays 0 |
| `tracks seller timeout as dispute loss` | claimTimeout after deadline → seller.disputesLost = 1 |
| `does not penalize on NEGOTIATING timeout` | claimTimeout on NEGOTIATING pact → no reputation changes |
| `accumulates across multiple pacts` | Complete 3 pacts → counts = 3, volume = 3x payment |
| `emits ReputationUpdated event` | Check event args after completion |

Helper needed: a full-lifecycle helper that goes from create → accept → start → submit → verify → finalize → approve, to avoid repeating setup in each test.

---

## Summary of changes

| File | Lines added (est.) | Type |
|------|-------------------|------|
| `contracts/AgentPact.sol` | ~40 | Struct, mapping, event, updates to 3 functions, view function |
| `mcp-server/src/abis.ts` | ~3 | ABI entries |
| `mcp-server/src/tools/query.ts` | ~70 | Two new MCP tools |
| `test/AgentPact.test.ts` | ~150 | 9 test cases + helper |
| **Total** | **~260 lines** | |

## No changes needed

- `AgentPolicyModule.sol` — reputation is on the pact contract, not the session policy
- `OracleRegistry.sol` — oracle reputation is separate (already has completedVerifications)
- MCP pact tools — no changes needed, `create-pact`/`accept-pact` don't need reputation awareness
