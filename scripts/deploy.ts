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

  console.log("\nDeployment complete!");
  console.log("OracleRegistry:", registryAddr);
  console.log("AgentPact:", pactAddr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
