import { expect } from "chai";
import { ethers } from "hardhat";
import { TaskRegistryV2, COMPToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("TaskRegistryV2", function () {
  let taskRegistry: TaskRegistryV2;
  let compToken: COMPToken;
  let owner: SignerWithAddress;
  let requester: SignerWithAddress;
  let node1: SignerWithAddress;
  let node2: SignerWithAddress;
  let node3: SignerWithAddress;
  let node4: SignerWithAddress;
  let node5: SignerWithAddress;

  const MIN_REWARD = ethers.parseEther("0.001");
  const ONE_HOUR = 3600;
  const ONE_DAY = 86400;

  async function deployFixture() {
    [owner, requester, node1, node2, node3, node4, node5] = await ethers.getSigners();

    // Deploy COMP Token as reward token
    const COMPToken = await ethers.getContractFactory("COMPToken");
    compToken = await COMPToken.deploy();

    // Deploy TaskRegistryV2
    const TaskRegistryV2 = await ethers.getContractFactory("TaskRegistryV2");
    taskRegistry = await TaskRegistryV2.deploy(await compToken.getAddress());

    return { taskRegistry, compToken, owner, requester, node1, node2, node3, node4, node5 };
  }

  describe("Constructor", function () {
    it("should set correct token reward address", async function () {
      const { taskRegistry, compToken } = await loadFixture(deployFixture);
      expect(await taskRegistry.tokenReward()).to.equal(await compToken.getAddress());
    });

    it("should set owner correctly", async function () {
      const { taskRegistry, owner } = await loadFixture(deployFixture);
      expect(await taskRegistry.owner()).to.equal(owner.address);
    });

    it("should start with zero task count", async function () {
      const { taskRegistry } = await loadFixture(deployFixture);
      expect(await taskRegistry.taskCount()).to.equal(0);
    });

    it("should set default minimum reward", async function () {
      const { taskRegistry } = await loadFixture(deployFixture);
      expect(await taskRegistry.minRewardPerNode()).to.equal(MIN_REWARD);
    });

    it("should set default thresholds", async function () {
      const { taskRegistry } = await loadFixture(deployFixture);
      expect(await taskRegistry.majorityThreshold()).to.equal(5001);
      expect(await taskRegistry.superMajorityThreshold()).to.equal(6667);
    });

    it("should revert with zero address for token reward", async function () {
      const TaskRegistryV2 = await ethers.getContractFactory("TaskRegistryV2");
      await expect(
        TaskRegistryV2.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid token reward address");
    });
  });

  describe("Task Submission", function () {
    it("should create a task with majority consensus", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const inputHash = ethers.keccak256(ethers.toUtf8Bytes("input-data"));
      const rewardPerNode = ethers.parseEther("0.01");
      const requiredNodes = 3;
      const deadline = (await time.latest()) + ONE_DAY;

      // Use the 7-param version directly to ensure msg.sender is preserved
      const tx = await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        inputHash,
        '{"min_vram": "8GB"}',
        rewardPerNode,
        requiredNodes,
        deadline,
        0, // Majority
        { value: rewardPerNode * BigInt(requiredNodes) }
      );

      await expect(tx).to.emit(taskRegistry, "TaskCreated");

      const task = await taskRegistry.tasks(1);
      expect(task.requester).to.equal(requester.address);
      expect(task.modelHash).to.equal(modelHash);
      expect(task.rewardPerNode).to.equal(rewardPerNode);
      expect(task.requiredNodes).to.equal(requiredNodes);
      expect(task.status).to.equal(0); // Pending
      expect(task.consensusType).to.equal(0); // Majority
    });

    it("should create a task with supermajority consensus", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const inputHash = ethers.keccak256(ethers.toUtf8Bytes("input-data"));
      const rewardPerNode = ethers.parseEther("0.01");
      const requiredNodes = 3;
      const deadline = (await time.latest()) + ONE_DAY;

      const tx = await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        inputHash,
        "{}",
        rewardPerNode,
        requiredNodes,
        deadline,
        1, // SuperMajority
        { value: rewardPerNode * BigInt(requiredNodes) }
      );

      await expect(tx).to.emit(taskRegistry, "TaskCreated");

      const task = await taskRegistry.tasks(1);
      expect(task.consensusType).to.equal(1); // SuperMajority
    });

    it("should create a task with unanimous consensus", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const inputHash = ethers.keccak256(ethers.toUtf8Bytes("input-data"));
      const rewardPerNode = ethers.parseEther("0.01");
      const requiredNodes = 3;
      const deadline = (await time.latest()) + ONE_DAY;

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        inputHash,
        "{}",
        rewardPerNode,
        requiredNodes,
        deadline,
        2, // Unanimous
        { value: rewardPerNode * BigInt(requiredNodes) }
      );

      const task = await taskRegistry.tasks(1);
      expect(task.consensusType).to.equal(2); // Unanimous
    });

    it("should reject task with insufficient payment", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const inputHash = ethers.keccak256(ethers.toUtf8Bytes("input-data"));

      await expect(
        taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
          modelHash,
          inputHash,
          "{}",
          ethers.parseEther("0.01"),
          3,
          (await time.latest()) + ONE_DAY,
          { value: ethers.parseEther("0.01") } // Not enough
        )
      ).to.be.revertedWith("Insufficient payment");
    });

    it("should reject task with less than 3 nodes", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));

      await expect(
        taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
          modelHash,
          modelHash,
          "{}",
          ethers.parseEther("0.01"),
          2, // Too few nodes
          (await time.latest()) + ONE_DAY,
          { value: ethers.parseEther("0.02") }
        )
      ).to.be.revertedWith("Need at least 3 nodes for consensus");
    });

    it("should reject task with more than 100 nodes", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));

      await expect(
        taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
          modelHash,
          modelHash,
          "{}",
          ethers.parseEther("0.01"),
          101, // Too many nodes
          (await time.latest()) + ONE_DAY,
          { value: ethers.parseEther("1.01") }
        )
      ).to.be.revertedWith("Too many nodes");
    });

    it("should reject task with past deadline", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));

      await expect(
        taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
          modelHash,
          modelHash,
          "{}",
          ethers.parseEther("0.01"),
          3,
          (await time.latest()) - ONE_HOUR, // Past deadline
          { value: ethers.parseEther("0.03") }
        )
      ).to.be.revertedWith("Invalid deadline");
    });

    it("should reject task with reward below minimum", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));

      await expect(
        taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
          modelHash,
          modelHash,
          "{}",
          ethers.parseEther("0.0001"), // Below minimum
          3,
          (await time.latest()) + ONE_DAY,
          { value: ethers.parseEther("0.0003") }
        )
      ).to.be.revertedWith("Reward too low");
    });

    it("should reject task with invalid model hash", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      await expect(
        taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
          ethers.ZeroHash, // Invalid
          ethers.keccak256(ethers.toUtf8Bytes("input")),
          "{}",
          ethers.parseEther("0.01"),
          3,
          (await time.latest()) + ONE_DAY,
          { value: ethers.parseEther("0.03") }
        )
      ).to.be.revertedWith("Invalid model hash");
    });

    it("should refund excess payment", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const rewardPerNode = ethers.parseEther("0.01");
      const requiredPayment = rewardPerNode * 3n;
      const excess = ethers.parseEther("0.05");

      const balanceBefore = await ethers.provider.getBalance(requester.address);

      const tx = await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        modelHash,
        "{}",
        rewardPerNode,
        3,
        (await time.latest()) + ONE_DAY,
        0, // Majority
        { value: requiredPayment + excess }
      );

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(requester.address);
      // Balance should be reduced by the required payment + gas (excess refunded)
      expect(balanceBefore - balanceAfter).to.equal(requiredPayment + gasUsed);
    });

    it("should increment task count", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));

      expect(await taskRegistry.taskCount()).to.equal(0);

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      expect(await taskRegistry.taskCount()).to.equal(1);
      expect(await taskRegistry.activeTaskCount()).to.equal(1);
    });
  });

  describe("Task Claiming", function () {
    async function createTask() {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      return { taskRegistry, requester };
    }

    it("should allow nodes to claim tasks", async function () {
      const { taskRegistry } = await loadFixture(deployFixture);
      const { node1 } = await ethers.getSigners().then(s => ({ node1: s[3] }));

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      await taskRegistry.connect((await ethers.getSigners())[1])["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await expect(taskRegistry.connect(node1).claimTask(1))
        .to.emit(taskRegistry, "TaskClaimed")
        .withArgs(1, node1.address);

      expect(await taskRegistry.hasClaimedTask(1, node1.address)).to.be.true;
    });

    it("should update task status to Active on first claim", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      let task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(0); // Pending

      await taskRegistry.connect(node1).claimTask(1);

      task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(1); // Active
    });

    it("should prevent double claiming by same node", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);

      await expect(
        taskRegistry.connect(node1).claimTask(1)
      ).to.be.revertedWith("Already claimed");
    });

    it("should reject claim for non-existent task", async function () {
      const { taskRegistry, node1 } = await loadFixture(deployFixture);

      await expect(
        taskRegistry.connect(node1).claimTask(999)
      ).to.be.revertedWith("Task not found");
    });

    it("should reject claim for expired task", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_HOUR,
        { value: ethers.parseEther("0.03") }
      );

      await time.increase(ONE_HOUR + 1);

      await expect(
        taskRegistry.connect(node1).claimTask(1)
      ).to.be.revertedWith("Task expired");
    });

    it("should allow 2x overclaiming", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);
      const signers = await ethers.getSigners();

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3, // requiredNodes = 3, max claims = 6
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      // 6 nodes can claim
      for (let i = 0; i < 6; i++) {
        await taskRegistry.connect(signers[i + 2]).claimTask(1);
      }

      const task = await taskRegistry.tasks(1);
      expect(task.claimedCount).to.equal(6);
    });
  });

  describe("Result Submission", function () {
    it("should accept valid results", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-data"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);

      await expect(taskRegistry.connect(node1).submitResult(1, resultHash))
        .to.emit(taskRegistry, "ResultSubmitted")
        .withArgs(1, node1.address, resultHash);
    });

    it("should reject results from non-claimers", async function () {
      const { taskRegistry, requester, node1, node2 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-data"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);

      await expect(
        taskRegistry.connect(node2).submitResult(1, resultHash)
      ).to.be.revertedWith("Not claimed");
    });

    it("should reject double submissions", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-data"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node1).submitResult(1, resultHash);

      await expect(
        taskRegistry.connect(node1).submitResult(1, resultHash)
      ).to.be.revertedWith("Already submitted");
    });

    it("should reject invalid result hash", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);

      await expect(
        taskRegistry.connect(node1).submitResult(1, ethers.ZeroHash)
      ).to.be.revertedWith("Invalid result hash");
    });

    it("should track unique result hashes", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const resultHash1 = ethers.keccak256(ethers.toUtf8Bytes("result-1"));
      const resultHash2 = ethers.keccak256(ethers.toUtf8Bytes("result-2"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      await taskRegistry.connect(node1).submitResult(1, resultHash1);
      await taskRegistry.connect(node2).submitResult(1, resultHash1);
      // Third submission triggers consensus

      expect(await taskRegistry.resultHashCounts(1, resultHash1)).to.equal(2);
    });
  });

  describe("Consensus Calculation", function () {
    it("should reach majority consensus (>50%)", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const sameResult = ethers.keccak256(ethers.toUtf8Bytes("same-result"));
      const differentResult = ethers.keccak256(ethers.toUtf8Bytes("different-result"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      await taskRegistry.connect(node1).submitResult(1, sameResult);
      await taskRegistry.connect(node2).submitResult(1, sameResult);

      const tx = await taskRegistry.connect(node3).submitResult(1, differentResult);

      // 2/3 = 66.67% which is > 50%, consensus reached
      await expect(tx).to.emit(taskRegistry, "ConsensusReached");

      const task = await taskRegistry.tasks(1);
      expect(task.consensusResult).to.equal(sameResult);
      expect(task.status).to.equal(3); // Completed
    });

    it("should reach unanimous consensus (100%)", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const sameResult = ethers.keccak256(ethers.toUtf8Bytes("same-result"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        2, // Unanimous
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      await taskRegistry.connect(node1).submitResult(1, sameResult);
      await taskRegistry.connect(node2).submitResult(1, sameResult);

      const tx = await taskRegistry.connect(node3).submitResult(1, sameResult);

      await expect(tx).to.emit(taskRegistry, "ConsensusReached");

      const task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(3); // Completed
    });

    it("should enter dispute when unanimous consensus fails", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const sameResult = ethers.keccak256(ethers.toUtf8Bytes("same-result"));
      const differentResult = ethers.keccak256(ethers.toUtf8Bytes("different-result"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        2, // Unanimous
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      await taskRegistry.connect(node1).submitResult(1, sameResult);
      await taskRegistry.connect(node2).submitResult(1, sameResult);

      const tx = await taskRegistry.connect(node3).submitResult(1, differentResult);

      // 2/3 = 66.67% but unanimous requires 100%
      await expect(tx).to.emit(taskRegistry, "ConsensusDisputed");

      const task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(4); // Disputed
    });

    it("should distribute rewards only to matching nodes", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const sameResult = ethers.keccak256(ethers.toUtf8Bytes("same-result"));
      const differentResult = ethers.keccak256(ethers.toUtf8Bytes("different-result"));
      const rewardPerNode = ethers.parseEther("0.01");

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        rewardPerNode,
        3,
        (await time.latest()) + ONE_DAY,
        { value: rewardPerNode * 3n }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      const node1BalanceBefore = await ethers.provider.getBalance(node1.address);
      const node2BalanceBefore = await ethers.provider.getBalance(node2.address);
      const node3BalanceBefore = await ethers.provider.getBalance(node3.address);

      await taskRegistry.connect(node1).submitResult(1, sameResult);
      await taskRegistry.connect(node2).submitResult(1, sameResult);
      await taskRegistry.connect(node3).submitResult(1, differentResult);

      const node1BalanceAfter = await ethers.provider.getBalance(node1.address);
      const node2BalanceAfter = await ethers.provider.getBalance(node2.address);
      const node3BalanceAfter = await ethers.provider.getBalance(node3.address);

      // node1 and node2 should have received rewards
      expect(node1BalanceAfter - node1BalanceBefore).to.be.gt(0);
      expect(node2BalanceAfter - node2BalanceBefore).to.be.gt(0);
      // node3 spent gas but got no reward
      expect(node3BalanceAfter).to.be.lt(node3BalanceBefore);
    });
  });

  describe("Consensus Status", function () {
    it("should return correct consensus status", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const sameResult = ethers.keccak256(ethers.toUtf8Bytes("same-result"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      await taskRegistry.connect(node1).submitResult(1, sameResult);
      await taskRegistry.connect(node2).submitResult(1, sameResult);
      await taskRegistry.connect(node3).submitResult(1, sameResult);

      const [winningHash, winningCount, totalSubmissions, reached, uniqueResults] =
        await taskRegistry.getConsensusStatus(1);

      expect(winningHash).to.equal(sameResult);
      expect(winningCount).to.equal(3);
      expect(totalSubmissions).to.equal(3);
      expect(reached).to.be.true;
      expect(uniqueResults).to.equal(1);
    });
  });

  describe("Dispute Resolution", function () {
    it("should allow owner to resolve dispute", async function () {
      const { taskRegistry, owner, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const result1 = ethers.keccak256(ethers.toUtf8Bytes("result-1"));
      const result2 = ethers.keccak256(ethers.toUtf8Bytes("result-2"));
      const result3 = ethers.keccak256(ethers.toUtf8Bytes("result-3"));

      // Create task with unanimous consensus (will dispute)
      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        2, // Unanimous
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      // All different results - no consensus
      await taskRegistry.connect(node1).submitResult(1, result1);
      await taskRegistry.connect(node2).submitResult(1, result2);
      await taskRegistry.connect(node3).submitResult(1, result3);

      let task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(4); // Disputed

      // Owner resolves
      await taskRegistry.connect(owner).resolveDispute(1, result1);

      task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(3); // Completed
      expect(task.consensusResult).to.equal(result1);
    });

    it("should reject dispute resolution by non-owner", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const result1 = ethers.keccak256(ethers.toUtf8Bytes("result-1"));
      const result2 = ethers.keccak256(ethers.toUtf8Bytes("result-2"));
      const result3 = ethers.keccak256(ethers.toUtf8Bytes("result-3"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        2, // Unanimous
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      await taskRegistry.connect(node1).submitResult(1, result1);
      await taskRegistry.connect(node2).submitResult(1, result2);
      await taskRegistry.connect(node3).submitResult(1, result3);

      await expect(
        taskRegistry.connect(node1).resolveDispute(1, result1)
      ).to.be.revertedWithCustomError(taskRegistry, "OwnableUnauthorizedAccount");
    });

    it("should allow refund of disputed task after deadline", async function () {
      const { taskRegistry, owner, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const result1 = ethers.keccak256(ethers.toUtf8Bytes("result-1"));
      const result2 = ethers.keccak256(ethers.toUtf8Bytes("result-2"));
      const result3 = ethers.keccak256(ethers.toUtf8Bytes("result-3"));
      const rewardPerNode = ethers.parseEther("0.01");

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        modelHash,
        "{}",
        rewardPerNode,
        3,
        (await time.latest()) + ONE_DAY,
        2, // Unanimous
        { value: rewardPerNode * 3n }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      await taskRegistry.connect(node1).submitResult(1, result1);
      await taskRegistry.connect(node2).submitResult(1, result2);
      await taskRegistry.connect(node3).submitResult(1, result3);

      // Wait for dispute window
      await time.increase(ONE_HOUR + 1);

      const balanceBefore = await ethers.provider.getBalance(requester.address);

      await taskRegistry.connect(owner).refundDisputedTask(1);

      const balanceAfter = await ethers.provider.getBalance(requester.address);
      expect(balanceAfter - balanceBefore).to.equal(rewardPerNode * 3n);

      const task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(5); // Cancelled
    });
  });

  describe("View Functions", function () {
    it("should return task results", async function () {
      const { taskRegistry, requester, node1, node2 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node1).submitResult(1, resultHash);

      const results = await taskRegistry.getTaskResults(1);
      expect(results.length).to.equal(1);
      expect(results[0].node).to.equal(node1.address);
      expect(results[0].resultHash).to.equal(resultHash);
    });

    it("should check if node matched consensus", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const sameResult = ethers.keccak256(ethers.toUtf8Bytes("same-result"));
      const differentResult = ethers.keccak256(ethers.toUtf8Bytes("different-result"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      await taskRegistry.connect(node1).submitResult(1, sameResult);
      await taskRegistry.connect(node2).submitResult(1, sameResult);
      await taskRegistry.connect(node3).submitResult(1, differentResult);

      expect(await taskRegistry.didNodeMatchConsensus(1, node1.address)).to.be.true;
      expect(await taskRegistry.didNodeMatchConsensus(1, node2.address)).to.be.true;
      expect(await taskRegistry.didNodeMatchConsensus(1, node3.address)).to.be.false;
    });
  });

  describe("Admin Functions", function () {
    it("should update minimum reward", async function () {
      const { taskRegistry, owner } = await loadFixture(deployFixture);

      const newMin = ethers.parseEther("0.005");
      await taskRegistry.connect(owner).setMinRewardPerNode(newMin);
      expect(await taskRegistry.minRewardPerNode()).to.equal(newMin);
    });

    it("should update majority threshold", async function () {
      const { taskRegistry, owner } = await loadFixture(deployFixture);

      await taskRegistry.connect(owner).setMajorityThreshold(5500);
      expect(await taskRegistry.majorityThreshold()).to.equal(5500);
    });

    it("should reject invalid majority threshold", async function () {
      const { taskRegistry, owner } = await loadFixture(deployFixture);

      await expect(
        taskRegistry.connect(owner).setMajorityThreshold(5000) // Must be >5000
      ).to.be.revertedWith("Invalid threshold");
    });

    it("should update supermajority threshold", async function () {
      const { taskRegistry, owner } = await loadFixture(deployFixture);

      await taskRegistry.connect(owner).setSuperMajorityThreshold(7000);
      expect(await taskRegistry.superMajorityThreshold()).to.equal(7000);
    });

    it("should reject supermajority below majority", async function () {
      const { taskRegistry, owner } = await loadFixture(deployFixture);

      await expect(
        taskRegistry.connect(owner).setSuperMajorityThreshold(5000)
      ).to.be.revertedWith("Invalid threshold");
    });

    it("should pause and unpause", async function () {
      const { taskRegistry, owner, requester } = await loadFixture(deployFixture);

      await taskRegistry.connect(owner).pause();

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));

      await expect(
        taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
          modelHash,
          modelHash,
          "{}",
          ethers.parseEther("0.01"),
          3,
          (await time.latest()) + ONE_DAY,
          { value: ethers.parseEther("0.03") }
        )
      ).to.be.revertedWithCustomError(taskRegistry, "EnforcedPause");

      await taskRegistry.connect(owner).unpause();

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        { value: ethers.parseEther("0.03") }
      );

      expect(await taskRegistry.taskCount()).to.equal(1);
    });
  });

  describe("Edge Cases", function () {
    it("should handle receive function", async function () {
      const { taskRegistry, owner } = await loadFixture(deployFixture);

      await expect(
        owner.sendTransaction({
          to: await taskRegistry.getAddress(),
          value: ethers.parseEther("1")
        })
      ).to.not.be.reverted;
    });

    it("should handle supermajority (>66%) consensus", async function () {
      const { taskRegistry, requester, node1, node2, node3, node4, node5 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const sameResult = ethers.keccak256(ethers.toUtf8Bytes("same-result"));
      const differentResult = ethers.keccak256(ethers.toUtf8Bytes("different-result"));

      // Create task with supermajority (needs >66%)
      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        5,
        (await time.latest()) + ONE_DAY,
        1, // SuperMajority
        { value: ethers.parseEther("0.05") }
      );

      const signers = [node1, node2, node3, node4, node5];
      for (const signer of signers) {
        await taskRegistry.connect(signer).claimTask(1);
      }

      // 4/5 = 80% > 66.67%
      await taskRegistry.connect(node1).submitResult(1, sameResult);
      await taskRegistry.connect(node2).submitResult(1, sameResult);
      await taskRegistry.connect(node3).submitResult(1, sameResult);
      await taskRegistry.connect(node4).submitResult(1, sameResult);

      const tx = await taskRegistry.connect(node5).submitResult(1, differentResult);

      await expect(tx).to.emit(taskRegistry, "ConsensusReached");

      const task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(3); // Completed
    });

    it("should fail supermajority with 2/3 (integer division rounds to 66%)", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const sameResult = ethers.keccak256(ethers.toUtf8Bytes("same-result"));
      const differentResult = ethers.keccak256(ethers.toUtf8Bytes("different-result"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        1, // SuperMajority
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      // 2/3 with integer division: (2 * 10000) / 3 = 6666, threshold is 6667
      // 6666 < 6667, so consensus is NOT reached
      await taskRegistry.connect(node1).submitResult(1, sameResult);
      await taskRegistry.connect(node2).submitResult(1, sameResult);

      const tx = await taskRegistry.connect(node3).submitResult(1, differentResult);

      await expect(tx).to.emit(taskRegistry, "ConsensusDisputed");

      const task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(4); // Disputed
    });

    it("should fail supermajority with 1/3 (33%)", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const result1 = ethers.keccak256(ethers.toUtf8Bytes("result-1"));
      const result2 = ethers.keccak256(ethers.toUtf8Bytes("result-2"));
      const result3 = ethers.keccak256(ethers.toUtf8Bytes("result-3"));

      await taskRegistry.connect(requester)["submitTask(bytes32,bytes32,string,uint256,uint256,uint256,uint8)"](
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("0.01"),
        3,
        (await time.latest()) + ONE_DAY,
        1, // SuperMajority
        { value: ethers.parseEther("0.03") }
      );

      await taskRegistry.connect(node1).claimTask(1);
      await taskRegistry.connect(node2).claimTask(1);
      await taskRegistry.connect(node3).claimTask(1);

      // All different results - 1/3 = 33.33% which is below 66.67%
      await taskRegistry.connect(node1).submitResult(1, result1);
      await taskRegistry.connect(node2).submitResult(1, result2);

      const tx = await taskRegistry.connect(node3).submitResult(1, result3);

      await expect(tx).to.emit(taskRegistry, "ConsensusDisputed");

      const task = await taskRegistry.tasks(1);
      expect(task.status).to.equal(4); // Disputed
    });
  });
});
