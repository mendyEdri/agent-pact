import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { getAgentPact } from "../contracts.js";
import { SafeExecutor } from "../wallet/safe-executor.js";
import { AGENT_PACT_ABI } from "../abis.js";

const agentPactIface = new ethers.Interface(AGENT_PACT_ABI);

export function registerNegotiateTools(server: McpServer, config: Config, executor: SafeExecutor) {
  server.tool(
    "propose-amendment",
    "Propose modified terms for a pact in NEGOTIATING status. Creates an on-chain counter-offer.",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
      paymentEth: z.string().nullable().default(null).describe("New payment amount in ETH (e.g. '0.4'), or null to keep current"),
      deadline: z.number().int().nullable().default(null).describe("New deadline as Unix timestamp, or null to keep current"),
      specHash: z.string().nullable().default(null).describe("New spec hash, or null to keep current"),
    },
    async ({ pactId, paymentEth, deadline, specHash }) => {
      try {
        const newPayment = paymentEth ? ethers.parseEther(paymentEth) : 0n;
        const newDeadline = deadline ?? 0;
        const newSpec = specHash
          ? (specHash.startsWith("0x") ? specHash : ethers.keccak256(ethers.toUtf8Bytes(specHash)))
          : ethers.ZeroHash;

        const calldata = agentPactIface.encodeFunctionData("proposeAmendment", [pactId, newPayment, newDeadline, newSpec]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        const changes: string[] = [];
        if (paymentEth) changes.push(`payment → ${paymentEth} ETH`);
        if (deadline) changes.push(`deadline → ${new Date(deadline * 1000).toISOString()}`);
        if (specHash) changes.push(`spec updated`);
        if (changes.length === 0) changes.push("no changes (keep current terms)");

        return {
          content: [{
            type: "text" as const,
            text: `Amendment proposed for pact #${pactId}: ${changes.join(", ")}. Waiting for counterparty.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error proposing amendment: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "accept-amendment",
    "Accept the pending counter-offer on a pact. Updates the pact terms.",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const contract = getAgentPact(config);

        // Read current pact and amendment to determine if extra ETH is needed
        const p = await contract.getPact(pactId);
        const a = await contract.getAmendment(pactId);

        let value = 0n;
        const oldPayment = p.payment as bigint;
        const newPayment = a.payment as bigint;

        if (newPayment > oldPayment) {
          // Payment increased — caller may need to send additional ETH
          const extra = newPayment - oldPayment;
          const extraStake = extra / 10n;
          value = extra + extraStake;
        }

        const calldata = agentPactIface.encodeFunctionData("acceptAmendment", [pactId]);
        const receipt = await executor.execute(config.agentPactAddress, value, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Amendment accepted for pact #${pactId}. Terms updated: payment=${ethers.formatEther(newPayment)} ETH.${value > 0n ? ` Additional ${ethers.formatEther(value)} ETH deposited.` : ""}\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error accepting amendment: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-amendment",
    "Get the current pending amendment on a pact (read-only)",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const contract = getAgentPact(config);
        const a = await contract.getAmendment(pactId);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              pactId,
              payment: ethers.formatEther(a.payment) + " ETH",
              deadline: Number(a.deadline_) > 0
                ? new Date(Number(a.deadline_) * 1000).toISOString()
                : "unchanged",
              specHash: a.specHash,
              proposedBy: a.proposedBy,
              pending: a.pending,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
