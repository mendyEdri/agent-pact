import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { getAgentPact } from "../contracts.js";
import { getSigner } from "../provider.js";

const STATUS_NAMES = [
  "NEGOTIATING",
  "FUNDED",
  "IN_PROGRESS",
  "PENDING_VERIFY",
  "COMPLETED",
  "DISPUTED",
  "REFUNDED",
  "PENDING_APPROVAL",
] as const;

const INITIATOR_NAMES = ["BUYER", "SELLER"] as const;

export function registerQueryTools(server: McpServer, config: Config) {
  server.tool(
    "get-pact",
    "Get full details of a pact by ID",
    { pactId: z.number().int().nonnegative().describe("The pact ID") },
    async ({ pactId }) => {
      try {
        const contract = getAgentPact(config);
        const p = await contract.getPact(pactId);
        const [oracles, weights] = await contract.getPactOracles(pactId);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              pactId,
              buyer: p.buyer,
              seller: p.seller,
              payment: ethers.formatEther(p.payment) + " ETH",
              deadline: new Date(Number(p.deadline_) * 1000).toISOString(),
              status: STATUS_NAMES[Number(p.status)] ?? `UNKNOWN(${p.status})`,
              specHash: p.specHash,
              verificationThreshold: Number(p.verificationThreshold),
              buyerStake: ethers.formatEther(p.buyerStake) + " ETH",
              sellerStake: ethers.formatEther(p.sellerStake) + " ETH",
              initiator: INITIATOR_NAMES[Number(p.initiator)] ?? "UNKNOWN",
              reviewPeriod: Number(p.reviewPeriod) + " seconds",
              verifiedAt: Number(p.verifiedAt) > 0
                ? new Date(Number(p.verifiedAt) * 1000).toISOString()
                : "not yet verified",
              oracles: oracles.map((addr: string, i: number) => ({
                address: addr,
                weight: Number(weights[i]),
              })),
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-verification",
    "Get verification details for an oracle on a pact",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
      oracle: z.string().describe("Oracle address"),
    },
    async ({ pactId, oracle }) => {
      try {
        const contract = getAgentPact(config);
        const v = await contract.getVerification(pactId, oracle);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              pactId,
              oracle,
              score: Number(v.score),
              hasSubmitted: v.hasSubmitted,
              proof: v.proof,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-my-address",
    "Get the connected wallet address and ETH balance",
    {},
    async () => {
      try {
        const wallet = getSigner(config);
        const balance = await wallet.provider!.getBalance(wallet.address);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address: wallet.address,
              balance: ethers.formatEther(balance) + " ETH",
              safeAddress: config.safeAddress,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-pact-count",
    "Get the total number of pacts created",
    {},
    async () => {
      try {
        const contract = getAgentPact(config);
        const count = await contract.nextPactId();

        return {
          content: [{
            type: "text" as const,
            text: `Total pacts created: ${count}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
