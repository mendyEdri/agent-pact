import { expect } from "chai";
import { ethers } from "hardhat";
import { OracleRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("OracleRegistry", function () {
  let registry: OracleRegistry;
  let owner: HardhatEthersSigner;
  let oracle1: HardhatEthersSigner;
  let oracle2: HardhatEthersSigner;
  let challenger: HardhatEthersSigner;

  const MIN_STAKE = ethers.parseEther("0.1");

  beforeEach(async function () {
    [owner, oracle1, oracle2, challenger] = await ethers.getSigners();
    const OracleRegistry = await ethers.getContractFactory("OracleRegistry");
    registry = await OracleRegistry.deploy(MIN_STAKE);
  });

  describe("Registration", function () {
    it("should register an oracle with sufficient stake", async function () {
      await expect(
        registry.connect(oracle1).registerOracle(["code-review", "testing"], {
          value: MIN_STAKE,
        })
      )
        .to.emit(registry, "OracleRegistered")
        .withArgs(oracle1.address, MIN_STAKE, ["code-review", "testing"]);

      expect(await registry.isRegistered(oracle1.address)).to.be.true;
      expect(await registry.getOracleStake(oracle1.address)).to.equal(MIN_STAKE);
    });

    it("should reject registration with insufficient stake", async function () {
      const lowStake = ethers.parseEther("0.05");
      await expect(
        registry.connect(oracle1).registerOracle(["code-review"], {
          value: lowStake,
        })
      ).to.be.revertedWith("Insufficient stake");
    });

    it("should reject duplicate registration", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], {
        value: MIN_STAKE,
      });
      await expect(
        registry.connect(oracle1).registerOracle(["testing"], {
          value: MIN_STAKE,
        })
      ).to.be.revertedWith("Already registered");
    });

    it("should reject registration with empty capabilities", async function () {
      await expect(
        registry.connect(oracle1).registerOracle([], { value: MIN_STAKE })
      ).to.be.revertedWith("Must have capabilities");
    });

    it("should track oracle count", async function () {
      expect(await registry.getOracleCount()).to.equal(0);
      await registry.connect(oracle1).registerOracle(["code-review"], {
        value: MIN_STAKE,
      });
      expect(await registry.getOracleCount()).to.equal(1);
      await registry.connect(oracle2).registerOracle(["testing"], {
        value: MIN_STAKE,
      });
      expect(await registry.getOracleCount()).to.equal(2);
    });
  });

  describe("Unregistration", function () {
    it("should unregister and return stake", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], {
        value: MIN_STAKE,
      });

      const balanceBefore = await ethers.provider.getBalance(oracle1.address);
      const tx = await registry.connect(oracle1).unregisterOracle();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(oracle1.address);

      expect(balanceAfter + gasUsed - balanceBefore).to.equal(MIN_STAKE);
      expect(await registry.isRegistered(oracle1.address)).to.be.false;
    });

    it("should reject unregistration if not registered", async function () {
      await expect(
        registry.connect(oracle1).unregisterOracle()
      ).to.be.revertedWith("Not registered");
    });
  });

  describe("Challenge", function () {
    it("should allow challenging a registered oracle", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], {
        value: MIN_STAKE,
      });

      await expect(
        registry.connect(challenger).challengeOracle(oracle1.address, "bad verification")
      )
        .to.emit(registry, "OracleChallenged")
        .withArgs(oracle1.address, challenger.address, "bad verification");
    });

    it("should reject challenging unregistered oracle", async function () {
      await expect(
        registry.connect(challenger).challengeOracle(oracle1.address, "evidence")
      ).to.be.revertedWith("Oracle not registered");
    });
  });

  describe("Slashing", function () {
    it("should allow owner to slash oracle stake", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], {
        value: MIN_STAKE,
      });

      const slashAmount = ethers.parseEther("0.05");
      await expect(
        registry.connect(owner).slashOracle(oracle1.address, slashAmount)
      )
        .to.emit(registry, "OracleSlashed")
        .withArgs(oracle1.address, slashAmount);

      expect(await registry.getOracleStake(oracle1.address)).to.equal(
        MIN_STAKE - slashAmount
      );
    });

    it("should reject slashing by non-owner", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], {
        value: MIN_STAKE,
      });

      await expect(
        registry.connect(challenger).slashOracle(oracle1.address, MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("should reject slashing more than staked", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], {
        value: MIN_STAKE,
      });

      const tooMuch = ethers.parseEther("0.2");
      await expect(
        registry.connect(owner).slashOracle(oracle1.address, tooMuch)
      ).to.be.revertedWith("Amount exceeds stake");
    });
  });

  describe("Discovery", function () {
    it("should find oracles by capability", async function () {
      await registry.connect(oracle1).registerOracle(["code-review", "testing"], { value: MIN_STAKE });
      await registry.connect(oracle2).registerOracle(["testing", "security-audit"], { value: MIN_STAKE });

      const codeReviewOracles = await registry.getOraclesByCapability("code-review");
      expect(codeReviewOracles.length).to.equal(1);
      expect(codeReviewOracles[0]).to.equal(oracle1.address);

      const testingOracles = await registry.getOraclesByCapability("testing");
      expect(testingOracles.length).to.equal(2);
      expect(testingOracles).to.include(oracle1.address);
      expect(testingOracles).to.include(oracle2.address);

      const securityOracles = await registry.getOraclesByCapability("security-audit");
      expect(securityOracles.length).to.equal(1);
      expect(securityOracles[0]).to.equal(oracle2.address);
    });

    it("should return empty for unknown capability", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], { value: MIN_STAKE });
      const result = await registry.getOraclesByCapability("unknown");
      expect(result.length).to.equal(0);
    });

    it("should exclude unregistered oracles from capability search", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], { value: MIN_STAKE });
      await registry.connect(oracle2).registerOracle(["code-review"], { value: MIN_STAKE });

      // Unregister oracle1
      await registry.connect(oracle1).unregisterOracle();

      const result = await registry.getOraclesByCapability("code-review");
      expect(result.length).to.equal(1);
      expect(result[0]).to.equal(oracle2.address);
    });

    it("should list registered oracles with pagination", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], { value: MIN_STAKE });
      await registry.connect(oracle2).registerOracle(["testing"], { value: MIN_STAKE });

      const [addresses, stakes, verifications] = await registry.getRegisteredOracles(0, 10);
      expect(addresses.length).to.equal(2);
      expect(addresses[0]).to.equal(oracle1.address);
      expect(addresses[1]).to.equal(oracle2.address);
      expect(stakes[0]).to.equal(MIN_STAKE);
      expect(verifications[0]).to.equal(0);
    });

    it("should skip unregistered oracles in paginated list", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], { value: MIN_STAKE });
      await registry.connect(oracle2).registerOracle(["testing"], { value: MIN_STAKE });
      await registry.connect(oracle1).unregisterOracle();

      const [addresses] = await registry.getRegisteredOracles(0, 10);
      expect(addresses.length).to.equal(1);
      expect(addresses[0]).to.equal(oracle2.address);
    });

    it("should paginate registered oracles correctly", async function () {
      await registry.connect(oracle1).registerOracle(["code-review"], { value: MIN_STAKE });
      await registry.connect(oracle2).registerOracle(["testing"], { value: MIN_STAKE });

      const [page1] = await registry.getRegisteredOracles(0, 1);
      expect(page1.length).to.equal(1);
      expect(page1[0]).to.equal(oracle1.address);

      const [page2] = await registry.getRegisteredOracles(1, 1);
      expect(page2.length).to.equal(1);
      expect(page2[0]).to.equal(oracle2.address);

      // Beyond range
      const [page3] = await registry.getRegisteredOracles(5, 10);
      expect(page3.length).to.equal(0);
    });
  });

  describe("Admin", function () {
    it("should allow owner to update min stake", async function () {
      const newMin = ethers.parseEther("0.5");
      await expect(registry.connect(owner).setMinStake(newMin))
        .to.emit(registry, "MinStakeUpdated")
        .withArgs(newMin);
      expect(await registry.minStake()).to.equal(newMin);
    });

    it("should reject non-owner updating min stake", async function () {
      await expect(
        registry.connect(oracle1).setMinStake(ethers.parseEther("0.5"))
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });
});
