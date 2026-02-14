import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { getAgentPact, getOracleRegistry } from "../contracts.js";
import { PolicyChecker } from "../wallet/policy.js";

export function registerOracleTools(server: McpServer, config: Config, policy: PolicyChecker) {
  server.tool(
    "register-oracle",
    "Register as a verification oracle with stake and capabilities",
    {
      capabilities: z.array(z.string()).min(1).describe("List of capabilities (e.g. ['code-review', 'testing'])"),
      stakeEth: z.string().describe("Stake amount in ETH"),
    },
    async ({ capabilities, stakeEth }) => {
      try {
        const registry = getOracleRegistry(config);
        const stakeWei = ethers.parseEther(stakeEth);

        const policyErr = policy.check(stakeWei);
        if (policyErr) {
          return { content: [{ type: "text" as const, text: policyErr }], isError: true };
        }

        const tx = await registry.registerOracle(capabilities, { value: stakeWei });
        await tx.wait();

        policy.record(stakeWei);

        return {
          content: [{
            type: "text" as const,
            text: `Registered as oracle. Staked ${stakeEth} ETH. Capabilities: ${capabilities.join(", ")}.\nTx: ${tx.hash}`,
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
        const contract = getAgentPact(config);
        const proofBytes = proof.startsWith("0x") ? proof : ethers.keccak256(ethers.toUtf8Bytes(proof));

        const tx = await contract.submitVerification(pactId, score, proofBytes);
        await tx.wait();

        return {
          content: [{
            type: "text" as const,
            text: `Verification submitted for pact #${pactId}. Score: ${score}/100. Proof: ${proofBytes}.\nTx: ${tx.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error submitting verification: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
