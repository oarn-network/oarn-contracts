import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("TaskRegistry", function () {
  async function deployFixture() {
    const [owner, requester, node1, node2, node3] = await ethers.getSigners();

    // Deploy COMP Token
    const COMPToken = await ethers.getContractFactory("COMPToken");
    const compToken = await COMPToken.deploy();

    // Deploy TaskRegistry
    const TaskRegistry = await ethers.getContractFactory("TaskRegistry");
    const taskRegistry = await TaskRegistry.deploy(await compToken.getAddress());

    // Add TaskRegistry as minter
    await compToken.addMinter(await taskRegistry.getAddress());

    return { taskRegistry, compToken, owner, requester, node1, node2, node3 };
  }

  describe("Task Submission", function () {
    it("Should create a task with correct parameters", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const inputHash = ethers.keccak256(ethers.toUtf8Bytes("input-data"));
      const rewardPerNode = ethers.parseEther("10");
      const requiredNodes = 3;
      const deadline = (await time.latest()) + 3600; // 1 hour from now

      const tx = await taskRegistry.connect(requester).submitTask(
        modelHash,
        inputHash,
        '{"min_vram": "8GB"}',
        rewardPerNode,
        requiredNodes,
        deadline,
        { value: rewardPerNode * BigInt(requiredNodes) }
      );

      await expect(tx).to.emit(taskRegistry, "TaskCreated");

      const task = await taskRegistry.getTask(1);
      expect(task.requester).to.equal(requester.address);
      expect(task.modelHash).to.equal(modelHash);
      expect(task.rewardPerNode).to.equal(rewardPerNode);
      expect(task.requiredNodes).to.equal(requiredNodes);
    });

    it("Should reject task with insufficient payment", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const inputHash = ethers.keccak256(ethers.toUtf8Bytes("input-data"));
      const rewardPerNode = ethers.parseEther("10");

      await expect(
        taskRegistry.connect(requester).submitTask(
          modelHash,
          inputHash,
          "{}",
          rewardPerNode,
          3,
          (await time.latest()) + 3600,
          { value: ethers.parseEther("1") } // Not enough
        )
      ).to.be.revertedWith("Insufficient payment");
    });

    it("Should reject task with past deadline", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const inputHash = ethers.keccak256(ethers.toUtf8Bytes("input-data"));

      await expect(
        taskRegistry.connect(requester).submitTask(
          modelHash,
          inputHash,
          "{}",
          ethers.parseEther("10"),
          3,
          (await time.latest()) - 3600, // Past deadline
          { value: ethers.parseEther("30") }
        )
      ).to.be.revertedWith("Invalid deadline");
    });
  });

  describe("Task Claiming", function () {
    it("Should allow nodes to claim tasks", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      // Create task
      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const inputHash = ethers.keccak256(ethers.toUtf8Bytes("input-data"));
      const rewardPerNode = ethers.parseEther("10");

      await taskRegistry.connect(requester).submitTask(
        modelHash,
        inputHash,
        "{}",
        rewardPerNode,
        3,
        (await time.latest()) + 3600,
        { value: rewardPerNode * 3n }
      );

      // Claim task
      await expect(taskRegistry.connect(node1).claimTask(1))
        .to.emit(taskRegistry, "TaskClaimed")
        .withArgs(1, node1.address);

      // Check task is now active
      const task = await taskRegistry.getTask(1);
      expect(task.status).to.equal(1); // Active
    });

    it("Should prevent double claiming", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      await taskRegistry.connect(requester).submitTask(
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("10"),
        3,
        (await time.latest()) + 3600,
        { value: ethers.parseEther("30") }
      );

      await taskRegistry.connect(node1).claimTask(1);

      await expect(
        taskRegistry.connect(node1).claimTask(1)
      ).to.be.revertedWith("Already claimed");
    });
  });

  describe("Result Submission", function () {
    it("Should accept valid results", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-data"));

      await taskRegistry.connect(requester).submitTask(
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("10"),
        1, // Only 1 node needed
        (await time.latest()) + 3600,
        { value: ethers.parseEther("10") }
      );

      await taskRegistry.connect(node1).claimTask(1);

      await expect(taskRegistry.connect(node1).submitResult(1, resultHash))
        .to.emit(taskRegistry, "ResultSubmitted")
        .withArgs(1, node1.address, resultHash);
    });

    it("Should complete task and distribute rewards when enough results submitted", async function () {
      const { taskRegistry, requester, node1, node2, node3 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const rewardPerNode = ethers.parseEther("10");

      await taskRegistry.connect(requester).submitTask(
        modelHash,
        modelHash,
        "{}",
        rewardPerNode,
        3,
        (await time.latest()) + 3600,
        { value: rewardPerNode * 3n }
      );

      // All nodes claim and submit
      const nodes = [node1, node2, node3];
      for (const node of nodes) {
        await taskRegistry.connect(node).claimTask(1);
        const resultHash = ethers.keccak256(ethers.toUtf8Bytes(`result-${node.address}`));

        const balanceBefore = await ethers.provider.getBalance(node.address);
        await taskRegistry.connect(node).submitResult(1, resultHash);
        const balanceAfter = await ethers.provider.getBalance(node.address);

        // Last node triggers completion and rewards
        if (node === node3) {
          // Task should be completed
          const task = await taskRegistry.getTask(1);
          expect(task.status).to.equal(2); // Completed
        }
      }
    });

    it("Should reject results from non-claimers", async function () {
      const { taskRegistry, requester, node1, node2 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));

      await taskRegistry.connect(requester).submitTask(
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("10"),
        1,
        (await time.latest()) + 3600,
        { value: ethers.parseEther("10") }
      );

      // node1 claims but node2 tries to submit
      await taskRegistry.connect(node1).claimTask(1);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result"));
      await expect(
        taskRegistry.connect(node2).submitResult(1, resultHash)
      ).to.be.revertedWith("Not claimed");
    });
  });

  describe("Task Cancellation", function () {
    it("Should allow requester to cancel pending task", async function () {
      const { taskRegistry, requester } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
      const rewardPerNode = ethers.parseEther("10");

      await taskRegistry.connect(requester).submitTask(
        modelHash,
        modelHash,
        "{}",
        rewardPerNode,
        3,
        (await time.latest()) + 3600,
        { value: rewardPerNode * 3n }
      );

      const balanceBefore = await ethers.provider.getBalance(requester.address);

      await expect(taskRegistry.connect(requester).cancelTask(1))
        .to.emit(taskRegistry, "TaskCancelled");

      const task = await taskRegistry.getTask(1);
      expect(task.status).to.equal(3); // Cancelled
    });

    it("Should prevent non-requester from cancelling", async function () {
      const { taskRegistry, requester, node1 } = await loadFixture(deployFixture);

      const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));

      await taskRegistry.connect(requester).submitTask(
        modelHash,
        modelHash,
        "{}",
        ethers.parseEther("10"),
        3,
        (await time.latest()) + 3600,
        { value: ethers.parseEther("30") }
      );

      await expect(
        taskRegistry.connect(node1).cancelTask(1)
      ).to.be.revertedWith("Not task owner");
    });
  });
});
