import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { getAgentPact } from "../contracts.js";
import { SafeExecutor } from "../wallet/safe-executor.js";
import { AGENT_PACT_ABI } from "../abis.js";

const agentPactIface = new ethers.Interface(AGENT_PACT_ABI);

export function registerPactTools(server: McpServer, config: Config, executor: SafeExecutor) {
  server.tool(
    "create-pact",
    "Create a new pact — works for both buyer-initiated (request for work) and seller-initiated (offer/listing) flows",
    {
      role: z.enum(["buyer", "seller"]).describe("Who is creating this pact: 'buyer' (request for work) or 'seller' (offer/listing)"),
      specHash: z.string().describe("IPFS hash or bytes32 hex of the work/service specification"),
      deadline: z.number().int().positive().describe("Unix timestamp deadline"),
      oracles: z.array(z.string()).min(1).describe("Oracle addresses for verification"),
      oracleWeights: z.array(z.number().int().min(1).max(100)).min(1).describe("Weight per oracle (must sum to 100)"),
      threshold: z.number().int().min(0).max(100).describe("Minimum weighted score to pass (0-100)"),
      paymentEth: z.string().describe("Payment amount in ETH (e.g. '0.5')"),
      reviewPeriod: z.number().int().min(0).default(0).describe("Buyer review window in seconds (default: 3 days)"),
    },
    async ({ role, specHash, deadline, oracles, oracleWeights, threshold, paymentEth, reviewPeriod }) => {
      try {
        const paymentWei = ethers.parseEther(paymentEth);
        const stakeWei = paymentWei / 10n;
        const initiator = role === "buyer" ? 0 : 1;

        let depositWei: bigint;
        if (role === "buyer") {
          depositWei = paymentWei + stakeWei;
        } else {
          depositWei = stakeWei;
        }

        // Convert specHash — if it looks like a plain string, hash it
        const specBytes = specHash.startsWith("0x") ? specHash : ethers.keccak256(ethers.toUtf8Bytes(specHash));

        const calldata = agentPactIface.encodeFunctionData("createPact", [
          initiator, specBytes, deadline, oracles, oracleWeights, threshold, paymentWei, reviewPeriod,
        ]);

        const receipt = await executor.execute(config.agentPactAddress, depositWei, calldata);

        // Extract pactId from event
        const event = receipt.logs
          .map((log: any) => { try { return agentPactIface.parseLog(log); } catch { return null; } })
          .find((e: any) => e?.name === "PactCreated");
        const pactId = event?.args?.pactId?.toString() ?? "unknown";

        const depositEth = ethers.formatEther(depositWei);
        const roleDesc = role === "buyer"
          ? `Deposited: ${depositEth} ETH (${paymentEth} payment + ${ethers.formatEther(stakeWei)} stake). Open for sellers.`
          : `Staked ${depositEth} ETH. Listing open for buyers.`;

        return {
          content: [{
            type: "text" as const,
            text: `Pact #${pactId} created as ${role.toUpperCase()}. ${roleDesc}\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error creating pact: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "accept-pact",
    "Accept an open pact. Automatically detects whether you're joining as buyer or seller based on who created it.",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID to accept"),
    },
    async ({ pactId }) => {
      try {
        const contract = getAgentPact(config);
        const p = await contract.getPact(pactId);
        const initiator = Number(p.initiator);
        const paymentWei = p.payment as bigint;
        const stakeWei = paymentWei / 10n;

        let depositWei: bigint;
        let roleAssigned: string;

        if (initiator === 0) {
          // Buyer created → we become seller, deposit seller stake
          depositWei = stakeWei;
          roleAssigned = "SELLER";
        } else {
          // Seller created → we become buyer, deposit payment + buyer stake
          depositWei = paymentWei + stakeWei;
          roleAssigned = "BUYER";
        }

        const calldata = agentPactIface.encodeFunctionData("acceptPact", [pactId]);
        const receipt = await executor.execute(config.agentPactAddress, depositWei, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Accepted pact #${pactId} as ${roleAssigned}. Deposited ${ethers.formatEther(depositWei)} ETH.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error accepting pact: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "claim-timeout",
    "Claim refund when deadline passes without completion",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
    },
    async ({ pactId }) => {
      try {
        const calldata = agentPactIface.encodeFunctionData("claimTimeout", [pactId]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Timeout claimed for pact #${pactId}. Funds refunded.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error claiming timeout: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
