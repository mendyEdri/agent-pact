import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { getAgentPact } from "../contracts.js";

export function registerWorkTools(server: McpServer, config: Config) {
  server.tool(
    "start-work",
    "Signal that work has begun on a pact (seller only)",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const contract = getAgentPact(config);
        const tx = await contract.startWork(pactId);
        await tx.wait();

        return {
          content: [{
            type: "text" as const,
            text: `Work started on pact #${pactId}. Status: IN_PROGRESS.\nTx: ${tx.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error starting work: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "submit-work",
    "Submit completed work with proof hash (seller only)",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
      proofHash: z.string().describe("Hash of the work deliverable (bytes32 hex or plain string to hash)"),
    },
    async ({ pactId, proofHash }) => {
      try {
        const contract = getAgentPact(config);
        const proofBytes = proofHash.startsWith("0x") ? proofHash : ethers.keccak256(ethers.toUtf8Bytes(proofHash));

        const tx = await contract.submitWork(pactId, proofBytes);
        await tx.wait();

        return {
          content: [{
            type: "text" as const,
            text: `Work submitted for pact #${pactId}. Proof: ${proofBytes}. Status: PENDING_VERIFY. Awaiting oracle verification.\nTx: ${tx.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error submitting work: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
