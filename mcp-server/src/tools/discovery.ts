import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { getAgentPact, getOracleRegistry } from "../contracts.js";
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

export function registerDiscoveryTools(server: McpServer, config: Config) {
  server.tool(
    "list-open-pacts",
    "List pacts currently open for acceptance (NEGOTIATING status). Shows buyer requests and seller listings.",
    {
      offset: z.number().int().nonnegative().default(0).describe("Pagination offset"),
      limit: z.number().int().positive().default(20).describe("Max results to return"),
    },
    async ({ offset, limit }) => {
      try {
        const contract = getAgentPact(config);
        const total = Number(await contract.getOpenPactCount());
        const pactIds: bigint[] = await contract.getOpenPacts(offset, limit);

        const pacts = await Promise.all(
          pactIds.map(async (id) => {
            const p = await contract.getPact(id);
            const isToken = p.paymentToken !== ethers.ZeroAddress;
            const unit = isToken ? `tokens (${p.paymentToken})` : "ETH";
            return {
              pactId: Number(id),
              type: INITIATOR_NAMES[Number(p.initiator)] === "BUYER" ? "REQUEST (buyer seeking seller)" : "LISTING (seller offering service)",
              payment: ethers.formatEther(p.payment) + ` ${unit}`,
              oracleFee: ethers.formatEther(p.oracleFee) + ` ${unit}`,
              paymentToken: isToken ? p.paymentToken : "ETH (native)",
              deadline: new Date(Number(p.deadline_) * 1000).toISOString(),
              specHash: p.specHash,
              creator: p.initiator === 0n ? p.buyer : p.seller,
            };
          })
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              totalOpen: total,
              showing: `${offset}–${offset + pacts.length} of ${total}`,
              pacts,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "my-pacts",
    "List all pacts where your Safe/wallet is a buyer or seller",
    {
      offset: z.number().int().nonnegative().default(0).describe("Pagination offset"),
      limit: z.number().int().positive().default(20).describe("Max results to return"),
    },
    async ({ offset, limit }) => {
      try {
        const contract = getAgentPact(config);
        const wallet = getSigner(config);
        const myAddr = config.safeAddress ?? wallet.address;

        const total = Number(await contract.getUserPactCount(myAddr));
        const pactIds: bigint[] = await contract.getPactsByAddress(myAddr, offset, limit);

        const pacts = await Promise.all(
          pactIds.map(async (id) => {
            const p = await contract.getPact(id);
            const isBuyer = p.buyer.toLowerCase() === myAddr.toLowerCase();
            const isToken = p.paymentToken !== ethers.ZeroAddress;
            const unit = isToken ? "tokens" : "ETH";
            return {
              pactId: Number(id),
              role: isBuyer ? "BUYER" : "SELLER",
              counterparty: isBuyer ? p.seller : p.buyer,
              payment: ethers.formatEther(p.payment) + ` ${unit}`,
              paymentToken: isToken ? p.paymentToken : "ETH (native)",
              status: STATUS_NAMES[Number(p.status)] ?? `UNKNOWN(${p.status})`,
              deadline: new Date(Number(p.deadline_) * 1000).toISOString(),
            };
          })
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address: myAddr,
              totalPacts: total,
              showing: `${offset}–${offset + pacts.length} of ${total}`,
              pacts,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "find-oracles",
    "Search for registered oracles by capability (e.g. 'code-review', 'testing')",
    {
      capability: z.string().describe("The capability to search for"),
    },
    async ({ capability }) => {
      try {
        const registry = getOracleRegistry(config);
        const addresses: string[] = await registry.getOraclesByCapability(capability);

        const oracles = await Promise.all(
          addresses.map(async (addr: string) => {
            const stake = await registry.getOracleStake(addr);
            const caps = await registry.getOracleCapabilities(addr);
            return {
              address: addr,
              stake: ethers.formatEther(stake) + " ETH",
              capabilities: caps,
            };
          })
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              capability,
              matchCount: oracles.length,
              oracles,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
