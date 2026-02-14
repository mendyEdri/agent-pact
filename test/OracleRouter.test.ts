import { expect } from "chai";
import { ethers } from "hardhat";
import { AgentPact, OracleRouter } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("OracleRouter", function () {
  let pact: AgentPact;
  let router: OracleRouter;
  let owner: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seller: HardhatEthersSigner;
  let validator1: HardhatEthersSigner;
  let validator2: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const PAYMENT = ethers.parseEther("1.0");
  const STAKE_PERCENT = 10n;
  const BUYER_DEPOSIT = PAYMENT + PAYMENT / STAKE_PERCENT; // 1.1 ETH
  const SELLER_STAKE = PAYMENT / STAKE_PERCENT; // 0.1 ETH
  const SPEC_HASH = ethers.keccak256(ethers.toUtf8Bytes("build-a-website"));
  const PROOF_HASH = ethers.keccak256(ethers.toUtf8Bytes("website-deployed"));
  const REVIEW_PERIOD = 3 * 24 * 60 * 60;

  const MIN_VALIDATOR_STAKE = ethers.parseEther("0.5");
  const ROUTER_FEE_BPS = 500n; // 5%
  const JOB_TIMEOUT = 3600; // 1 hour

  const CATEGORY_CODE = ethers.keccak256(ethers.toUtf8Bytes("code-review"));
  const CATEGORY_FLIGHT = ethers.keccak256(ethers.toUtf8Bytes("flight-booking"));
  const CATEGORY_ONCHAIN = ethers.keccak256(ethers.toUtf8Bytes("on-chain-verification"));

  const INITIATOR_BUYER = 0;

  let deadline: number;

  beforeEach(async function () {
    [owner, buyer, seller, validator1, validator2, other] =
      await ethers.getSigners();

    const AgentPact = await ethers.getContractFactory("AgentPact");
    pact = await AgentPact.deploy();

    const OracleRouter = await ethers.getContractFactory("OracleRouter");
    router = await OracleRouter.deploy(MIN_VALIDATOR_STAKE, ROUTER_FEE_BPS, JOB_TIMEOUT);

    deadline = (await time.latest()) + 86400;
  });

  // ──────────────────────────────────────────────
  // Helper: create a pact with the router as oracle
  // ──────────────────────────────────────────────
  async function createPactWithRouter(oracleFee: bigint = ethers.parseEther("0.1")) {
    const deposit = PAYMENT + oracleFee + PAYMENT / STAKE_PERCENT;
    await pact
      .connect(buyer)
      .createPact(
        INITIATOR_BUYER,
        SPEC_HASH,
        deadline,
        [await router.getAddress()],  // Router is the oracle
        [100],
        70, // threshold
        PAYMENT,
        REVIEW_PERIOD,
        oracleFee,
        ethers.ZeroAddress,
        { value: deposit }
      );
    return 0;
  }

  // Helper: register a validator
  async function registerValidator(
    signer: HardhatEthersSigner,
    categories: string[] = [CATEGORY_CODE],
    stake: bigint = MIN_VALIDATOR_STAKE
  ) {
    await router
      .connect(signer)
      .registerValidator(categories, `https://validator.example.com/${signer.address}`, {
        value: stake,
      });
  }

  // Helper: full pact lifecycle up to PENDING_VERIFY
  async function setupPactPendingVerify(oracleFee: bigint = ethers.parseEther("0.1")) {
    const pactId = await createPactWithRouter(oracleFee);

    // Seller accepts
    await pact.connect(seller).acceptPact(pactId, { value: SELLER_STAKE });

    // Seller starts and submits work
    await pact.connect(seller).startWork(pactId);
    await pact.connect(seller).submitWork(pactId, PROOF_HASH);

    return pactId;
  }

  // ──────────────────────────────────────────────
  // Validator Registration
  // ──────────────────────────────────────────────

  describe("Validator Registration", function () {
    it("should register a validator with stake and categories", async function () {
      await registerValidator(validator1, [CATEGORY_CODE, CATEGORY_FLIGHT]);

      const info = await router.getValidatorInfo(validator1.address);
      expect(info.isActive).to.be.true;
      expect(info.stake).to.equal(MIN_VALIDATOR_STAKE);
      expect(info.completedJobs).to.equal(0);
      expect(info.endpoint).to.include(validator1.address);

      const categories = await router.getValidatorCategories(validator1.address);
      expect(categories.length).to.equal(2);
    });

    it("should reject registration with insufficient stake", async function () {
      const lowStake = ethers.parseEther("0.1");
      await expect(
        router
          .connect(validator1)
          .registerValidator([CATEGORY_CODE], "https://v1.example.com", {
            value: lowStake,
          })
      ).to.be.revertedWith("Insufficient stake");
    });

    it("should reject duplicate registration", async function () {
      await registerValidator(validator1);
      await expect(registerValidator(validator1)).to.be.revertedWith(
        "Already registered"
      );
    });

    it("should reject registration with no categories", async function () {
      await expect(
        router
          .connect(validator1)
          .registerValidator([], "https://v1.example.com", {
            value: MIN_VALIDATOR_STAKE,
          })
      ).to.be.revertedWith("Need at least one category");
    });

    it("should deactivate and return stake", async function () {
      await registerValidator(validator1);

      const balBefore = await ethers.provider.getBalance(validator1.address);
      const tx = await router.connect(validator1).deactivateValidator();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(validator1.address);

      expect(balAfter - balBefore + gasCost).to.equal(MIN_VALIDATOR_STAKE);

      const info = await router.getValidatorInfo(validator1.address);
      expect(info.isActive).to.be.false;
    });

    it("should add and remove categories", async function () {
      await registerValidator(validator1, [CATEGORY_CODE]);

      await router.connect(validator1).addCategory(CATEGORY_FLIGHT);
      let cats = await router.getValidatorCategories(validator1.address);
      expect(cats.length).to.equal(2);

      await router.connect(validator1).removeCategory(CATEGORY_CODE);
      expect(await router.validatorHasCategory(validator1.address, CATEGORY_CODE)).to.be.false;
    });
  });

  // ──────────────────────────────────────────────
  // Job Request & Assignment
  // ──────────────────────────────────────────────

  describe("Job Request & Assignment", function () {
    beforeEach(async function () {
      await registerValidator(validator1, [CATEGORY_CODE]);
      await registerValidator(validator2, [CATEGORY_CODE, CATEGORY_FLIGHT]);
    });

    it("should create a verification job with ETH fee", async function () {
      const pactId = await setupPactPendingVerify();
      const fee = ethers.parseEther("0.05");

      const tx = await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: fee }
        );

      await expect(tx).to.emit(router, "JobRequested");

      const job = await router.getJob(0);
      expect(job.pactId).to.equal(pactId);
      expect(job.category).to.equal(CATEGORY_CODE);
      expect(job.fee).to.equal(fee);
      expect(job.status).to.equal(0); // OPEN
    });

    it("should reject duplicate job for same pact", async function () {
      const pactId = await setupPactPendingVerify();
      const fee = ethers.parseEther("0.05");

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: fee }
        );

      await expect(
        router
          .connect(buyer)
          .requestVerification(
            await pact.getAddress(),
            pactId,
            CATEGORY_CODE,
            SPEC_HASH,
            ethers.ZeroAddress,
            { value: fee }
          )
      ).to.be.revertedWith("Job already exists for this pact");
    });

    it("should reject job request with no fee", async function () {
      const pactId = await setupPactPendingVerify();
      await expect(
        router
          .connect(buyer)
          .requestVerification(
            await pact.getAddress(),
            pactId,
            CATEGORY_CODE,
            SPEC_HASH,
            ethers.ZeroAddress
          )
      ).to.be.revertedWith("Fee required");
    });

    it("should reject job for category with no validators", async function () {
      const pactId = await setupPactPendingVerify();
      await expect(
        router
          .connect(buyer)
          .requestVerification(
            await pact.getAddress(),
            pactId,
            CATEGORY_ONCHAIN, // No validators registered for this
            SPEC_HASH,
            ethers.ZeroAddress,
            { value: ethers.parseEther("0.05") }
          )
      ).to.be.revertedWith("No validators for category");
    });

    it("should allow validator to claim a job", async function () {
      const pactId = await setupPactPendingVerify();
      const fee = ethers.parseEther("0.05");

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: fee }
        );

      const tx = await router.connect(validator1).claimJob(0);
      await expect(tx).to.emit(router, "JobAssigned").withArgs(0, validator1.address);

      const job = await router.getJob(0);
      expect(job.status).to.equal(1); // ASSIGNED
      expect(job.assignedValidator).to.equal(validator1.address);
    });

    it("should reject claim from validator without matching category", async function () {
      const pactId = await setupPactPendingVerify();
      const fee = ethers.parseEther("0.05");

      // Register validator3 only for flight-booking
      const [, , , , , , validator3] = await ethers.getSigners();
      await router
        .connect(validator3)
        .registerValidator([CATEGORY_FLIGHT], "https://v3.example.com", {
          value: MIN_VALIDATOR_STAKE,
        });

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: fee }
        );

      await expect(
        router.connect(validator3).claimJob(0)
      ).to.be.revertedWith("Not registered for category");
    });
  });

  // ──────────────────────────────────────────────
  // Validation Submission & Fee Distribution
  // ──────────────────────────────────────────────

  describe("Validation & Fee Distribution", function () {
    const JOB_FEE = ethers.parseEther("0.1");

    beforeEach(async function () {
      await registerValidator(validator1, [CATEGORY_CODE]);
    });

    it("should submit validation and forward to AgentPact", async function () {
      const pactId = await setupPactPendingVerify();

      // Request verification
      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      // Validator claims and submits
      await router.connect(validator1).claimJob(0);

      const verificationProof = ethers.keccak256(ethers.toUtf8Bytes("tests-passed"));
      const tx = await router
        .connect(validator1)
        .submitValidation(0, 85, verificationProof);

      await expect(tx).to.emit(router, "JobCompleted").withArgs(0, validator1.address, 85);

      // Check verification was forwarded to AgentPact
      const verification = await pact.getVerification(pactId, await router.getAddress());
      expect(verification.hasSubmitted).to.be.true;
      expect(verification.score).to.equal(85);
      expect(verification.proof).to.equal(verificationProof);
    });

    it("should split fees correctly between validator and router", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      await router.connect(validator1).claimJob(0);

      const verificationProof = ethers.keccak256(ethers.toUtf8Bytes("verified"));
      await router.connect(validator1).submitValidation(0, 90, verificationProof);

      // Check fee distribution
      // Router fee = 5% of 0.1 ETH = 0.005 ETH
      // Validator fee = 95% of 0.1 ETH = 0.095 ETH
      const expectedRouterFee = (JOB_FEE * ROUTER_FEE_BPS) / 10000n;
      const expectedValidatorFee = JOB_FEE - expectedRouterFee;

      expect(await router.pendingEarnings(validator1.address, ethers.ZeroAddress))
        .to.equal(expectedValidatorFee);
      expect(await router.protocolRevenue(ethers.ZeroAddress))
        .to.equal(expectedRouterFee);
    });

    it("should allow validator to claim earnings", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      await router.connect(validator1).claimJob(0);
      await router
        .connect(validator1)
        .submitValidation(0, 90, ethers.keccak256(ethers.toUtf8Bytes("ok")));

      const expectedValidatorFee = JOB_FEE - (JOB_FEE * ROUTER_FEE_BPS) / 10000n;

      const balBefore = await ethers.provider.getBalance(validator1.address);
      const tx = await router.connect(validator1).claimEarnings(ethers.ZeroAddress);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(validator1.address);

      expect(balAfter - balBefore + gasCost).to.equal(expectedValidatorFee);
      expect(await router.pendingEarnings(validator1.address, ethers.ZeroAddress)).to.equal(0);
    });

    it("should allow owner to claim protocol revenue", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      await router.connect(validator1).claimJob(0);
      await router
        .connect(validator1)
        .submitValidation(0, 90, ethers.keccak256(ethers.toUtf8Bytes("ok")));

      const expectedRouterFee = (JOB_FEE * ROUTER_FEE_BPS) / 10000n;

      const balBefore = await ethers.provider.getBalance(owner.address);
      const tx = await router.connect(owner).claimProtocolRevenue(ethers.ZeroAddress);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(owner.address);

      expect(balAfter - balBefore + gasCost).to.equal(expectedRouterFee);
    });

    it("should reject submission from non-assigned validator", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      await router.connect(validator1).claimJob(0);

      await expect(
        router
          .connect(validator2)
          .submitValidation(0, 90, ethers.keccak256(ethers.toUtf8Bytes("ok")))
      ).to.be.revertedWith("Not assigned validator");
    });

    it("should update validator stats after completion", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      await router.connect(validator1).claimJob(0);
      await router
        .connect(validator1)
        .submitValidation(0, 90, ethers.keccak256(ethers.toUtf8Bytes("ok")));

      const info = await router.getValidatorInfo(validator1.address);
      expect(info.completedJobs).to.equal(1);
      expect(info.totalEarned).to.be.gt(0);
    });
  });

  // ──────────────────────────────────────────────
  // Job Expiry & Reassignment
  // ──────────────────────────────────────────────

  describe("Job Expiry & Reassignment", function () {
    const JOB_FEE = ethers.parseEther("0.05");

    beforeEach(async function () {
      await registerValidator(validator1, [CATEGORY_CODE]);
      await registerValidator(validator2, [CATEGORY_CODE]);
    });

    it("should expire a job if validator doesn't respond in time", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      await router.connect(validator1).claimJob(0);

      // Fast-forward past deadline
      await time.increase(JOB_TIMEOUT + 1);

      const tx = await router.connect(other).expireJob(0);
      await expect(tx).to.emit(router, "JobExpired").withArgs(0, validator1.address);

      const job = await router.getJob(0);
      expect(job.status).to.equal(0); // Back to OPEN
      expect(job.assignedValidator).to.equal(ethers.ZeroAddress);

      // Validator penalized
      const info = await router.getValidatorInfo(validator1.address);
      expect(info.failedJobs).to.equal(1);
    });

    it("should allow another validator to claim an expired job", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      await router.connect(validator1).claimJob(0);
      await time.increase(JOB_TIMEOUT + 1);
      await router.connect(other).expireJob(0);

      // Validator2 picks it up
      await router.connect(validator2).claimJob(0);
      const job = await router.getJob(0);
      expect(job.assignedValidator).to.equal(validator2.address);
      expect(job.status).to.equal(1); // ASSIGNED
    });

    it("should reject expiry before deadline", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      await router.connect(validator1).claimJob(0);

      await expect(router.connect(other).expireJob(0)).to.be.revertedWith(
        "Deadline not passed"
      );
    });
  });

  // ──────────────────────────────────────────────
  // Job Cancellation
  // ──────────────────────────────────────────────

  describe("Job Cancellation", function () {
    const JOB_FEE = ethers.parseEther("0.05");

    beforeEach(async function () {
      await registerValidator(validator1, [CATEGORY_CODE]);
    });

    it("should cancel an open job and refund fee", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      const balBefore = await ethers.provider.getBalance(buyer.address);
      const tx = await router.connect(buyer).cancelJob(0);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(buyer.address);

      expect(balAfter - balBefore + gasCost).to.equal(JOB_FEE);

      const job = await router.getJob(0);
      expect(job.status).to.equal(4); // CANCELLED
    });

    it("should reject cancellation from unauthorized party", async function () {
      const pactId = await setupPactPendingVerify();

      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: JOB_FEE }
        );

      await expect(
        router.connect(other).cancelJob(0)
      ).to.be.revertedWith("Not authorized");
    });
  });

  // ──────────────────────────────────────────────
  // Slashing
  // ──────────────────────────────────────────────

  describe("Slashing", function () {
    it("should slash validator stake", async function () {
      await registerValidator(validator1);

      const slashAmount = ethers.parseEther("0.2");
      await router.connect(owner).slashValidator(validator1.address, slashAmount, "Fraudulent verification");

      const info = await router.getValidatorInfo(validator1.address);
      expect(info.stake).to.equal(MIN_VALIDATOR_STAKE - slashAmount);

      // Slashed amount goes to protocol revenue
      expect(await router.protocolRevenue(ethers.ZeroAddress)).to.equal(slashAmount);
    });

    it("should reject slash from non-owner", async function () {
      await registerValidator(validator1);
      await expect(
        router.connect(other).slashValidator(validator1.address, ethers.parseEther("0.1"), "bad")
      ).to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
    });

    it("should reject slash exceeding stake", async function () {
      await registerValidator(validator1);
      await expect(
        router.connect(owner).slashValidator(validator1.address, ethers.parseEther("999"), "bad")
      ).to.be.revertedWith("Exceeds stake");
    });
  });

  // ──────────────────────────────────────────────
  // Validator Selection
  // ──────────────────────────────────────────────

  describe("Validator Selection", function () {
    it("should return the best validator based on reputation", async function () {
      // Register validator1 with high stake
      await registerValidator(validator1, [CATEGORY_CODE], ethers.parseEther("2.0"));
      // Register validator2 with minimum stake
      await registerValidator(validator2, [CATEGORY_CODE], MIN_VALIDATOR_STAKE);

      // Both new validators — validator1 should rank higher due to higher stake
      const best = await router.getBestValidator(CATEGORY_CODE);
      expect(best).to.equal(validator1.address);
    });

    it("should list all validators for a category", async function () {
      await registerValidator(validator1, [CATEGORY_CODE]);
      await registerValidator(validator2, [CATEGORY_CODE, CATEGORY_FLIGHT]);

      const result = await router.getValidatorsForCategory(CATEGORY_CODE);
      expect(result.addresses.length).to.equal(2);
      expect(result.addresses).to.include(validator1.address);
      expect(result.addresses).to.include(validator2.address);
    });
  });

  // ──────────────────────────────────────────────
  // Full End-to-End: Pact + Router + Validator
  // ──────────────────────────────────────────────

  describe("End-to-End Integration", function () {
    it("should complete full flow: pact → router → validator → verification → approval", async function () {
      await registerValidator(validator1, [CATEGORY_CODE]);

      // 1. Create pact with router as oracle
      const oracleFee = ethers.parseEther("0.1");
      const pactId = await setupPactPendingVerify(oracleFee);

      // 2. Request verification through router
      const jobFee = ethers.parseEther("0.05");
      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: jobFee }
        );

      // 3. Validator claims and verifies
      await router.connect(validator1).claimJob(0);
      const proof = ethers.keccak256(ethers.toUtf8Bytes("all-tests-pass"));
      await router.connect(validator1).submitValidation(0, 85, proof);

      // 4. Finalize verification in AgentPact (score 85 >= threshold 70)
      await pact.connect(buyer).finalizeVerification(pactId);

      // 5. Check pact moved to PENDING_APPROVAL (status = 7)
      const pactInfo = await pact.getPact(pactId);
      expect(pactInfo.status).to.equal(7); // PENDING_APPROVAL

      // 6. Buyer approves → pact completed
      await pact.connect(buyer).approveWork(pactId);
      const finalPact = await pact.getPact(pactId);
      expect(finalPact.status).to.equal(4); // COMPLETED

      // 7. Validator claims earnings from router
      const earnings = await router.pendingEarnings(validator1.address, ethers.ZeroAddress);
      expect(earnings).to.be.gt(0);
      await router.connect(validator1).claimEarnings(ethers.ZeroAddress);
      expect(await router.pendingEarnings(validator1.address, ethers.ZeroAddress)).to.equal(0);
    });

    it("should handle low score → dispute flow", async function () {
      await registerValidator(validator1, [CATEGORY_CODE]);

      const oracleFee = ethers.parseEther("0.1");
      const pactId = await setupPactPendingVerify(oracleFee);

      const jobFee = ethers.parseEther("0.05");
      await router
        .connect(buyer)
        .requestVerification(
          await pact.getAddress(),
          pactId,
          CATEGORY_CODE,
          SPEC_HASH,
          ethers.ZeroAddress,
          { value: jobFee }
        );

      await router.connect(validator1).claimJob(0);

      // Submit LOW score (30 < threshold 70)
      const proof = ethers.keccak256(ethers.toUtf8Bytes("tests-failed"));
      await router.connect(validator1).submitValidation(0, 30, proof);

      // Finalize → should auto-dispute
      await pact.connect(buyer).finalizeVerification(pactId);
      const pactInfo = await pact.getPact(pactId);
      expect(pactInfo.status).to.equal(5); // DISPUTED
    });
  });

  // ──────────────────────────────────────────────
  // Admin
  // ──────────────────────────────────────────────

  describe("Admin", function () {
    it("should update router fee", async function () {
      await router.connect(owner).setRouterFeeBps(1000);
      expect(await router.routerFeeBps()).to.equal(1000);
    });

    it("should reject fee above 50%", async function () {
      await expect(
        router.connect(owner).setRouterFeeBps(5001)
      ).to.be.revertedWith("Fee too high");
    });

    it("should manage pact whitelist", async function () {
      const pactAddr = await pact.getAddress();
      await router.connect(owner).setPactWhitelistEnabled(true);
      await router.connect(owner).setAllowedPactContract(pactAddr, true);
      expect(await router.allowedPactContracts(pactAddr)).to.be.true;
    });

    it("should reject non-whitelisted pact when whitelist is enabled", async function () {
      await registerValidator(validator1, [CATEGORY_CODE]);
      const pactId = await setupPactPendingVerify();

      await router.connect(owner).setPactWhitelistEnabled(true);
      // Don't whitelist the pact contract

      await expect(
        router
          .connect(buyer)
          .requestVerification(
            await pact.getAddress(),
            pactId,
            CATEGORY_CODE,
            SPEC_HASH,
            ethers.ZeroAddress,
            { value: ethers.parseEther("0.05") }
          )
      ).to.be.revertedWith("Pact contract not allowed");
    });
  });
});
