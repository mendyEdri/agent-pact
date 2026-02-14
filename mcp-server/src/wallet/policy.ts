import { ethers } from "ethers";
import { Config } from "../config.js";
import { SpendingTracker } from "./spending.js";

/**
 * Software-level policy checker (defense-in-depth).
 * Checks spending limits before sending transactions on-chain.
 * The on-chain AgentPolicyModule is the real enforcement — this
 * is an early rejection to save gas on transactions that would fail.
 */
export class PolicyChecker {
  private maxPerTxWei: bigint;
  private maxDailyWei: bigint;
  private tracker: SpendingTracker;

  constructor(config: Config, tracker: SpendingTracker) {
    this.maxPerTxWei = ethers.parseEther(config.maxPerTxEth);
    this.maxDailyWei = ethers.parseEther(config.maxDailyEth);
    this.tracker = tracker;
  }

  /**
   * Check if a transaction is within software spending limits.
   * Returns null if OK, or an error message string if blocked.
   */
  check(amountWei: bigint): string | null {
    if (amountWei > this.maxPerTxWei) {
      return `Transaction blocked by wallet policy: ${ethers.formatEther(amountWei)} ETH exceeds per-transaction limit of ${ethers.formatEther(this.maxPerTxWei)} ETH. Request owner approval or reduce amount.`;
    }

    const projectedDaily = this.tracker.getDailySpent() + amountWei;
    if (projectedDaily > this.maxDailyWei) {
      return `Transaction blocked by wallet policy: projected daily spend ${ethers.formatEther(projectedDaily)} ETH exceeds daily limit of ${ethers.formatEther(this.maxDailyWei)} ETH. Wait until tomorrow or request owner to increase limit.`;
    }

    return null;
  }

  /**
   * Record a successful transaction spend.
   */
  record(amountWei: bigint): void {
    this.tracker.record(amountWei);
  }

  getMaxPerTxEth(): string {
    return ethers.formatEther(this.maxPerTxWei);
  }

  getMaxDailyEth(): string {
    return ethers.formatEther(this.maxDailyWei);
  }
}
