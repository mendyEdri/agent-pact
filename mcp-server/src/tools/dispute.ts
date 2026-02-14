import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { SafeExecutor } from "../wallet/safe-executor.js";
import { AGENT_PACT_ABI } from "../abis.js";

const agentPactIface = new ethers.Interface(AGENT_PACT_ABI);

export function registerDisputeTools(server: McpServer, config: Config, executor: SafeExecutor) {
  server.tool(
    "raise-dispute",
    "Raise a dispute on an active pact (buyer or seller only)",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
      arbitrator: z.string().describe("Arbitrator address to resolve the dispute"),
    },
    async ({ pactId, arbitrator }) => {
      try {
        const calldata = agentPactIface.encodeFunctionData("raiseDispute", [pactId, arbitrator]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Dispute raised on pact #${pactId}. Arbitrator: ${arbitrator}. Status: DISPUTED.\nTx: ${receipt.hash}`,
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
        const calldata = agentPactIface.encodeFunctionData("resolveDispute", [pactId, sellerWins]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        const winner = sellerWins ? "seller" : "buyer";

        return {
          content: [{
            type: "text" as const,
            text: `Dispute resolved for pact #${pactId}. Winner: ${winner}. Funds released.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error resolving dispute: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
