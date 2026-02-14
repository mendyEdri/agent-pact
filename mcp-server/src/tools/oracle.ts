import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { SafeExecutor } from "../wallet/safe-executor.js";
import { AGENT_PACT_ABI, ORACLE_REGISTRY_ABI } from "../abis.js";

const agentPactIface = new ethers.Interface(AGENT_PACT_ABI);
const oracleRegistryIface = new ethers.Interface(ORACLE_REGISTRY_ABI);

export function registerOracleTools(server: McpServer, config: Config, executor: SafeExecutor) {
  server.tool(
    "register-oracle",
    "Register as a verification oracle with stake and capabilities",
    {
      capabilities: z.array(z.string()).min(1).describe("List of capabilities (e.g. ['code-review', 'testing'])"),
      stakeEth: z.string().describe("Stake amount in ETH"),
    },
    async ({ capabilities, stakeEth }) => {
      try {
        const stakeWei = ethers.parseEther(stakeEth);

        const calldata = oracleRegistryIface.encodeFunctionData("registerOracle", [capabilities]);
        const receipt = await executor.execute(config.oracleRegistryAddress, stakeWei, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Registered as oracle. Staked ${stakeEth} ETH. Capabilities: ${capabilities.join(", ")}.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error registering oracle: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "submit-verification",
    "Submit a verification score for submitted work (oracle only)",
    {
      pactId: z.number().int().nonnegative().describe("The pact ID"),
      score: z.number().int().min(0).max(100).describe("Score 0-100"),
      proof: z.string().describe("Proof hash (bytes32 hex or plain string to hash)"),
    },
    async ({ pactId, score, proof }) => {
      try {
        const proofBytes = proof.startsWith("0x") ? proof : ethers.keccak256(ethers.toUtf8Bytes(proof));

        const calldata = agentPactIface.encodeFunctionData("submitVerification", [pactId, score, proofBytes]);
        const receipt = await executor.execute(config.agentPactAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Verification submitted for pact #${pactId}. Score: ${score}/100. Proof: ${proofBytes}.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error submitting verification: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
