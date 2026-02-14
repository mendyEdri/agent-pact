import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config } from "../config.js";
import { AGENT_PACT_ABI, ORACLE_REGISTRY_ABI, AGENT_POLICY_MODULE_ABI } from "../abis.js";
import { getSigner } from "../provider.js";

export function registerResources(server: McpServer, config: Config) {
  server.resource(
    "config",
    "pact://config",
    { description: "Deployed contract addresses, chain info, and connected wallet" },
    async () => {
      const wallet = getSigner(config);
      return {
        contents: [{
          uri: "pact://config",
          mimeType: "application/json",
          text: JSON.stringify({
            chainId: config.chainId,
            rpcUrl: config.rpcUrl,
            contracts: {
              agentPact: config.agentPactAddress,
              oracleRegistry: config.oracleRegistryAddress,
              policyModule: config.policyModuleAddress,
            },
            wallet: {
              safeAddress: config.safeAddress,
              sessionKeyAddress: wallet.address,
            },
          }, null, 2),
        }],
      };
    }
  );

  server.resource(
    "abi-agent-pact",
    "pact://abi/agent-pact",
    { description: "AgentPact contract ABI" },
    async () => ({
      contents: [{
        uri: "pact://abi/agent-pact",
        mimeType: "application/json",
        text: JSON.stringify(AGENT_PACT_ABI, null, 2),
      }],
    })
  );

  server.resource(
    "abi-oracle-registry",
    "pact://abi/oracle-registry",
    { description: "OracleRegistry contract ABI" },
    async () => ({
      contents: [{
        uri: "pact://abi/oracle-registry",
        mimeType: "application/json",
        text: JSON.stringify(ORACLE_REGISTRY_ABI, null, 2),
      }],
    })
  );

  server.resource(
    "abi-policy-module",
    "pact://abi/policy-module",
    { description: "AgentPolicyModule contract ABI" },
    async () => ({
      contents: [{
        uri: "pact://abi/policy-module",
        mimeType: "application/json",
        text: JSON.stringify(AGENT_POLICY_MODULE_ABI, null, 2),
      }],
    })
  );
}
