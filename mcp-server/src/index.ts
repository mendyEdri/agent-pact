import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SpendingTracker } from "./wallet/spending.js";
import { PolicyChecker } from "./wallet/policy.js";
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

  // Initialize wallet policy layer
  const tracker = new SpendingTracker();
  const policy = new PolicyChecker(config, tracker);

  // Create MCP server
  const server = new McpServer({
    name: "agent-pact",
    version: "1.0.0",
  });

  // Register all tools
  registerQueryTools(server, config);
  registerPactTools(server, config, policy);
  registerNegotiateTools(server, config);
  registerWorkTools(server, config);
  registerApprovalTools(server, config);
  registerOracleTools(server, config, policy);
  registerDisputeTools(server, config);
  registerFinalizeTools(server, config);
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
