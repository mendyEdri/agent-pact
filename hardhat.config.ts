import { HardhatUserConfig, subtask } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import path from "path";

// Use locally installed solcjs to avoid downloading the native compiler
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async (taskArgs) => {
  const solcPath = require.resolve("solc");
  const solcDir = path.dirname(solcPath);
  const solcjsPath = path.join(solcDir, "soljson.js");

  return {
    version: taskArgs.solcVersion,
    longVersion: "0.8.26+commit.8a97fa7a",
    compilerPath: solcjsPath,
    isSolcJs: true,
  };
});

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    base: {
      url: process.env.BASE_RPC || "https://mainnet.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      baseSepolia: process.env.BASESCAN_API_KEY || "",
      base: process.env.BASESCAN_API_KEY || "",
    },
  },
};

export default config;
