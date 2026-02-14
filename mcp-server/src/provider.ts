import { ethers } from "ethers";
import { Config } from "./config.js";

let provider: ethers.JsonRpcProvider | null = null;
let signer: ethers.Wallet | null = null;

export function getProvider(config: Config): ethers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(config.rpcUrl);
  }
  return provider;
}

export function getSigner(config: Config): ethers.Wallet {
  if (!signer) {
    signer = new ethers.Wallet(config.sessionKey, getProvider(config));
  }
  return signer;
}

export async function getBalance(config: Config): Promise<string> {
  const balance = await getProvider(config).getBalance(config.safeAddress);
  return ethers.formatEther(balance);
}

export async function getSessionKeyBalance(config: Config): Promise<string> {
  const wallet = getSigner(config);
  const balance = await getProvider(config).getBalance(wallet.address);
  return ethers.formatEther(balance);
}
