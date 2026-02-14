import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Config } from "../config.js";
import { getAgentPact } from "../contracts.js";

export function registerDisputeTools(server: McpServer, config: Config) {
  server.tool(
    "raise-dispute",
    "Raise a dispute on an active pact (buyer or seller only)",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
      arbitrator: z.string().describe("Arbitrator address to resolve the dispute"),
    },
    async ({ pactId, arbitrator }) => {
      try {
        const contract = getAgentPact(config);
        const tx = await contract.raiseDispute(pactId, arbitrator);
        await tx.wait();

        return {
          content: [{
            type: "text" as const,
            text: `Dispute raised on pact #${pactId}. Arbitrator: ${arbitrator}. Status: DISPUTED.\nTx: ${tx.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error raising dispute: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "resolve-dispute",
    "Resolve a dispute (arbitrator only)",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
      sellerWins: z.boolean().describe("true = seller wins (gets all funds), false = buyer wins (gets refund)"),
    },
    async ({ pactId, sellerWins }) => {
      try {
        const contract = getAgentPact(config);
        const tx = await contract.resolveDispute(pactId, sellerWins);
        await tx.wait();

        const winner = sellerWins ? "seller" : "buyer";

        return {
          content: [{
            type: "text" as const,
            text: `Dispute resolved for pact #${pactId}. Winner: ${winner}. Funds released.\nTx: ${tx.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error resolving dispute: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
