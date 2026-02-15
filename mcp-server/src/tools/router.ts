import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { SafeExecutor } from "../wallet/safe-executor.js";
import { ORACLE_ROUTER_ABI, AGENT_PACT_ABI } from "../abis.js";

const routerIface = new ethers.Interface(ORACLE_ROUTER_ABI);

function categoryHash(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

export function registerRouterTools(server: McpServer, config: Config, executor: SafeExecutor) {
  // ──────────────────────────────────────────────
  // Validator Registration
  // ──────────────────────────────────────────────

  server.tool(
    "router-register-validator",
    "Register as a validator oracle with the OracleRouter. Stake ETH and declare categories you can verify.",
    {
      categories: z.array(z.string()).min(1).describe("Categories this validator handles (e.g. ['code-review', 'flight-booking', 'on-chain-verification'])"),
      endpoint: z.string().describe("Webhook URL for off-chain job notifications"),
      stakeEth: z.string().describe("Stake amount in ETH"),
    },
    async ({ categories, endpoint, stakeEth }) => {
      try {
        const stakeWei = ethers.parseEther(stakeEth);
        const categoryHashes = categories.map(categoryHash);

        const calldata = routerIface.encodeFunctionData("registerValidator", [categoryHashes, endpoint]);
        const receipt = await executor.execute(config.oracleRouterAddress, stakeWei, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Registered as validator. Staked ${stakeEth} ETH.\nCategories: ${categories.join(", ")}\nEndpoint: ${endpoint}\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "router-deactivate-validator",
    "Deactivate validator registration and withdraw stake",
    {},
    async () => {
      try {
        const calldata = routerIface.encodeFunctionData("deactivateValidator", []);
        const receipt = await executor.execute(config.oracleRouterAddress, 0n, calldata);
        return {
          content: [{ type: "text" as const, text: `Validator deactivated. Stake returned.\nTx: ${receipt.hash}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  // ──────────────────────────────────────────────
  // Job Request (buyer/seller side)
  // ──────────────────────────────────────────────

  server.tool(
    "router-request-verification",
    "Request verification for a pact through the OracleRouter. Sends a fee to incentivize validators.",
    {
      pactId: z.number().int().nonneg().describe("The pact ID to verify"),
      category: z.string().describe("Verification category (e.g. 'code-review', 'flight-booking')"),
      specHash: z.string().describe("Hash of the verification spec (bytes32 hex or plain text to hash)"),
      feeEth: z.string().describe("Fee to pay for verification (in ETH)"),
    },
    async ({ pactId, category, specHash, feeEth }) => {
      try {
        const feeWei = ethers.parseEther(feeEth);
        const catHash = categoryHash(category);
        const spec = specHash.startsWith("0x") ? specHash : ethers.keccak256(ethers.toUtf8Bytes(specHash));

        const calldata = routerIface.encodeFunctionData("requestVerification", [
          config.agentPactAddress,
          pactId,
          catHash,
          spec,
          ethers.ZeroAddress, // ETH payment
        ]);
        const receipt = await executor.execute(config.oracleRouterAddress, feeWei, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Verification requested for pact #${pactId}.\nCategory: ${category}\nFee: ${feeEth} ETH\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  // ──────────────────────────────────────────────
  // Job Claim & Submit (validator side)
  // ──────────────────────────────────────────────

  server.tool(
    "router-claim-job",
    "Claim an open verification job as a validator. You must be registered for the job's category.",
    {
      jobId: z.number().int().nonneg().describe("The job ID to claim"),
    },
    async ({ jobId }) => {
      try {
        const calldata = routerIface.encodeFunctionData("claimJob", [jobId]);
        const receipt = await executor.execute(config.oracleRouterAddress, 0n, calldata);
        return {
          content: [{ type: "text" as const, text: `Claimed job #${jobId}.\nTx: ${receipt.hash}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "router-submit-validation",
    "Submit verification result for a claimed job. The router forwards the score to AgentPact.",
    {
      jobId: z.number().int().nonneg().describe("The job ID"),
      score: z.number().int().min(0).max(100).describe("Score 0-100"),
      proof: z.string().describe("Proof hash (bytes32 hex or plain text to hash)"),
    },
    async ({ jobId, score, proof }) => {
      try {
        const proofBytes = proof.startsWith("0x") ? proof : ethers.keccak256(ethers.toUtf8Bytes(proof));

        const calldata = routerIface.encodeFunctionData("submitValidation", [jobId, score, proofBytes]);
        const receipt = await executor.execute(config.oracleRouterAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Validation submitted for job #${jobId}. Score: ${score}/100.\nProof: ${proofBytes}\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  // ──────────────────────────────────────────────
  // Earnings
  // ──────────────────────────────────────────────

  server.tool(
    "router-claim-earnings",
    "Claim accumulated validator earnings from the router",
    {},
    async () => {
      try {
        const calldata = routerIface.encodeFunctionData("claimEarnings", [ethers.ZeroAddress]);
        const receipt = await executor.execute(config.oracleRouterAddress, 0n, calldata);
        return {
          content: [{ type: "text" as const, text: `Earnings claimed.\nTx: ${receipt.hash}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  // ──────────────────────────────────────────────
  // Job Management
  // ──────────────────────────────────────────────

  server.tool(
    "router-expire-job",
    "Mark a job as expired if the assigned validator didn't respond in time. Anyone can call this.",
    {
      jobId: z.number().int().nonneg().describe("The job ID to expire"),
    },
    async ({ jobId }) => {
      try {
        const calldata = routerIface.encodeFunctionData("expireJob", [jobId]);
        const receipt = await executor.execute(config.oracleRouterAddress, 0n, calldata);
        return {
          content: [{ type: "text" as const, text: `Job #${jobId} expired. Reassignable.\nTx: ${receipt.hash}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "router-cancel-job",
    "Cancel a verification job and get the fee refunded (requester or owner only)",
    {
      jobId: z.number().int().nonneg().describe("The job ID to cancel"),
    },
    async ({ jobId }) => {
      try {
        const calldata = routerIface.encodeFunctionData("cancelJob", [jobId]);
        const receipt = await executor.execute(config.oracleRouterAddress, 0n, calldata);
        return {
          content: [{ type: "text" as const, text: `Job #${jobId} cancelled. Fee refunded.\nTx: ${receipt.hash}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}

// ──────────────────────────────────────────────
// Read-only query tools (no executor needed)
// ──────────────────────────────────────────────

export function registerRouterQueryTools(server: McpServer, config: Config) {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const router = new ethers.Contract(config.oracleRouterAddress, ORACLE_ROUTER_ABI, provider);

  server.tool(
    "router-get-job",
    "Get details of a verification job",
    {
      jobId: z.number().int().nonneg().describe("The job ID"),
    },
    async ({ jobId }) => {
      try {
        const j = await router.getJob(jobId);
        const statusNames = ["OPEN", "ASSIGNED", "COMPLETED", "EXPIRED", "CANCELLED"];
        return {
          content: [{
            type: "text" as const,
            text: [
              `Job #${jobId}:`,
              `  Pact ID: ${j.pactId}`,
              `  Category: ${j.category}`,
              `  Status: ${statusNames[j.status] ?? j.status}`,
              `  Assigned to: ${j.assignedValidator === ethers.ZeroAddress ? "(unassigned)" : j.assignedValidator}`,
              `  Fee: ${ethers.formatEther(j.fee)} ETH`,
              `  Score: ${j.score}/100`,
              `  Deadline: ${new Date(Number(j.deadline) * 1000).toISOString()}`,
            ].join("\n"),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "router-get-validator",
    "Get validator info including reputation",
    {
      address: z.string().describe("Validator address"),
    },
    async ({ address }) => {
      try {
        const v = await router.getValidatorInfo(address);
        const cats = await router.getValidatorCategories(address);
        const earnings = await router.pendingEarnings(address, ethers.ZeroAddress);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Validator ${address}:`,
              `  Active: ${v.isActive}`,
              `  Stake: ${ethers.formatEther(v.stake)} ETH`,
              `  Completed: ${v.completedJobs}`,
              `  Failed: ${v.failedJobs}`,
              `  Total earned: ${ethers.formatEther(v.totalEarned)} ETH`,
              `  Pending earnings: ${ethers.formatEther(earnings)} ETH`,
              `  Endpoint: ${v.endpoint}`,
              `  Categories: ${cats.length} registered`,
            ].join("\n"),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "router-find-validators",
    "Find validators available for a specific category",
    {
      category: z.string().describe("Category name (e.g. 'code-review')"),
    },
    async ({ category }) => {
      try {
        const catHash = ethers.keccak256(ethers.toUtf8Bytes(category));
        const result = await router.getValidatorsForCategory(catHash);
        const [addresses, stakes, completed, failed] = result;

        if (addresses.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No validators found for category "${category}".` }],
          };
        }

        const best = await router.getBestValidator(catHash);

        const lines = [`Validators for "${category}" (${addresses.length} found):`];
        for (let i = 0; i < addresses.length; i++) {
          const isBest = addresses[i] === best;
          lines.push(
            `  ${isBest ? "* " : "  "}${addresses[i]} — stake: ${ethers.formatEther(stakes[i])} ETH, completed: ${completed[i]}, failed: ${failed[i]}${isBest ? " (RECOMMENDED)" : ""}`
          );
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "router-stats",
    "Get OracleRouter statistics",
    {},
    async () => {
      try {
        const [jobCount, validatorCount, minStake, feeBps, timeout] = await Promise.all([
          router.nextJobId(),
          router.getValidatorCount(),
          router.minValidatorStake(),
          router.routerFeeBps(),
          router.defaultJobTimeout(),
        ]);

        return {
          content: [{
            type: "text" as const,
            text: [
              `OracleRouter Stats:`,
              `  Total jobs: ${jobCount}`,
              `  Registered validators: ${validatorCount}`,
              `  Min validator stake: ${ethers.formatEther(minStake)} ETH`,
              `  Router fee: ${Number(feeBps) / 100}%`,
              `  Default job timeout: ${Number(timeout)}s`,
            ].join("\n"),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
