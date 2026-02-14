import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SpendingTracker } from "./wallet/spending.js";
import { PolicyChecker } from "./wallet/policy.js";
import { SafeExecutor } from "./wallet/safe-executor.js";
import { registerQueryTools } from "./tools/query.js";
import { registerPactTools } from "./tools/pact.js";
import { registerNegotiateTools } from "./tools/negotiate.js";
import { registerWorkTools } from "./tools/work.js";
import { registerApprovalTools } from "./tools/approval.js";
import { registerOracleTools } from "./tools/oracle.js";
import { registerDisputeTools } from "./tools/dispute.js";
import { registerFinalizeTools } from "./tools/finalize.js";
import { registerWalletTools } from "./tools/wallet.js";
import { registerResources } from "./resources/contracts.js";

async function main() {
  // All console output goes to stderr (stdout is reserved for MCP protocol)
  console.error("Starting Agent Pact MCP Server...");

  const config = loadConfig();
  console.error(`Chain: ${config.chainId}, RPC: ${config.rpcUrl}`);
  console.error(`AgentPact: ${config.agentPactAddress}`);
  console.error(`OracleRegistry: ${config.oracleRegistryAddress}`);
  console.error(`PolicyModule: ${config.policyModuleAddress}`);
  console.error(`Safe: ${config.safeAddress}`);

  // Initialize wallet policy layer (defense-in-depth software checks)
  const tracker = new SpendingTracker();
  const policy = new PolicyChecker(config, tracker);

  // Initialize Safe executor — all write transactions route through the Safe
  const executor = new SafeExecutor(config, policy);

  // Create MCP server
  const server = new McpServer({
    name: "agent-pact",
    version: "1.0.0",
  });

  // Register all tools (write tools use SafeExecutor, read tools use direct calls)
  registerQueryTools(server, config);
  registerPactTools(server, config, executor);
  registerNegotiateTools(server, config, executor);
  registerWorkTools(server, config, executor);
  registerApprovalTools(server, config, executor);
  registerOracleTools(server, config, executor);
  registerDisputeTools(server, config, executor);
  registerFinalizeTools(server, config, executor);
  registerWalletTools(server, config, policy, tracker);

  // Register resources
  registerResources(server, config);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Agent Pact MCP Server running on stdio.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
