import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { SafeExecutor } from "../wallet/safe-executor.js";
import { AGENT_PACT_ABI } from "../abis.js";

const agentPactIface = new ethers.Interface(AGENT_PACT_ABI);

export function registerFinalizeTools(server: McpServer, config: Config, executor: SafeExecutor) {
  server.tool(
    "finalize-verification",
    "Trigger final score calculation. If score passes threshold, moves to PENDING_APPROVAL for buyer review.",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const calldata = agentPactIface.encodeFunctionData("finalizeVerification", [pactId]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        // Check which event was emitted to determine result
        const events = receipt.logs
          .map((log: any) => { try { return agentPactIface.parseLog(log); } catch { return null; } })
          .filter(Boolean);

        const finalized = events.find((e: any) => e?.name === "VerificationFinalized");
        const score = finalized?.args?.weightedScore?.toString() ?? "?";
        const newStatus = Number(finalized?.args?.newStatus ?? 0);

        const statusName = newStatus === 7 ? "PENDING_APPROVAL" : newStatus === 5 ? "DISPUTED" : `status(${newStatus})`;

        return {
          content: [{
            type: "text" as const,
            text: `Verification finalized for pact #${pactId}. Weighted score: ${score}/100. Status: ${statusName}.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error finalizing verification: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
