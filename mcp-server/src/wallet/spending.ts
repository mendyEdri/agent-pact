import { ethers } from "ethers";

/**
 * Software-level spending tracker (defense-in-depth).
 * Mirrors the on-chain AgentPolicyModule tracking but runs locally
 * to reject transactions before they hit the chain.
 */
export class SpendingTracker {
  private dailySpent = 0n;
  private weeklySpent = 0n;
  private lastDayReset: number;
  private lastWeekReset: number;

  constructor() {
    const now = Math.floor(Date.now() / 1000);
    this.lastDayReset = now;
    this.lastWeekReset = now;
  }

  private resetIfNeeded(): void {
    const now = Math.floor(Date.now() / 1000);
    const oneDay = 86400;
    const oneWeek = 604800;

    if (now > this.lastDayReset + oneDay) {
      this.dailySpent = 0n;
      this.lastDayReset = now;
    }
    if (now > this.lastWeekReset + oneWeek) {
      this.weeklySpent = 0n;
      this.lastWeekReset = now;
    }
  }

  record(amountWei: bigint): void {
    this.resetIfNeeded();
    this.dailySpent += amountWei;
    this.weeklySpent += amountWei;
  }

  getDailySpent(): bigint {
    this.resetIfNeeded();
    return this.dailySpent;
  }

  getWeeklySpent(): bigint {
    this.resetIfNeeded();
    return this.weeklySpent;
  }

  getDailySpentEth(): string {
    return ethers.formatEther(this.getDailySpent());
  }

  getWeeklySpentEth(): string {
    return ethers.formatEther(this.getWeeklySpent());
  }
}
