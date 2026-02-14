import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Config } from "../config.js";
import { getAgentPact } from "../contracts.js";

export function registerFinalizeTools(server: McpServer, config: Config) {
  server.tool(
    "finalize-verification",
    "Trigger final score calculation. If score passes threshold, moves to PENDING_APPROVAL for buyer review.",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const contract = getAgentPact(config);
        const tx = await contract.finalizeVerification(pactId);
        const receipt = await tx.wait();

        // Check which event was emitted to determine result
        const events = receipt.logs
          .map((log: any) => { try { return contract.interface.parseLog(log); } catch { return null; } })
          .filter(Boolean);

        const finalized = events.find((e: any) => e?.name === "VerificationFinalized");
        const score = finalized?.args?.weightedScore?.toString() ?? "?";
        const newStatus = Number(finalized?.args?.newStatus ?? 0);

        const statusName = newStatus === 7 ? "PENDING_APPROVAL" : newStatus === 5 ? "DISPUTED" : `status(${newStatus})`;

        return {
          content: [{
            type: "text" as const,
            text: `Verification finalized for pact #${pactId}. Weighted score: ${score}/100. Status: ${statusName}.\nTx: ${tx.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error finalizing verification: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
