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
      oracleFeeEth: z.string().default("0").describe("Total oracle fee in ETH (split by weight among oracles at verification)"),
      paymentToken: z.string().default("0x0000000000000000000000000000000000000000").describe("ERC-20 token address for payment (default: native ETH, use zero address for ETH)"),
    },
    async ({ role, specHash, deadline, oracles, oracleWeights, threshold, paymentEth, reviewPeriod, oracleFeeEth, paymentToken }) => {
      try {
        const paymentWei = ethers.parseEther(paymentEth);
        const oracleFeeWei = ethers.parseEther(oracleFeeEth);
        const stakeWei = paymentWei / 10n;
        const initiator = role === "buyer" ? 0 : 1;
        const isToken = paymentToken !== ethers.ZeroAddress;

        let depositWei: bigint;
        if (role === "buyer") {
          depositWei = paymentWei + oracleFeeWei + stakeWei;
        } else {
          depositWei = stakeWei;
        }

        // Convert specHash — if it looks like a plain string, hash it
        const specBytes = specHash.startsWith("0x") ? specHash : ethers.keccak256(ethers.toUtf8Bytes(specHash));

        const calldata = agentPactIface.encodeFunctionData("createPact", [
          initiator, specBytes, deadline, oracles, oracleWeights, threshold, paymentWei, reviewPeriod, oracleFeeWei, paymentToken,
        ]);

        // For ERC-20 pacts, no ETH value is sent (tokens are transferred via approve+transferFrom)
        const ethValue = isToken ? 0n : depositWei;
        const receipt = await executor.execute(config.agentPactAddress, ethValue, calldata);

        // Extract pactId from event
        const event = receipt.logs
          .map((log: any) => { try { return agentPactIface.parseLog(log); } catch { return null; } })
          .find((e: any) => e?.name === "PactCreated");
        const pactId = event?.args?.pactId?.toString() ?? "unknown";

        const depositEth = ethers.formatEther(depositWei);
        const unit = isToken ? "tokens" : "ETH";
        const feeDesc = oracleFeeWei > 0n ? ` + ${oracleFeeEth} oracle fee` : "";
        const roleDesc = role === "buyer"
          ? `Deposited: ${depositEth} ${unit} (${paymentEth} payment${feeDesc} + ${ethers.formatEther(stakeWei)} stake). Open for sellers.`
          : `Staked ${depositEth} ${unit}. Listing open for buyers.`;
        const tokenNote = isToken ? `\nPayment token: ${paymentToken}` : "";

        return {
          content: [{
            type: "text" as const,
            text: `Pact #${pactId} created as ${role.toUpperCase()}. ${roleDesc}${tokenNote}\nTx: ${receipt.hash}`,
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
        const isToken = p.paymentToken !== ethers.ZeroAddress;

        let depositWei: bigint;
        let roleAssigned: string;

        const oracleFeeWei = p.oracleFee as bigint;

        if (initiator === 0) {
          // Buyer created → we become seller, deposit seller stake
          depositWei = stakeWei;
          roleAssigned = "SELLER";
        } else {
          // Seller created → we become buyer, deposit payment + oracle fee + buyer stake
          depositWei = paymentWei + oracleFeeWei + stakeWei;
          roleAssigned = "BUYER";
        }

        const calldata = agentPactIface.encodeFunctionData("acceptPact", [pactId]);
        // For ERC-20 pacts, no ETH value is sent
        const ethValue = isToken ? 0n : depositWei;
        const receipt = await executor.execute(config.agentPactAddress, ethValue, calldata);

        const unit = isToken ? "tokens" : "ETH";
        const tokenNote = isToken ? ` (token: ${p.paymentToken})` : "";

        return {
          content: [{
            type: "text" as const,
            text: `Accepted pact #${pactId} as ${roleAssigned}. Deposited ${ethers.formatEther(depositWei)} ${unit}${tokenNote}.\nTx: ${receipt.hash}`,
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
