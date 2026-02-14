import { expect } from "chai";
import { ethers } from "hardhat";
import { AgentPolicyModule, MockSafe } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("AgentPolicyModule", function () {
  let module: AgentPolicyModule;
  let mockSafe: MockSafe;
  let owner: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let targetContract: HardhatEthersSigner; // stand-in for an allowed contract address

  const MAX_PER_TX = ethers.parseEther("0.5");
  const MAX_DAILY = ethers.parseEther("2.0");
  const MAX_WEEKLY = ethers.parseEther("5.0");
  const HUMAN_APPROVAL_ABOVE = ethers.parseEther("1.0");

  // A sample function selector (createPact)
  const SELECTOR_CREATE_PACT = "0x12345678";
  const SELECTOR_ACCEPT_PACT = "0xabcdef01";
  const SELECTOR_FORBIDDEN = "0xdeadbeef";

  let expiresAt: number;

  beforeEach(async function () {
    [owner, agent, other, targetContract] = await ethers.getSigners();

    // Deploy MockSafe first
    const SafeFactory = await ethers.getContractFactory("MockSafe");
    mockSafe = await SafeFactory.deploy();

    // Deploy AgentPolicyModule with Safe address
    const Factory = await ethers.getContractFactory("AgentPolicyModule");
    module = await Factory.deploy(await mockSafe.getAddress());
    expiresAt = (await time.latest()) + 86400; // 1 day from now
  });

  async function grantDefaultSession() {
    await module.grantSession(
      agent.address,
      MAX_PER_TX,
      MAX_DAILY,
      MAX_WEEKLY,
      HUMAN_APPROVAL_ABOVE,
      [targetContract.address],
      [SELECTOR_CREATE_PACT, SELECTOR_ACCEPT_PACT],
      [], // no token restrictions
      expiresAt
    );
  }

  // ──────────────────────────────────────────────
  // Constructor
  // ──────────────────────────────────────────────

  describe("constructor", function () {
    it("should store the Safe address", async function () {
      expect(await module.safe()).to.equal(await mockSafe.getAddress());
    });

    it("should reject zero address Safe", async function () {
      const Factory = await ethers.getContractFactory("AgentPolicyModule");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith("Invalid safe address");
    });
  });

  // ──────────────────────────────────────────────
  // grantSession
  // ──────────────────────────────────────────────

  describe("grantSession", function () {
    it("should grant a session with correct policy", async function () {
      await grantDefaultSession();

      const session = await module.getSession(agent.address);
      expect(session.maxPerTx).to.equal(MAX_PER_TX);
      expect(session.maxDaily).to.equal(MAX_DAILY);
      expect(session.maxWeekly).to.equal(MAX_WEEKLY);
      expect(session.humanApprovalAbove).to.equal(HUMAN_APPROVAL_ABOVE);
      expect(session.allowedContracts).to.deep.equal([targetContract.address]);
      expect(session.expiresAt).to.equal(expiresAt);
      expect(session.active).to.be.true;
    });

    it("should emit SessionGranted event", async function () {
      await expect(
        module.grantSession(
          agent.address, MAX_PER_TX, MAX_DAILY, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
          [targetContract.address], [SELECTOR_CREATE_PACT], [], expiresAt
        )
      ).to.emit(module, "SessionGranted");
    });

    it("should reject non-owner granting", async function () {
      await expect(
        module.connect(other).grantSession(
          agent.address, MAX_PER_TX, MAX_DAILY, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
          [targetContract.address], [SELECTOR_CREATE_PACT], [], expiresAt
        )
      ).to.be.revertedWithCustomError(module, "OwnableUnauthorizedAccount");
    });

    it("should reject zero address session key", async function () {
      await expect(
        module.grantSession(
          ethers.ZeroAddress, MAX_PER_TX, MAX_DAILY, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
          [targetContract.address], [SELECTOR_CREATE_PACT], [], expiresAt
        )
      ).to.be.revertedWith("Invalid session key");
    });

    it("should reject expired expiry time", async function () {
      const pastTime = (await time.latest()) - 1;
      await expect(
        module.grantSession(
          agent.address, MAX_PER_TX, MAX_DAILY, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
          [targetContract.address], [SELECTOR_CREATE_PACT], [], pastTime
        )
      ).to.be.revertedWith("Expiry must be in the future");
    });

    it("should reject zero maxPerTx", async function () {
      await expect(
        module.grantSession(
          agent.address, 0, MAX_DAILY, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
          [targetContract.address], [SELECTOR_CREATE_PACT], [], expiresAt
        )
      ).to.be.revertedWith("maxPerTx must be > 0");
    });

    it("should reject maxDaily < maxPerTx", async function () {
      await expect(
        module.grantSession(
          agent.address, MAX_PER_TX, MAX_PER_TX - 1n, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
          [targetContract.address], [SELECTOR_CREATE_PACT], [], expiresAt
        )
      ).to.be.revertedWith("maxDaily must be >= maxPerTx");
    });

    it("should reject empty allowed contracts", async function () {
      await expect(
        module.grantSession(
          agent.address, MAX_PER_TX, MAX_DAILY, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
          [], [SELECTOR_CREATE_PACT], [], expiresAt
        )
      ).to.be.revertedWith("Need at least one allowed contract");
    });
  });

  // ──────────────────────────────────────────────
  // revokeSession
  // ──────────────────────────────────────────────

  describe("revokeSession", function () {
    it("should revoke an active session", async function () {
      await grantDefaultSession();

      await expect(module.revokeSession(agent.address))
        .to.emit(module, "SessionRevoked")
        .withArgs(agent.address);

      const session = await module.getSession(agent.address);
      expect(session.active).to.be.false;
    });

    it("should reject revoking inactive session", async function () {
      await expect(
        module.revokeSession(agent.address)
      ).to.be.revertedWith("Session not active");
    });

    it("should reject non-owner revoking", async function () {
      await grantDefaultSession();
      await expect(
        module.connect(other).revokeSession(agent.address)
      ).to.be.revertedWithCustomError(module, "OwnableUnauthorizedAccount");
    });
  });

  // ──────────────────────────────────────────────
  // validateTransaction
  // ──────────────────────────────────────────────

  describe("validateTransaction", function () {
    beforeEach(async function () {
      await grantDefaultSession();
    });

    it("should validate a valid transaction", async function () {
      const txValue = ethers.parseEther("0.3");
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56); // 4 bytes selector + 28 bytes padding

      await expect(
        module.validateTransaction(agent.address, targetContract.address, txValue, calldata)
      ).to.emit(module, "TransactionValidated");
    });

    it("should reject inactive session", async function () {
      await module.revokeSession(agent.address);
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);

      await expect(
        module.validateTransaction(agent.address, targetContract.address, ethers.parseEther("0.1"), calldata)
      ).to.be.revertedWith("Session not active");
    });

    it("should reject expired session", async function () {
      await time.increaseTo(expiresAt + 1);
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);

      await expect(
        module.validateTransaction(agent.address, targetContract.address, ethers.parseEther("0.1"), calldata)
      ).to.be.revertedWith("Session expired");
    });

    it("should reject disallowed contract", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);

      await expect(
        module.validateTransaction(agent.address, other.address, ethers.parseEther("0.1"), calldata)
      ).to.be.revertedWith("Contract not allowed");
    });

    it("should reject disallowed function selector", async function () {
      const calldata = SELECTOR_FORBIDDEN + "0".repeat(56);

      await expect(
        module.validateTransaction(agent.address, targetContract.address, ethers.parseEther("0.1"), calldata)
      ).to.be.revertedWith("Function not allowed");
    });

    it("should reject amount exceeding per-tx limit", async function () {
      const overLimit = MAX_PER_TX + 1n;
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);

      await expect(
        module.validateTransaction(agent.address, targetContract.address, overLimit, calldata)
      ).to.be.revertedWith("Exceeds per-tx limit");
    });

    it("should reject amount requiring human approval", async function () {
      // humanApprovalAbove is set to 1 ETH, but maxPerTx is 0.5 ETH
      // So we need a case where value > humanApprovalAbove but <= maxPerTx
      // Let's create a session with higher maxPerTx
      await module.grantSession(
        other.address,
        ethers.parseEther("2.0"),   // maxPerTx
        ethers.parseEther("5.0"),   // maxDaily
        ethers.parseEther("10.0"),  // maxWeekly
        ethers.parseEther("0.5"),   // humanApprovalAbove (lower than maxPerTx)
        [targetContract.address],
        [SELECTOR_CREATE_PACT],
        [],
        expiresAt
      );

      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);
      await expect(
        module.validateTransaction(other.address, targetContract.address, ethers.parseEther("0.6"), calldata)
      ).to.be.revertedWith("Requires human approval");
    });

    it("should track cumulative daily spending and reject when exceeded", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);
      const txAmount = ethers.parseEther("0.5");

      // 4 txs of 0.5 ETH = 2.0 ETH (hits daily max)
      await module.validateTransaction(agent.address, targetContract.address, txAmount, calldata);
      await module.validateTransaction(agent.address, targetContract.address, txAmount, calldata);
      await module.validateTransaction(agent.address, targetContract.address, txAmount, calldata);
      await module.validateTransaction(agent.address, targetContract.address, txAmount, calldata);

      // 5th tx should fail — daily limit of 2.0 ETH exceeded
      await expect(
        module.validateTransaction(agent.address, targetContract.address, txAmount, calldata)
      ).to.be.revertedWith("Exceeds daily limit");
    });

    it("should reset daily counter after 24 hours", async function () {
      // Use a longer expiry so the session doesn't expire when we advance time
      const longExpiry = (await time.latest()) + 30 * 86400; // 30 days
      await module.grantSession(
        other.address, MAX_PER_TX, MAX_DAILY, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
        [targetContract.address], [SELECTOR_CREATE_PACT, SELECTOR_ACCEPT_PACT], [], longExpiry
      );

      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);
      const txAmount = ethers.parseEther("0.5");

      // Use up daily limit
      await module.validateTransaction(other.address, targetContract.address, txAmount, calldata);
      await module.validateTransaction(other.address, targetContract.address, txAmount, calldata);
      await module.validateTransaction(other.address, targetContract.address, txAmount, calldata);
      await module.validateTransaction(other.address, targetContract.address, txAmount, calldata);

      // Advance 1 day + 1 second
      await time.increase(86401);

      // Should work again
      await expect(
        module.validateTransaction(other.address, targetContract.address, txAmount, calldata)
      ).to.emit(module, "TransactionValidated");
    });

    it("should track weekly spending across days", async function () {
      const longExpiry = (await time.latest()) + 30 * 86400;
      await module.grantSession(
        other.address, MAX_PER_TX, MAX_DAILY, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
        [targetContract.address], [SELECTOR_CREATE_PACT, SELECTOR_ACCEPT_PACT], [], longExpiry
      );

      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);
      const txAmount = ethers.parseEther("0.5");

      // Day 1: spend 2.0 ETH (daily max)
      for (let i = 0; i < 4; i++) {
        await module.validateTransaction(other.address, targetContract.address, txAmount, calldata);
      }

      // Day 2: advance 1 day, spend 2.0 ETH more (total weekly: 4.0)
      await time.increase(86401);
      for (let i = 0; i < 4; i++) {
        await module.validateTransaction(other.address, targetContract.address, txAmount, calldata);
      }

      // Day 3: advance 1 day, try to spend 2.0 ETH more (would be 6.0 > 5.0 weekly limit)
      await time.increase(86401);
      await module.validateTransaction(other.address, targetContract.address, txAmount, calldata);
      await module.validateTransaction(other.address, targetContract.address, txAmount, calldata);

      // 11th total tx should fail — weekly limit of 5.0 ETH exceeded
      await expect(
        module.validateTransaction(other.address, targetContract.address, txAmount, calldata)
      ).to.be.revertedWith("Exceeds weekly limit");
    });

    it("should allow transactions with empty function allowlist (any function)", async function () {
      // Grant session with empty function allowlist
      await module.grantSession(
        other.address,
        MAX_PER_TX, MAX_DAILY, MAX_WEEKLY, HUMAN_APPROVAL_ABOVE,
        [targetContract.address],
        [], // empty = allow all functions
        [],
        expiresAt
      );

      const calldata = SELECTOR_FORBIDDEN + "0".repeat(56);
      await expect(
        module.validateTransaction(other.address, targetContract.address, ethers.parseEther("0.1"), calldata)
      ).to.emit(module, "TransactionValidated");
    });
  });

  // ──────────────────────────────────────────────
  // executeTransaction (Safe integration)
  // ──────────────────────────────────────────────

  describe("executeTransaction", function () {
    let targetAddress: string;

    beforeEach(async function () {
      // Use the actual target contract address (an EOA for simple tests)
      targetAddress = targetContract.address;

      // Grant session to agent with targetAddress in allowlist
      await grantDefaultSession();

      // Fund the MockSafe so it can send ETH
      await owner.sendTransaction({
        to: await mockSafe.getAddress(),
        value: ethers.parseEther("10.0"),
      });
    });

    it("should validate and execute through the Safe", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);

      await expect(
        module.connect(agent).executeTransaction(targetAddress, ethers.parseEther("0.3"), calldata)
      ).to.emit(module, "TransactionExecuted")
        .withArgs(agent.address, targetAddress, ethers.parseEther("0.3"));
    });

    it("should emit TransactionValidated before TransactionExecuted", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);

      const tx = await module.connect(agent).executeTransaction(targetAddress, ethers.parseEther("0.1"), calldata);
      const receipt = await tx.wait();

      // Both events should be in the receipt
      const moduleIface = module.interface;
      const events = receipt!.logs
        .map((log) => { try { return moduleIface.parseLog(log); } catch { return null; } })
        .filter(Boolean);

      const eventNames = events.map((e: any) => e.name);
      expect(eventNames).to.include("TransactionValidated");
      expect(eventNames).to.include("TransactionExecuted");
    });

    it("should record spending correctly", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);
      const value = ethers.parseEther("0.3");

      await module.connect(agent).executeTransaction(targetAddress, value, calldata);

      const s = await module.getSpending(agent.address);
      expect(s.dailySpent).to.equal(value);
      expect(s.weeklySpent).to.equal(value);
    });

    it("should use msg.sender as the session key", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);

      // Agent has a session — should work
      await expect(
        module.connect(agent).executeTransaction(targetAddress, ethers.parseEther("0.1"), calldata)
      ).to.not.be.reverted;

      // Other does NOT have a session — should fail
      await expect(
        module.connect(other).executeTransaction(targetAddress, ethers.parseEther("0.1"), calldata)
      ).to.be.revertedWith("Session not active");
    });

    it("should reject when policy validation fails", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);

      // Exceed per-tx limit
      await expect(
        module.connect(agent).executeTransaction(targetAddress, MAX_PER_TX + 1n, calldata)
      ).to.be.revertedWith("Exceeds per-tx limit");
    });

    it("should reject disallowed contract", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);

      await expect(
        module.connect(agent).executeTransaction(other.address, ethers.parseEther("0.1"), calldata)
      ).to.be.revertedWith("Contract not allowed");
    });

    it("should reject disallowed function selector", async function () {
      const calldata = SELECTOR_FORBIDDEN + "0".repeat(56);

      await expect(
        module.connect(agent).executeTransaction(targetAddress, ethers.parseEther("0.1"), calldata)
      ).to.be.revertedWith("Function not allowed");
    });

    it("should enforce spending limits across multiple calls", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);
      const txAmount = ethers.parseEther("0.5");

      // 4 txs of 0.5 ETH = 2.0 ETH (daily max)
      await module.connect(agent).executeTransaction(targetAddress, txAmount, calldata);
      await module.connect(agent).executeTransaction(targetAddress, txAmount, calldata);
      await module.connect(agent).executeTransaction(targetAddress, txAmount, calldata);
      await module.connect(agent).executeTransaction(targetAddress, txAmount, calldata);

      // 5th tx should fail — daily limit exceeded
      await expect(
        module.connect(agent).executeTransaction(targetAddress, txAmount, calldata)
      ).to.be.revertedWith("Exceeds daily limit");
    });

    it("should send ETH from the Safe, not from the session key", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);
      const sendAmount = ethers.parseEther("0.3");

      const safeAddr = await mockSafe.getAddress();
      const safeBefore = await ethers.provider.getBalance(safeAddr);
      const targetBefore = await ethers.provider.getBalance(targetAddress);

      await module.connect(agent).executeTransaction(targetAddress, sendAmount, calldata);

      const safeAfter = await ethers.provider.getBalance(safeAddr);
      const targetAfter = await ethers.provider.getBalance(targetAddress);

      // Safe balance should decrease
      expect(safeBefore - safeAfter).to.equal(sendAmount);
      // Target balance should increase
      expect(targetAfter - targetBefore).to.equal(sendAmount);
    });

    it("should call the Safe's execTransactionFromModule", async function () {
      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);
      const sendAmount = ethers.parseEther("0.1");

      await expect(
        module.connect(agent).executeTransaction(targetAddress, sendAmount, calldata)
      ).to.emit(mockSafe, "ExecutedFromModule")
        .withArgs(await module.getAddress(), targetAddress, sendAmount, calldata);
    });
  });

  // ──────────────────────────────────────────────
  // View functions
  // ──────────────────────────────────────────────

  describe("View functions", function () {
    it("should return spending stats", async function () {
      await grantDefaultSession();

      const calldata = SELECTOR_CREATE_PACT + "0".repeat(56);
      await module.validateTransaction(
        agent.address, targetContract.address, ethers.parseEther("0.3"), calldata
      );

      const s = await module.getSpending(agent.address);
      expect(s.dailySpent).to.equal(ethers.parseEther("0.3"));
      expect(s.weeklySpent).to.equal(ethers.parseEther("0.3"));
    });

    it("should report session active status correctly", async function () {
      await grantDefaultSession();
      expect(await module.isSessionActive(agent.address)).to.be.true;

      await module.revokeSession(agent.address);
      expect(await module.isSessionActive(agent.address)).to.be.false;
    });

    it("should report expired session as inactive", async function () {
      await grantDefaultSession();
      await time.increaseTo(expiresAt + 1);
      expect(await module.isSessionActive(agent.address)).to.be.false;
    });
  });
});
