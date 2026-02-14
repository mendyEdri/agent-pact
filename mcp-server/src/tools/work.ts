import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { SafeExecutor } from "../wallet/safe-executor.js";
import { AGENT_PACT_ABI } from "../abis.js";

const agentPactIface = new ethers.Interface(AGENT_PACT_ABI);

export function registerWorkTools(server: McpServer, config: Config, executor: SafeExecutor) {
  server.tool(
    "start-work",
    "Signal that work has begun on a pact (seller only)",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const calldata = agentPactIface.encodeFunctionData("startWork", [pactId]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Work started on pact #${pactId}. Status: IN_PROGRESS.\nTx: ${receipt.hash}`,
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
        const proofBytes = proofHash.startsWith("0x") ? proofHash : ethers.keccak256(ethers.toUtf8Bytes(proofHash));

        const calldata = agentPactIface.encodeFunctionData("submitWork", [pactId, proofBytes]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Work submitted for pact #${pactId}. Proof: ${proofBytes}. Status: PENDING_VERIFY. Awaiting oracle verification.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error submitting work: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
