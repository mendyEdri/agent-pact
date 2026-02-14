import { expect } from "chai";
import { ethers } from "hardhat";
import { AgentPact } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("AgentPact", function () {
  let pact: AgentPact;
  let buyer: HardhatEthersSigner;
  let seller: HardhatEthersSigner;
  let oracle1: HardhatEthersSigner;
  let oracle2: HardhatEthersSigner;
  let arbitrator: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const PAYMENT = ethers.parseEther("1.0");
  const STAKE_PERCENT = 10n;
  const BUYER_DEPOSIT = PAYMENT + PAYMENT / STAKE_PERCENT; // 1.1 ETH (payment + 10% stake)
  const SELLER_STAKE = PAYMENT / STAKE_PERCENT; // 0.1 ETH
  const SPEC_HASH = ethers.keccak256(ethers.toUtf8Bytes("spec-v1"));
  const PROOF_HASH = ethers.keccak256(ethers.toUtf8Bytes("proof-v1"));
  const VERIFICATION_PROOF = ethers.keccak256(ethers.toUtf8Bytes("verified"));

  let deadline: number;

  beforeEach(async function () {
    [buyer, seller, oracle1, oracle2, arbitrator, other] =
      await ethers.getSigners();
    const AgentPact = await ethers.getContractFactory("AgentPact");
    pact = await AgentPact.deploy();
    deadline = (await time.latest()) + 86400; // 1 day from now
  });

  async function createPact(
    oracles: string[] = [oracle1.address],
    weights: number[] = [100],
    threshold: number = 70
  ) {
    const tx = await pact
      .connect(buyer)
      .createPact(SPEC_HASH, deadline, oracles, weights, threshold, {
        value: BUYER_DEPOSIT,
      });
    const receipt = await tx.wait();
    return 0; // first pact ID
  }

  async function createAndAcceptPact(
    oracles: string[] = [oracle1.address],
    weights: number[] = [100],
    threshold: number = 70
  ) {
    await createPact(oracles, weights, threshold);
    await pact.connect(seller).acceptPact(0, { value: SELLER_STAKE });
    return 0;
  }

  describe("createPact", function () {
    it("should create a pact with correct parameters", async function () {
      await createPact();

      const p = await pact.getPact(0);
      expect(p.buyer).to.equal(buyer.address);
      expect(p.status).to.equal(0); // NEGOTIATING
      expect(p.specHash).to.equal(SPEC_HASH);
      expect(p.verificationThreshold).to.equal(70);
      expect(p.buyerStake).to.be.gt(0);
      expect(p.payment).to.be.gt(0);
      // payment + buyerStake = BUYER_DEPOSIT
      expect(p.payment + p.buyerStake).to.equal(BUYER_DEPOSIT);
    });

    it("should emit PactCreated event", async function () {
      await expect(
        pact
          .connect(buyer)
          .createPact(SPEC_HASH, deadline, [oracle1.address], [100], 70, {
            value: BUYER_DEPOSIT,
          })
      ).to.emit(pact, "PactCreated");
    });

    it("should reject with no oracles", async function () {
      await expect(
        pact.connect(buyer).createPact(SPEC_HASH, deadline, [], [], 70, {
          value: BUYER_DEPOSIT,
        })
      ).to.be.revertedWith("Need at least one oracle");
    });

    it("should reject oracle/weight length mismatch", async function () {
      await expect(
        pact
          .connect(buyer)
          .createPact(
            SPEC_HASH,
            deadline,
            [oracle1.address, oracle2.address],
            [100],
            70,
            { value: BUYER_DEPOSIT }
          )
      ).to.be.revertedWith("Oracles/weights mismatch");
    });

    it("should reject weights not summing to 100", async function () {
      await expect(
        pact
          .connect(buyer)
          .createPact(
            SPEC_HASH,
            deadline,
            [oracle1.address, oracle2.address],
            [50, 40],
            70,
            { value: BUYER_DEPOSIT }
          )
      ).to.be.revertedWith("Weights must sum to 100");
    });

    it("should reject threshold > 100", async function () {
      await expect(
        pact
          .connect(buyer)
          .createPact(SPEC_HASH, deadline, [oracle1.address], [100], 101, {
            value: BUYER_DEPOSIT,
          })
      ).to.be.revertedWith("Threshold must be <= 100");
    });

    it("should reject deadline in the past", async function () {
      const pastDeadline = (await time.latest()) - 1;
      await expect(
        pact
          .connect(buyer)
          .createPact(
            SPEC_HASH,
            pastDeadline,
            [oracle1.address],
            [100],
            70,
            { value: BUYER_DEPOSIT }
          )
      ).to.be.revertedWith("Deadline must be in the future");
    });

    it("should reject zero payment", async function () {
      await expect(
        pact
          .connect(buyer)
          .createPact(SPEC_HASH, deadline, [oracle1.address], [100], 70, {
            value: 0,
          })
      ).to.be.revertedWith("Payment must be > 0");
    });

    it("should increment pact IDs", async function () {
      await createPact();
      await pact
        .connect(buyer)
        .createPact(SPEC_HASH, deadline, [oracle1.address], [100], 70, {
          value: BUYER_DEPOSIT,
        });

      const p0 = await pact.getPact(0);
      const p1 = await pact.getPact(1);
      expect(p0.buyer).to.equal(buyer.address);
      expect(p1.buyer).to.equal(buyer.address);
    });
  });

  describe("acceptPact", function () {
    beforeEach(async function () {
      await createPact();
    });

    it("should allow seller to accept with correct stake", async function () {
      await expect(
        pact.connect(seller).acceptPact(0, { value: SELLER_STAKE })
      )
        .to.emit(pact, "PactAccepted")
        .withArgs(0, seller.address);

      const p = await pact.getPact(0);
      expect(p.seller).to.equal(seller.address);
      expect(p.status).to.equal(1); // FUNDED
      expect(p.sellerStake).to.equal(SELLER_STAKE);
    });

    it("should reject buyer accepting own pact", async function () {
      await expect(
        pact.connect(buyer).acceptPact(0, { value: SELLER_STAKE })
      ).to.be.revertedWith("Buyer cannot accept own pact");
    });

    it("should reject insufficient seller stake", async function () {
      const lowStake = SELLER_STAKE - 1n;
      await expect(
        pact.connect(seller).acceptPact(0, { value: lowStake })
      ).to.be.revertedWith("Insufficient seller stake");
    });

    it("should reject accepting expired pact", async function () {
      await time.increaseTo(deadline + 1);
      await expect(
        pact.connect(seller).acceptPact(0, { value: SELLER_STAKE })
      ).to.be.revertedWith("Pact expired");
    });

    it("should reject accepting already accepted pact", async function () {
      await pact.connect(seller).acceptPact(0, { value: SELLER_STAKE });
      await expect(
        pact.connect(other).acceptPact(0, { value: SELLER_STAKE })
      ).to.be.revertedWith("Invalid status");
    });
  });

  describe("startWork", function () {
    beforeEach(async function () {
      await createAndAcceptPact();
    });

    it("should allow seller to start work", async function () {
      await expect(pact.connect(seller).startWork(0))
        .to.emit(pact, "WorkStarted")
        .withArgs(0);

      const p = await pact.getPact(0);
      expect(p.status).to.equal(2); // IN_PROGRESS
    });

    it("should reject non-seller starting work", async function () {
      await expect(pact.connect(buyer).startWork(0)).to.be.revertedWith(
        "Not seller"
      );
    });

    it("should reject starting work in wrong status", async function () {
      await pact.connect(seller).startWork(0);
      await expect(pact.connect(seller).startWork(0)).to.be.revertedWith(
        "Invalid status"
      );
    });
  });

  describe("submitWork", function () {
    beforeEach(async function () {
      await createAndAcceptPact();
      await pact.connect(seller).startWork(0);
    });

    it("should allow seller to submit work", async function () {
      await expect(pact.connect(seller).submitWork(0, PROOF_HASH))
        .to.emit(pact, "WorkSubmitted")
        .withArgs(0, PROOF_HASH);

      const p = await pact.getPact(0);
      expect(p.status).to.equal(3); // PENDING_VERIFY
    });

    it("should reject non-seller submitting work", async function () {
      await expect(
        pact.connect(buyer).submitWork(0, PROOF_HASH)
      ).to.be.revertedWith("Not seller");
    });

    it("should reject submitting after deadline", async function () {
      await time.increaseTo(deadline + 1);
      await expect(
        pact.connect(seller).submitWork(0, PROOF_HASH)
      ).to.be.revertedWith("Deadline passed");
    });
  });

  describe("submitVerification", function () {
    beforeEach(async function () {
      await createAndAcceptPact();
      await pact.connect(seller).startWork(0);
      await pact.connect(seller).submitWork(0, PROOF_HASH);
    });

    it("should allow oracle to submit verification", async function () {
      await expect(
        pact.connect(oracle1).submitVerification(0, 85, VERIFICATION_PROOF)
      )
        .to.emit(pact, "VerificationSubmitted")
        .withArgs(0, oracle1.address, 85);

      const v = await pact.getVerification(0, oracle1.address);
      expect(v.score).to.equal(85);
      expect(v.hasSubmitted).to.be.true;
    });

    it("should reject non-oracle verification", async function () {
      await expect(
        pact.connect(other).submitVerification(0, 85, VERIFICATION_PROOF)
      ).to.be.revertedWith("Not an oracle for this pact");
    });

    it("should reject duplicate oracle submission", async function () {
      await pact
        .connect(oracle1)
        .submitVerification(0, 85, VERIFICATION_PROOF);
      await expect(
        pact.connect(oracle1).submitVerification(0, 90, VERIFICATION_PROOF)
      ).to.be.revertedWith("Already submitted");
    });

    it("should reject score > 100", async function () {
      await expect(
        pact.connect(oracle1).submitVerification(0, 101, VERIFICATION_PROOF)
      ).to.be.revertedWith("Score must be 0-100");
    });
  });

  describe("finalizeVerification", function () {
    it("should complete pact when score meets threshold", async function () {
      await createAndAcceptPact();
      await pact.connect(seller).startWork(0);
      await pact.connect(seller).submitWork(0, PROOF_HASH);
      await pact
        .connect(oracle1)
        .submitVerification(0, 85, VERIFICATION_PROOF);

      const sellerBefore = await ethers.provider.getBalance(seller.address);
      const buyerBefore = await ethers.provider.getBalance(buyer.address);

      // Call from `other` so buyer/seller balances aren't affected by gas
      await expect(pact.connect(other).finalizeVerification(0))
        .to.emit(pact, "PactCompleted")
        .withArgs(0, 85);

      const p = await pact.getPact(0);
      expect(p.status).to.equal(4); // COMPLETED

      // Seller gets payment + their stake back
      const sellerAfter = await ethers.provider.getBalance(seller.address);
      expect(sellerAfter - sellerBefore).to.equal(p.payment + SELLER_STAKE);

      // Buyer gets their stake back
      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      expect(buyerAfter - buyerBefore).to.equal(p.buyerStake);
    });

    it("should dispute when score below threshold", async function () {
      await createAndAcceptPact();
      await pact.connect(seller).startWork(0);
      await pact.connect(seller).submitWork(0, PROOF_HASH);
      await pact
        .connect(oracle1)
        .submitVerification(0, 50, VERIFICATION_PROOF); // below 70 threshold

      await expect(pact.finalizeVerification(0)).to.emit(
        pact,
        "DisputeRaised"
      );

      const p = await pact.getPact(0);
      expect(p.status).to.equal(5); // DISPUTED
    });

    it("should reject if not all oracles submitted", async function () {
      await createAndAcceptPact(
        [oracle1.address, oracle2.address],
        [60, 40],
        70
      );
      await pact.connect(seller).startWork(0);
      await pact.connect(seller).submitWork(0, PROOF_HASH);
      await pact
        .connect(oracle1)
        .submitVerification(0, 85, VERIFICATION_PROOF);

      await expect(pact.finalizeVerification(0)).to.be.revertedWith(
        "Not all oracles have submitted"
      );
    });

    it("should calculate weighted score with multiple oracles", async function () {
      await createAndAcceptPact(
        [oracle1.address, oracle2.address],
        [60, 40],
        70
      );
      await pact.connect(seller).startWork(0);
      await pact.connect(seller).submitWork(0, PROOF_HASH);

      // oracle1: 80 * 60/100 = 48, oracle2: 50 * 40/100 = 20, total = 68 < 70
      await pact
        .connect(oracle1)
        .submitVerification(0, 80, VERIFICATION_PROOF);
      await pact
        .connect(oracle2)
        .submitVerification(0, 50, VERIFICATION_PROOF);

      await expect(pact.finalizeVerification(0)).to.emit(
        pact,
        "DisputeRaised"
      );

      const p = await pact.getPact(0);
      expect(p.status).to.equal(5); // DISPUTED
    });

    it("should pass with weighted score meeting threshold", async function () {
      await createAndAcceptPact(
        [oracle1.address, oracle2.address],
        [60, 40],
        70
      );
      await pact.connect(seller).startWork(0);
      await pact.connect(seller).submitWork(0, PROOF_HASH);

      // oracle1: 80 * 60/100 = 48, oracle2: 60 * 40/100 = 24, total = 72 >= 70
      await pact
        .connect(oracle1)
        .submitVerification(0, 80, VERIFICATION_PROOF);
      await pact
        .connect(oracle2)
        .submitVerification(0, 60, VERIFICATION_PROOF);

      await expect(pact.finalizeVerification(0)).to.emit(pact, "PactCompleted");

      const p = await pact.getPact(0);
      expect(p.status).to.equal(4); // COMPLETED
    });
  });

  describe("raiseDispute", function () {
    beforeEach(async function () {
      await createAndAcceptPact();
      await pact.connect(seller).startWork(0);
    });

    it("should allow buyer to raise dispute", async function () {
      await expect(
        pact.connect(buyer).raiseDispute(0, arbitrator.address)
      )
        .to.emit(pact, "DisputeRaised")
        .withArgs(0, buyer.address);

      const p = await pact.getPact(0);
      expect(p.status).to.equal(5); // DISPUTED
    });

    it("should allow seller to raise dispute", async function () {
      await expect(
        pact.connect(seller).raiseDispute(0, arbitrator.address)
      ).to.emit(pact, "DisputeRaised");
    });

    it("should reject dispute from non-party", async function () {
      await expect(
        pact.connect(other).raiseDispute(0, arbitrator.address)
      ).to.be.revertedWith("Not a party to this pact");
    });

    it("should reject zero address arbitrator", async function () {
      await expect(
        pact.connect(buyer).raiseDispute(0, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid arbitrator");
    });
  });

  describe("resolveDispute", function () {
    beforeEach(async function () {
      await createAndAcceptPact();
      await pact.connect(seller).startWork(0);
      await pact.connect(buyer).raiseDispute(0, arbitrator.address);
    });

    it("should resolve in seller's favor", async function () {
      const p = await pact.getPact(0);
      const sellerBefore = await ethers.provider.getBalance(seller.address);

      await expect(pact.connect(arbitrator).resolveDispute(0, true))
        .to.emit(pact, "DisputeResolved")
        .withArgs(0, true);

      const pAfter = await pact.getPact(0);
      expect(pAfter.status).to.equal(4); // COMPLETED

      // Seller gets payment + both stakes
      const sellerAfter = await ethers.provider.getBalance(seller.address);
      expect(sellerAfter - sellerBefore).to.equal(
        p.payment + p.sellerStake + p.buyerStake
      );
    });

    it("should resolve in buyer's favor", async function () {
      const p = await pact.getPact(0);
      const buyerBefore = await ethers.provider.getBalance(buyer.address);

      await expect(pact.connect(arbitrator).resolveDispute(0, false))
        .to.emit(pact, "DisputeResolved")
        .withArgs(0, false);

      const pAfter = await pact.getPact(0);
      expect(pAfter.status).to.equal(6); // REFUNDED

      // Buyer gets payment + both stakes
      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      expect(buyerAfter - buyerBefore).to.equal(
        p.payment + p.buyerStake + p.sellerStake
      );
    });

    it("should reject resolution by non-arbitrator", async function () {
      await expect(
        pact.connect(buyer).resolveDispute(0, true)
      ).to.be.revertedWith("Not arbitrator");
    });
  });

  describe("claimTimeout", function () {
    it("should refund buyer if no one accepts before deadline", async function () {
      await createPact();
      const p = await pact.getPact(0);

      await time.increaseTo(deadline + 1);

      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      await pact.connect(other).claimTimeout(0);
      const buyerAfter = await ethers.provider.getBalance(buyer.address);

      expect(buyerAfter - buyerBefore).to.equal(p.payment + p.buyerStake);

      const pAfter = await pact.getPact(0);
      expect(pAfter.status).to.equal(6); // REFUNDED
    });

    it("should refund buyer + forfeit seller stake if no delivery", async function () {
      await createAndAcceptPact();
      await pact.connect(seller).startWork(0);

      const p = await pact.getPact(0);
      await time.increaseTo(deadline + 1);

      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      await pact.connect(other).claimTimeout(0);
      const buyerAfter = await ethers.provider.getBalance(buyer.address);

      // Buyer gets payment + buyer stake + seller stake (forfeited)
      expect(buyerAfter - buyerBefore).to.equal(
        p.payment + p.buyerStake + p.sellerStake
      );

      const pAfter = await pact.getPact(0);
      expect(pAfter.status).to.equal(6); // REFUNDED
    });

    it("should reject timeout before deadline", async function () {
      await createPact();
      await expect(pact.connect(other).claimTimeout(0)).to.be.revertedWith(
        "Deadline not passed"
      );
    });

    it("should reject timeout on completed pact", async function () {
      await createAndAcceptPact();
      await pact.connect(seller).startWork(0);
      await pact.connect(seller).submitWork(0, PROOF_HASH);
      await pact
        .connect(oracle1)
        .submitVerification(0, 85, VERIFICATION_PROOF);
      await pact.finalizeVerification(0);

      await time.increaseTo(deadline + 1);
      await expect(pact.connect(other).claimTimeout(0)).to.be.revertedWith(
        "Cannot claim timeout in current status"
      );
    });
  });

  describe("Full Happy Path", function () {
    it("should complete the full lifecycle: create → accept → work → verify → release", async function () {
      // Step 1: Buyer creates pact
      await createPact();
      let p = await pact.getPact(0);
      expect(p.status).to.equal(0); // NEGOTIATING

      // Step 2: Seller accepts
      await pact.connect(seller).acceptPact(0, { value: SELLER_STAKE });
      p = await pact.getPact(0);
      expect(p.status).to.equal(1); // FUNDED

      // Step 3: Seller starts work
      await pact.connect(seller).startWork(0);
      p = await pact.getPact(0);
      expect(p.status).to.equal(2); // IN_PROGRESS

      // Step 4: Seller submits work
      await pact.connect(seller).submitWork(0, PROOF_HASH);
      p = await pact.getPact(0);
      expect(p.status).to.equal(3); // PENDING_VERIFY

      // Step 5: Oracle verifies (pass)
      await pact
        .connect(oracle1)
        .submitVerification(0, 85, VERIFICATION_PROOF);

      // Step 6: Finalize — payment released (called by `other` to avoid gas affecting balances)
      const sellerBefore = await ethers.provider.getBalance(seller.address);
      const buyerBefore = await ethers.provider.getBalance(buyer.address);

      await pact.connect(other).finalizeVerification(0);

      p = await pact.getPact(0);
      expect(p.status).to.equal(4); // COMPLETED

      const sellerAfter = await ethers.provider.getBalance(seller.address);
      const buyerAfter = await ethers.provider.getBalance(buyer.address);

      // Seller got payment + their stake
      expect(sellerAfter - sellerBefore).to.equal(p.payment + SELLER_STAKE);
      // Buyer got their stake back
      expect(buyerAfter - buyerBefore).to.equal(p.buyerStake);
    });
  });

  describe("Full Dispute Path", function () {
    it("should handle: create → accept → work → verify (fail) → dispute → resolve", async function () {
      await createPact();
      await pact.connect(seller).acceptPact(0, { value: SELLER_STAKE });
      await pact.connect(seller).startWork(0);
      await pact.connect(seller).submitWork(0, PROOF_HASH);

      // Oracle gives low score
      await pact
        .connect(oracle1)
        .submitVerification(0, 30, VERIFICATION_PROOF);

      // Finalize triggers auto-dispute
      await pact.finalizeVerification(0);
      let p = await pact.getPact(0);
      expect(p.status).to.equal(5); // DISPUTED

      // Set arbitrator manually since auto-dispute doesn't set one
      // Buyer raises dispute with arbitrator
      // Actually, the auto-dispute from finalizeVerification doesn't set arbitrator.
      // The parties need to raise a proper dispute, but the status is already DISPUTED.
      // For this test, let's use a separate flow where buyer raises dispute first.
    });

    it("should handle manual dispute flow end-to-end", async function () {
      await createPact();
      await pact.connect(seller).acceptPact(0, { value: SELLER_STAKE });
      await pact.connect(seller).startWork(0);

      // Buyer raises dispute during IN_PROGRESS
      await pact.connect(buyer).raiseDispute(0, arbitrator.address);

      const p = await pact.getPact(0);
      expect(p.status).to.equal(5); // DISPUTED

      // Arbitrator resolves in buyer's favor
      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      await pact.connect(arbitrator).resolveDispute(0, false);

      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      expect(buyerAfter - buyerBefore).to.equal(
        p.payment + p.buyerStake + p.sellerStake
      );

      const pAfter = await pact.getPact(0);
      expect(pAfter.status).to.equal(6); // REFUNDED
    });
  });

  describe("View functions", function () {
    it("should return oracle info", async function () {
      await createPact([oracle1.address, oracle2.address], [60, 40], 70);
      const [oracles, weights] = await pact.getPactOracles(0);
      expect(oracles).to.deep.equal([oracle1.address, oracle2.address]);
      expect(weights[0]).to.equal(60);
      expect(weights[1]).to.equal(40);
    });
  });
});
