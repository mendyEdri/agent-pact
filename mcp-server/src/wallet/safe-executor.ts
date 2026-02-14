import { ethers } from "ethers";
import { Config } from "../config.js";
import { getPolicyModule } from "../contracts.js";
import { PolicyChecker } from "./policy.js";

/**
 * Executes transactions through the Safe via the AgentPolicyModule.
 *
 * Instead of the session key calling target contracts directly (where ETH
 * comes from the session key's own balance), this routes everything through:
 *
 *   Session Key → AgentPolicyModule.executeTransaction(to, value, data)
 *                  ↓ validates policy
 *                  ↓ Safe.execTransactionFromModule(to, value, data, 0)
 *                  ↓ Safe executes the actual call (ETH from Safe balance)
 *
 * The session key only needs enough ETH for gas.
 */
export class SafeExecutor {
  private config: Config;
  private policy: PolicyChecker;

  constructor(config: Config, policy: PolicyChecker) {
    this.config = config;
    this.policy = policy;
  }

  /**
   * Execute a transaction through the Safe.
   *
   * @param target - Target contract address.
   * @param value  - ETH value (in wei) the Safe should send.
   * @param data   - Encoded calldata for the target contract.
   * @returns The transaction receipt (includes events from all involved contracts).
   */
  async execute(
    target: string,
    value: bigint,
    data: string
  ): Promise<ethers.TransactionReceipt> {
    // Software policy check (defense-in-depth, saves gas on obvious rejections)
    if (value > 0n) {
      const policyErr = this.policy.check(value);
      if (policyErr) {
        throw new Error(policyErr);
      }
    }

    const module = getPolicyModule(this.config);
    const tx = await module.executeTransaction(target, value, data);
    const receipt = await tx.wait();

    // Record spend in software tracker
    if (value > 0n) {
      this.policy.record(value);
    }

    return receipt;
  }

  /** Get the underlying transaction hash from a receipt. */
  static txHash(receipt: ethers.TransactionReceipt): string {
    return receipt.hash;
  }
}
