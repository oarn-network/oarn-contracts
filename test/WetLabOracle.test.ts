import { expect } from "chai";
import { ethers } from "hardhat";
import { WetLabOracle, GOVToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("WetLabOracle", function () {
  let oracle: WetLabOracle;
  let govToken: GOVToken;
  let owner: SignerWithAddress;
  let lab1: SignerWithAddress;
  let lab2: SignerWithAddress;
  let lab3: SignerWithAddress;
  let stranger: SignerWithAddress;

  const REWARD_PER_VERIFICATION = ethers.parseEther("100"); // 100 GOV
  const REQUIRED_CONFIRMATIONS = 2;
  const TASK_ID = 1;

  // Sample result data
  const PARAMS_HASH = ethers.keccak256(ethers.toUtf8Bytes("batch-001-params"));
  const MEASURED_VALUE = 6048n; // 60.48%
  const METRIC = "yield_pct";

  async function deployFixture() {
    [owner, lab1, lab2, lab3, stranger] = await ethers.getSigners();

    // Deploy GOVToken — needs treasury and teamVesting addresses
    const GOVTokenFactory = await ethers.getContractFactory("GOVToken");
    govToken = await GOVTokenFactory.deploy(owner.address, owner.address);

    // Mint tokens: owner gets 70% (earlyContributors 40% + publicSale 30%)
    await govToken.executeGenesisDistribution(owner.address, owner.address);

    // Deploy WetLabOracle (oarnRegistry must be non-zero; use a dummy address)
    const WetLabOracleFactory = await ethers.getContractFactory("WetLabOracle");
    oracle = await WetLabOracleFactory.deploy(
      await govToken.getAddress(),
      owner.address, // oarnRegistry — any non-zero address for tests
      REWARD_PER_VERIFICATION,
      REQUIRED_CONFIRMATIONS
    );

    // Fund reward pool: owner approves + deposits
    const poolAmount = ethers.parseEther("10000");
    await govToken.approve(await oracle.getAddress(), poolAmount);
    await oracle.depositRewardPool(poolAmount);

    return { oracle, govToken, owner, lab1, lab2, lab3, stranger };
  }

  // ============ Constructor ============

  describe("Constructor", function () {
    it("stores govToken and oarnRegistry addresses", async function () {
      const { oracle, govToken } = await loadFixture(deployFixture);
      expect(await oracle.govToken()).to.equal(await govToken.getAddress());
    });

    it("sets rewardPerVerification", async function () {
      const { oracle } = await loadFixture(deployFixture);
      expect(await oracle.rewardPerVerification()).to.equal(REWARD_PER_VERIFICATION);
    });

    it("sets requiredLabConfirmations", async function () {
      const { oracle } = await loadFixture(deployFixture);
      expect(await oracle.requiredLabConfirmations()).to.equal(REQUIRED_CONFIRMATIONS);
    });

    it("reverts with zero address for govToken", async function () {
      const WetLabOracleFactory = await ethers.getContractFactory("WetLabOracle");
      await expect(
        WetLabOracleFactory.deploy(ethers.ZeroAddress, ethers.ZeroAddress, 0, 2)
      ).to.be.revertedWith("Invalid GOV token address");
    });

    it("reverts when requiredConfirmations < 2", async function () {
      const { oracle: _o, govToken: gov } = await loadFixture(deployFixture);
      const WetLabOracleFactory = await ethers.getContractFactory("WetLabOracle");
      const govAddr = await gov.getAddress();
      await expect(
        WetLabOracleFactory.deploy(govAddr, owner.address, 0, 1)
      ).to.be.revertedWith("Need at least 2 confirmations");
    });
  });

  // ============ Lab Certification ============

  describe("Lab Certification", function () {
    it("owner can certify a lab", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await expect(oracle.certifyLab(lab1.address))
        .to.emit(oracle, "LabCertified")
        .withArgs(lab1.address);
      expect(await oracle.certifiedLabs(lab1.address)).to.be.true;
      expect(await oracle.isLabCertified(lab1.address)).to.be.true;
    });

    it("owner can decertify a lab", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await expect(oracle.decertifyLab(lab1.address))
        .to.emit(oracle, "LabDecertified")
        .withArgs(lab1.address);
      expect(await oracle.certifiedLabs(lab1.address)).to.be.false;
    });

    it("non-owner cannot certify", async function () {
      const { oracle, lab1, stranger } = await loadFixture(deployFixture);
      await expect(oracle.connect(stranger).certifyLab(lab1.address))
        .to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    });

    it("non-owner cannot decertify", async function () {
      const { oracle, lab1, stranger } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await expect(oracle.connect(stranger).decertifyLab(lab1.address))
        .to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    });

    it("reverts certifyLab for already-certified lab", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await expect(oracle.certifyLab(lab1.address)).to.be.revertedWith("Already certified");
    });

    it("reverts decertifyLab for non-certified lab", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await expect(oracle.decertifyLab(lab1.address)).to.be.revertedWith("Not certified");
    });
  });

  // ============ Result Submission ============

  describe("Result Submission", function () {
    it("certified lab can submit a result", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);

      const expectedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "int256", "string"],
          [PARAMS_HASH, MEASURED_VALUE, METRIC]
        )
      );

      await expect(oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC))
        .to.emit(oracle, "ResultSubmitted")
        .withArgs(TASK_ID, lab1.address, expectedHash);
    });

    it("uncertified lab cannot submit", async function () {
      const { oracle, stranger } = await loadFixture(deployFixture);
      await expect(
        oracle.connect(stranger).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC)
      ).to.be.revertedWith("Not a certified lab");
    });

    it("lab cannot submit twice for the same task", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      await expect(
        oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC)
      ).to.be.revertedWith("Already submitted for this task");
    });

    it("stores lab result data correctly", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);

      const result = await oracle.labResults(TASK_ID, lab1.address);
      expect(result.measuredValue).to.equal(MEASURED_VALUE);
      expect(result.metric).to.equal(METRIC);
      expect(result.parametersHash).to.equal(PARAMS_HASH);
      expect(result.submittedAt).to.be.gt(0);
      expect(result.rewarded).to.be.false;
    });

    it("tracks submitters via getTaskSubmitters", async function () {
      const { oracle, lab1, lab2 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.certifyLab(lab2.address);
      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      await oracle.connect(lab2).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);

      const submitters = await oracle.getTaskSubmitters(TASK_ID);
      expect(submitters).to.include(lab1.address);
      expect(submitters).to.include(lab2.address);
    });

    it("reverts with empty metric", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await expect(
        oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, "")
      ).to.be.revertedWith("Metric cannot be empty");
    });
  });

  // ============ Consensus ============

  describe("Consensus", function () {
    it("single lab submission does not trigger consensus", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);

      const c = await oracle.consensus(TASK_ID);
      expect(c.reached).to.be.false;
    });

    it("two labs with same hash trigger consensus", async function () {
      const { oracle, lab1, lab2 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.certifyLab(lab2.address);

      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);

      const expectedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "int256", "string"],
          [PARAMS_HASH, MEASURED_VALUE, METRIC]
        )
      );

      await expect(oracle.connect(lab2).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC))
        .to.emit(oracle, "ConsensusReached")
        .withArgs(TASK_ID, expectedHash, 2);

      const c = await oracle.consensus(TASK_ID);
      expect(c.reached).to.be.true;
      expect(c.agreedHash).to.equal(expectedHash);
      expect(c.confirmingLabCount).to.equal(2);
    });

    it("two labs with different hashes do not trigger consensus", async function () {
      const { oracle, lab1, lab2 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.certifyLab(lab2.address);

      const differentValue = 5000n; // different measured value

      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      await oracle.connect(lab2).submitResult(TASK_ID, PARAMS_HASH, differentValue, METRIC);

      const c = await oracle.consensus(TASK_ID);
      expect(c.reached).to.be.false;
    });

    it("getVerifiedResult reverts when no consensus", async function () {
      const { oracle } = await loadFixture(deployFixture);
      await expect(oracle.getVerifiedResult(TASK_ID)).to.be.revertedWith("No consensus yet");
    });

    it("getVerifiedResult returns correct data after consensus", async function () {
      const { oracle, lab1, lab2 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.certifyLab(lab2.address);
      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      await oracle.connect(lab2).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);

      const [agreedHash, confirmingLabCount, confirmingLabs] = await oracle.getVerifiedResult(TASK_ID);
      expect(confirmingLabCount).to.equal(2);
      expect(confirmingLabs).to.include(lab1.address);
      expect(confirmingLabs).to.include(lab2.address);
    });

    it("third lab submission after consensus does not re-emit ConsensusReached", async function () {
      const { oracle, lab1, lab2, lab3 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.certifyLab(lab2.address);
      await oracle.certifyLab(lab3.address);

      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      await oracle.connect(lab2).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);

      // Third submission — consensus already reached, should NOT emit ConsensusReached
      const tx = await oracle.connect(lab3).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      const receipt = await tx.wait();
      const oracleInterface = oracle.interface;
      const consensusEvents = receipt!.logs
        .map(log => { try { return oracleInterface.parseLog(log); } catch { return null; } })
        .filter(e => e?.name === "ConsensusReached");
      expect(consensusEvents.length).to.equal(0);
    });
  });

  // ============ Rewards ============

  describe("Rewards", function () {
    it("pendingRewards credited to confirming labs after consensus", async function () {
      const { oracle, lab1, lab2 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.certifyLab(lab2.address);
      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      await oracle.connect(lab2).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);

      expect(await oracle.pendingRewards(lab1.address)).to.equal(REWARD_PER_VERIFICATION);
      expect(await oracle.pendingRewards(lab2.address)).to.equal(REWARD_PER_VERIFICATION);
    });

    it("claimReward transfers GOV tokens to lab", async function () {
      const { oracle, govToken, lab1, lab2 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.certifyLab(lab2.address);
      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      await oracle.connect(lab2).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);

      const balanceBefore = await govToken.balanceOf(lab1.address);
      await expect(oracle.connect(lab1).claimReward())
        .to.emit(oracle, "RewardClaimed")
        .withArgs(lab1.address, REWARD_PER_VERIFICATION);

      const balanceAfter = await govToken.balanceOf(lab1.address);
      expect(balanceAfter - balanceBefore).to.equal(REWARD_PER_VERIFICATION);
      expect(await oracle.pendingRewards(lab1.address)).to.equal(0);
    });

    it("claimReward reverts when no pending rewards", async function () {
      const { oracle, lab1 } = await loadFixture(deployFixture);
      await expect(oracle.connect(lab1).claimReward()).to.be.revertedWith("No pending rewards");
    });

    it("labs with no reward get zero pendingRewards after consensus (non-confirming)", async function () {
      const { oracle, lab1, lab2, lab3 } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      await oracle.certifyLab(lab2.address);
      await oracle.certifyLab(lab3.address);

      // lab1 and lab2 agree, lab3 has different value
      const differentValue = 5000n;
      await oracle.connect(lab1).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      await oracle.connect(lab2).submitResult(TASK_ID, PARAMS_HASH, MEASURED_VALUE, METRIC);
      await oracle.connect(lab3).submitResult(TASK_ID, PARAMS_HASH, differentValue, METRIC);

      expect(await oracle.pendingRewards(lab3.address)).to.equal(0);
      expect(await oracle.pendingRewards(lab1.address)).to.equal(REWARD_PER_VERIFICATION);
    });
  });

  // ============ Admin ============

  describe("Admin", function () {
    it("setRewardPerVerification updates reward", async function () {
      const { oracle } = await loadFixture(deployFixture);
      const newReward = ethers.parseEther("200");
      await expect(oracle.setRewardPerVerification(newReward))
        .to.emit(oracle, "RewardPerVerificationUpdated")
        .withArgs(newReward);
      expect(await oracle.rewardPerVerification()).to.equal(newReward);
    });

    it("setRequiredConfirmations updates threshold", async function () {
      const { oracle } = await loadFixture(deployFixture);
      await expect(oracle.setRequiredConfirmations(3))
        .to.emit(oracle, "RequiredConfirmationsUpdated")
        .withArgs(3);
      expect(await oracle.requiredLabConfirmations()).to.equal(3);
    });

    it("setRequiredConfirmations reverts when < 2", async function () {
      const { oracle } = await loadFixture(deployFixture);
      await expect(oracle.setRequiredConfirmations(1)).to.be.revertedWith("Need at least 2 confirmations");
    });

    it("depositRewardPool increases contract GOV balance", async function () {
      const { oracle, govToken } = await loadFixture(deployFixture);
      const extra = ethers.parseEther("500");
      await govToken.approve(await oracle.getAddress(), extra);
      const balanceBefore = await oracle.rewardPoolBalance();
      await expect(oracle.depositRewardPool(extra))
        .to.emit(oracle, "RewardPoolDeposited")
        .withArgs(extra);
      expect(await oracle.rewardPoolBalance()).to.equal(balanceBefore + extra);
    });

    it("non-owner cannot call admin functions", async function () {
      const { oracle, stranger } = await loadFixture(deployFixture);
      await expect(oracle.connect(stranger).setRewardPerVerification(0))
        .to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
      await expect(oracle.connect(stranger).setRequiredConfirmations(2))
        .to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    });
  });

  // ============ View Functions ============

  describe("View Functions", function () {
    it("isLabCertified returns correct boolean", async function () {
      const { oracle, lab1, stranger } = await loadFixture(deployFixture);
      await oracle.certifyLab(lab1.address);
      expect(await oracle.isLabCertified(lab1.address)).to.be.true;
      expect(await oracle.isLabCertified(stranger.address)).to.be.false;
    });

    it("getTaskSubmitters returns empty for fresh task", async function () {
      const { oracle } = await loadFixture(deployFixture);
      expect(await oracle.getTaskSubmitters(999)).to.deep.equal([]);
    });

    it("rewardPoolBalance returns GOV balance of contract", async function () {
      const { oracle, govToken } = await loadFixture(deployFixture);
      const balance = await govToken.balanceOf(await oracle.getAddress());
      expect(await oracle.rewardPoolBalance()).to.equal(balance);
    });
  });
});
