import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Config } from "../config.js";
import { getAgentPact } from "../contracts.js";

export function registerApprovalTools(server: McpServer, config: Config) {
  server.tool(
    "approve-work",
    "Buyer approves delivered work after oracle verification passes. Releases payment to seller.",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const contract = getAgentPact(config);
        const tx = await contract.approveWork(pactId);
        await tx.wait();

        return {
          content: [{
            type: "text" as const,
            text: `Pact #${pactId} approved. Payment released to seller, buyer stake returned. Status: COMPLETED.\nTx: ${tx.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error approving work: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "reject-work",
    "Buyer rejects delivered work after oracle verification. Triggers dispute.",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const contract = getAgentPact(config);
        const tx = await contract.rejectWork(pactId);
        await tx.wait();

        return {
          content: [{
            type: "text" as const,
            text: `Pact #${pactId} rejected. Status: DISPUTED. Set an arbitrator to resolve.\nTx: ${tx.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error rejecting work: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "auto-approve",
    "Anyone can call this after the review period expires to release payment. Prevents buyer from holding funds hostage.",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const contract = getAgentPact(config);
        const tx = await contract.autoApprove(pactId);
        await tx.wait();

        return {
          content: [{
            type: "text" as const,
            text: `Review period expired. Pact #${pactId} auto-approved. Payment released to seller.\nTx: ${tx.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error auto-approving: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
