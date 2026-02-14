import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { SafeExecutor } from "../wallet/safe-executor.js";
import { AGENT_PACT_ABI } from "../abis.js";

const agentPactIface = new ethers.Interface(AGENT_PACT_ABI);

export function registerApprovalTools(server: McpServer, config: Config, executor: SafeExecutor) {
  server.tool(
    "approve-work",
    "Buyer approves delivered work after oracle verification passes. Releases payment to seller.",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const calldata = agentPactIface.encodeFunctionData("approveWork", [pactId]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Pact #${pactId} approved. Payment released to seller, buyer stake returned. Status: COMPLETED.\nTx: ${receipt.hash}`,
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
        const calldata = agentPactIface.encodeFunctionData("rejectWork", [pactId]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Pact #${pactId} rejected. Status: DISPUTED. Set an arbitrator to resolve.\nTx: ${receipt.hash}`,
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
        const calldata = agentPactIface.encodeFunctionData("autoApprove", [pactId]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Review period expired. Pact #${pactId} auto-approved. Payment released to seller.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error auto-approving: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
