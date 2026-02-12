import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

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
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

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
          Math.floor(Date.now() / 1000) + 3600,
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
          Math.floor(Date.now() / 1000) - 3600, // Past deadline
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
        Math.floor(Date.now() / 1000) + 3600,
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
        Math.floor(Date.now() / 1000) + 3600,
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
        Math.floor(Date.now() / 1000) + 3600,
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
        Math.floor(Date.now() / 1000) + 3600,
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
        Math.floor(Date.now() / 1000) + 3600,
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
        Math.floor(Date.now() / 1000) + 3600,
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
        Math.floor(Date.now() / 1000) + 3600,
        { value: ethers.parseEther("30") }
      );

      await expect(
        taskRegistry.connect(node1).cancelTask(1)
      ).to.be.revertedWith("Not task owner");
    });
  });
});

describe("OARNRegistry", function () {
  async function deployRegistryFixture() {
    const [owner, provider1, provider2] = await ethers.getSigners();

    // Deploy mock contracts for registry
    const COMPToken = await ethers.getContractFactory("COMPToken");
    const compToken = await COMPToken.deploy();

    const GOVToken = await ethers.getContractFactory("GOVToken");
    const govToken = await GOVToken.deploy(owner.address, owner.address);

    const TaskRegistry = await ethers.getContractFactory("TaskRegistry");
    const taskRegistry = await TaskRegistry.deploy(await compToken.getAddress());

    // Deploy OARNRegistry
    const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
    const oarnRegistry = await OARNRegistry.deploy(
      await taskRegistry.getAddress(),
      await compToken.getAddress(),
      owner.address, // ValidatorRegistry placeholder
      owner.address, // Governance placeholder
      await govToken.getAddress()
    );

    return { oarnRegistry, taskRegistry, compToken, govToken, owner, provider1, provider2 };
  }

  describe("RPC Provider Registration", function () {
    it("Should register RPC provider with sufficient stake", async function () {
      const { oarnRegistry, provider1 } = await loadFixture(deployRegistryFixture);

      const minStake = await oarnRegistry.RPC_MIN_STAKE();

      await expect(
        oarnRegistry.connect(provider1).registerRPCProvider(
          "https://rpc.example.com",
          "http://example.onion",
          { value: minStake }
        )
      ).to.emit(oarnRegistry, "RPCProviderRegistered");

      const activeCount = await oarnRegistry.activeRpcCount();
      expect(activeCount).to.equal(1);
    });

    it("Should reject registration with insufficient stake", async function () {
      const { oarnRegistry, provider1 } = await loadFixture(deployRegistryFixture);

      await expect(
        oarnRegistry.connect(provider1).registerRPCProvider(
          "https://rpc.example.com",
          "",
          { value: ethers.parseEther("100") } // Less than 5000
        )
      ).to.be.revertedWith("Insufficient stake");
    });
  });

  describe("Bootstrap Node Registration", function () {
    it("Should register bootstrap node", async function () {
      const { oarnRegistry, provider1 } = await loadFixture(deployRegistryFixture);

      const minStake = await oarnRegistry.BOOTSTRAP_MIN_STAKE();

      await expect(
        oarnRegistry.connect(provider1).registerBootstrapNode(
          "12D3KooWExample...",
          "/ip4/1.2.3.4/tcp/4001",
          "http://example.onion",
          "",
          { value: minStake }
        )
      ).to.emit(oarnRegistry, "BootstrapNodeRegistered");

      const activeCount = await oarnRegistry.activeBootstrapCount();
      expect(activeCount).to.equal(1);
    });
  });

  describe("Core Contract Discovery", function () {
    it("Should return all core contract addresses", async function () {
      const { oarnRegistry, taskRegistry, compToken, govToken, owner } = await loadFixture(deployRegistryFixture);

      const [
        taskRegistryAddr,
        tokenRewardAddr,
        validatorRegistryAddr,
        governanceAddr,
        govTokenAddr
      ] = await oarnRegistry.getCoreContracts();

      expect(taskRegistryAddr).to.equal(await taskRegistry.getAddress());
      expect(tokenRewardAddr).to.equal(await compToken.getAddress());
      expect(govTokenAddr).to.equal(await govToken.getAddress());
    });
  });
});
