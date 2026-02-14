import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { getPolicyModule } from "../contracts.js";
import { getSigner, getBalance } from "../provider.js";
import { PolicyChecker } from "../wallet/policy.js";
import { SpendingTracker } from "../wallet/spending.js";
import { SafeExecutor } from "../wallet/safe-executor.js";
import { AGENT_POLICY_MODULE_ABI } from "../abis.js";

const policyModuleIface = new ethers.Interface(AGENT_POLICY_MODULE_ABI);

export function registerWalletTools(
  server: McpServer,
  config: Config,
  policy: PolicyChecker,
  tracker: SpendingTracker,
  executor?: SafeExecutor
) {
  server.tool(
    "get-balance",
    "Get the wallet's current ETH balance",
    {},
    async () => {
      try {
        const wallet = getSigner(config);
        const safeBalance = await getBalance(config);
        const keyBalance = await wallet.provider!.getBalance(wallet.address);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              safeWallet: {
                address: config.safeAddress,
                balance: safeBalance + " ETH",
              },
              sessionKey: {
                address: wallet.address,
                balance: ethers.formatEther(keyBalance) + " ETH",
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-spending",
    "Get the agent's spending stats against its policy limits",
    {},
    async () => {
      try {
        // Software-tracked spending
        const dailySpent = tracker.getDailySpentEth();
        const weeklySpent = tracker.getWeeklySpentEth();

        // On-chain spending (from policy module)
        let onChainSpending = null;
        try {
          const module = getPolicyModule(config);
          const wallet = getSigner(config);
          const s = await module.getSpending(wallet.address);
          onChainSpending = {
            dailySpent: ethers.formatEther(s.dailySpent) + " ETH",
            weeklySpent: ethers.formatEther(s.weeklySpent) + " ETH",
          };
        } catch {
          // Policy module may not be deployed yet
        }

        // Shared budget info
        let sharedBudgetInfo = null;
        try {
          const module = getPolicyModule(config);
          const b = await module.getSharedBudget();
          if (b.enabled) {
            sharedBudgetInfo = {
              dailySpent: ethers.formatEther(b.dailySpent) + " ETH",
              maxDaily: ethers.formatEther(b.maxDaily) + " ETH",
              weeklySpent: ethers.formatEther(b.weeklySpent) + " ETH",
              maxWeekly: ethers.formatEther(b.maxWeekly) + " ETH",
              totalReserved: ethers.formatEther(b.totalReserved) + " ETH",
            };
          }
        } catch {
          // Shared budget may not be available
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              softwareLimits: {
                spentToday: dailySpent + " ETH",
                dailyLimit: policy.getMaxDailyEth() + " ETH",
                spentThisWeek: weeklySpent + " ETH",
                maxPerTx: policy.getMaxPerTxEth() + " ETH",
              },
              onChain: onChainSpending ?? "Policy module not available",
              sharedBudget: sharedBudgetInfo ?? "Not enabled",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-policy",
    "Get the full policy attached to this agent's session key",
    {},
    async () => {
      try {
        const module = getPolicyModule(config);
        const wallet = getSigner(config);
        const session = await module.getSession(wallet.address);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              sessionKey: wallet.address,
              active: session.active,
              maxPerTx: ethers.formatEther(session.maxPerTx) + " ETH",
              maxDaily: ethers.formatEther(session.maxDaily) + " ETH",
              maxWeekly: ethers.formatEther(session.maxWeekly) + " ETH",
              humanApprovalAbove: ethers.formatEther(session.humanApprovalAbove) + " ETH",
              allowedContracts: session.allowedContracts,
              allowedFunctions: session.allowedFunctions,
              allowedTokens: session.allowedTokens,
              expiresAt: new Date(Number(session.expiresAt) * 1000).toISOString(),
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-shared-budget",
    "Get the shared budget status across all agents in this Safe",
    {},
    async () => {
      try {
        const module = getPolicyModule(config);
        const b = await module.getSharedBudget();
        const available = await module.getAvailableBudget();

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              enabled: b.enabled,
              maxDaily: ethers.formatEther(b.maxDaily) + " ETH",
              maxWeekly: ethers.formatEther(b.maxWeekly) + " ETH",
              dailySpent: ethers.formatEther(b.dailySpent) + " ETH",
              weeklySpent: ethers.formatEther(b.weeklySpent) + " ETH",
              totalReserved: ethers.formatEther(b.totalReserved) + " ETH",
              availableForReservation: b.enabled ? ethers.formatEther(available) + " ETH" : "unlimited (budget disabled)",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "reserve-budget",
    "Reserve shared budget before committing to a pact (prevents other agents from spending these funds)",
    {
      amountEth: z.string().describe("Amount to reserve in ETH (e.g. '1.5')"),
    },
    async ({ amountEth }) => {
      try {
        if (!executor) {
          return { content: [{ type: "text" as const, text: "Safe executor not available" }], isError: true };
        }
        const amount = ethers.parseEther(amountEth);
        const calldata = policyModuleIface.encodeFunctionData("reserveBudget", [amount]);
        const receipt = await executor.execute(config.policyModuleAddress, 0n, calldata);

        // Extract reservation ID from event
        const event = receipt.logs
          .map((log: any) => { try { return policyModuleIface.parseLog(log); } catch { return null; } })
          .find((e: any) => e?.name === "BudgetReserved");
        const reservationId = event?.args?.reservationId?.toString() ?? "unknown";

        return {
          content: [{
            type: "text" as const,
            text: `Budget reserved: ${amountEth} ETH (reservation #${reservationId}). Other agents cannot use these funds.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error reserving budget: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "release-budget",
    "Release a previously reserved budget (e.g. after pact completes or is refunded)",
    {
      reservationId: z.number().int().nonnegative().describe("The reservation ID to release"),
    },
    async ({ reservationId }) => {
      try {
        if (!executor) {
          return { content: [{ type: "text" as const, text: "Safe executor not available" }], isError: true };
        }
        const calldata = policyModuleIface.encodeFunctionData("releaseBudget", [reservationId]);
        const receipt = await executor.execute(config.policyModuleAddress, 0n, calldata);

        return {
          content: [{
            type: "text" as const,
            text: `Budget reservation #${reservationId} released. Funds available for other agents.\nTx: ${receipt.hash}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error releasing budget: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "my-reservations",
    "List this agent's active budget reservations",
    {},
    async () => {
      try {
        const module = getPolicyModule(config);
        const wallet = getSigner(config);
        const ids = await module.getSessionReservations(wallet.address);

        const reservations = [];
        for (const id of ids) {
          const r = await module.getReservation(id);
          if (r.active) {
            reservations.push({
              reservationId: Number(id),
              amount: ethers.formatEther(r.amount) + " ETH",
            });
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: reservations.length > 0
              ? JSON.stringify({ activeReservations: reservations }, null, 2)
              : "No active budget reservations.",
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.reason ?? err.message}` }], isError: true };
      }
    }
  );
}
