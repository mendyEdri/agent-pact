import dotenv from "dotenv";
dotenv.config();

export interface Config {
  sessionKey: string;
  safeAddress: string;
  rpcUrl: string;
  agentPactAddress: string;
  oracleRegistryAddress: string;
  oracleRouterAddress: string;
  policyModuleAddress: string;
  chainId: number;
  maxPerTxEth: string;
  maxDailyEth: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    sessionKey: requireEnv("SESSION_KEY"),
    safeAddress: requireEnv("SAFE_ADDRESS"),
    rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
    agentPactAddress: requireEnv("AGENT_PACT_ADDRESS"),
    oracleRegistryAddress: requireEnv("ORACLE_REGISTRY_ADDRESS"),
    oracleRouterAddress: requireEnv("ORACLE_ROUTER_ADDRESS"),
    policyModuleAddress: requireEnv("POLICY_MODULE_ADDRESS"),
    chainId: parseInt(process.env.CHAIN_ID ?? "84532"),
    maxPerTxEth: process.env.MAX_PER_TX_ETH ?? "0.5",
    maxDailyEth: process.env.MAX_DAILY_ETH ?? "2.0",
  };
}
