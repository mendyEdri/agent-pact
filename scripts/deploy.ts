import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // Deploy OracleRegistry
  const minStake = ethers.parseEther("0.01");
  const OracleRegistry = await ethers.getContractFactory("OracleRegistry");
  const registry = await OracleRegistry.deploy(minStake);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("OracleRegistry deployed to:", registryAddr);

  // Deploy AgentPact
  const AgentPact = await ethers.getContractFactory("AgentPact");
  const pact = await AgentPact.deploy();
  await pact.waitForDeployment();
  const pactAddr = await pact.getAddress();
  console.log("AgentPact deployed to:", pactAddr);

  // Deploy OracleRouter
  const routerMinStake = ethers.parseEther("0.1");
  const routerFeeBps = 500;        // 5% protocol fee
  const defaultJobTimeout = 3600;  // 1 hour for validators to respond
  const OracleRouter = await ethers.getContractFactory("OracleRouter");
  const router = await OracleRouter.deploy(routerMinStake, routerFeeBps, defaultJobTimeout);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("OracleRouter deployed to:", routerAddr);

  console.log("\nDeployment complete!");
  console.log("OracleRegistry:", registryAddr);
  console.log("AgentPact:", pactAddr);
  console.log("OracleRouter:", routerAddr);

  console.log("\nEnvironment variables for MCP server:");
  console.log(`AGENT_PACT_ADDRESS=${pactAddr}`);
  console.log(`ORACLE_REGISTRY_ADDRESS=${registryAddr}`);
  console.log(`ORACLE_ROUTER_ADDRESS=${routerAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
