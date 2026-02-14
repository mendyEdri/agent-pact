import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { getPolicyModule } from "../contracts.js";
import { getSigner, getBalance } from "../provider.js";
import { PolicyChecker } from "../wallet/policy.js";
import { SpendingTracker } from "../wallet/spending.js";

export function registerWalletTools(
  server: McpServer,
  config: Config,
  policy: PolicyChecker,
  tracker: SpendingTracker
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
}
