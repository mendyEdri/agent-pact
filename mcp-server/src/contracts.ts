import { ethers } from "ethers";
import { Config } from "./config.js";
import { getSigner } from "./provider.js";
import { AGENT_PACT_ABI, ORACLE_REGISTRY_ABI, AGENT_POLICY_MODULE_ABI } from "./abis.js";

let agentPact: ethers.Contract | null = null;
let oracleRegistry: ethers.Contract | null = null;
let policyModule: ethers.Contract | null = null;

export function getAgentPact(config: Config): ethers.Contract {
  if (!agentPact) {
    agentPact = new ethers.Contract(
      config.agentPactAddress,
      AGENT_PACT_ABI,
      getSigner(config)
    );
  }
  return agentPact;
}

export function getOracleRegistry(config: Config): ethers.Contract {
  if (!oracleRegistry) {
    oracleRegistry = new ethers.Contract(
      config.oracleRegistryAddress,
      ORACLE_REGISTRY_ABI,
      getSigner(config)
    );
  }
  return oracleRegistry;
}

export function getPolicyModule(config: Config): ethers.Contract {
  if (!policyModule) {
    policyModule = new ethers.Contract(
      config.policyModuleAddress,
      AGENT_POLICY_MODULE_ABI,
      getSigner(config)
    );
  }
  return policyModule;
}
