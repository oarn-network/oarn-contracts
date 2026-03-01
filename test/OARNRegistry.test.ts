import { expect } from "chai";
import { ethers } from "hardhat";
import { OARNRegistry } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("OARNRegistry", function () {
  // Mock addresses for core contracts
  const mockTaskRegistry = "0x1000000000000000000000000000000000000001";
  const mockTokenReward = "0x2000000000000000000000000000000000000002";
  const mockValidatorRegistry = "0x3000000000000000000000000000000000000003";
  const mockGovernance = "0x4000000000000000000000000000000000000004";
  const mockGovToken = "0x5000000000000000000000000000000000000005";

  const RPC_MIN_STAKE = ethers.parseEther("5000");
  const BOOTSTRAP_MIN_STAKE = ethers.parseEther("1000");
  const UNSTAKE_COOLDOWN = 7 * 24 * 60 * 60; // 7 days in seconds

  async function deployFixture() {
    const [owner, provider1, provider2, provider3, node1, node2] = await ethers.getSigners();

    const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
    const registry = await OARNRegistry.deploy(
      mockTaskRegistry,
      mockTokenReward,
      mockValidatorRegistry,
      mockGovernance,
      mockGovToken
    );

    return { registry, owner, provider1, provider2, provider3, node1, node2 };
  }

  async function deployWithRPCProviderFixture() {
    const { registry, owner, provider1, provider2, provider3, node1, node2 } = await deployFixture();

    await registry.connect(provider1).registerRPCProvider(
      "https://rpc.example.com",
      "",
      { value: RPC_MIN_STAKE }
    );

    return { registry, owner, provider1, provider2, provider3, node1, node2 };
  }

  async function deployWithMultipleProvidersFixture() {
    const { registry, owner, provider1, provider2, provider3, node1, node2 } = await deployFixture();

    await registry.connect(provider1).registerRPCProvider(
      "https://rpc1.example.com",
      "",
      { value: RPC_MIN_STAKE }
    );
    await registry.connect(provider2).registerRPCProvider(
      "https://rpc2.example.com",
      "",
      { value: RPC_MIN_STAKE }
    );

    return { registry, owner, provider1, provider2, provider3, node1, node2 };
  }

  async function deployWithRPCAndBootstrapFixture() {
    const { registry, owner, provider1, provider2, provider3, node1, node2 } = await deployFixture();

    await registry.connect(provider1).registerRPCProvider(
      "https://rpc.example.com",
      "",
      { value: RPC_MIN_STAKE }
    );
    await registry.connect(node1).registerBootstrapNode(
      "QmPeerId",
      "/ip4/1.2.3.4/tcp/4001",
      "",
      "",
      { value: BOOTSTRAP_MIN_STAKE }
    );

    return { registry, owner, provider1, provider2, provider3, node1, node2 };
  }

  describe("Constructor", function () {
    it("should set immutable core addresses correctly", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.taskRegistry()).to.equal(mockTaskRegistry);
      expect(await registry.tokenReward()).to.equal(mockTokenReward);
      expect(await registry.validatorRegistry()).to.equal(mockValidatorRegistry);
      expect(await registry.governance()).to.equal(mockGovernance);
      expect(await registry.govToken()).to.equal(mockGovToken);
    });

    it("should set owner correctly", async function () {
      const { registry, owner } = await loadFixture(deployFixture);
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("should revert with zero address for TaskRegistry", async function () {
      const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
      await expect(
        OARNRegistry.deploy(
          ethers.ZeroAddress,
          mockTokenReward,
          mockValidatorRegistry,
          mockGovernance,
          mockGovToken
        )
      ).to.be.revertedWith("Invalid TaskRegistry");
    });

    it("should revert with zero address for TokenReward", async function () {
      const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
      await expect(
        OARNRegistry.deploy(
          mockTaskRegistry,
          ethers.ZeroAddress,
          mockValidatorRegistry,
          mockGovernance,
          mockGovToken
        )
      ).to.be.revertedWith("Invalid TokenReward");
    });

    it("should revert with zero address for ValidatorRegistry", async function () {
      const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
      await expect(
        OARNRegistry.deploy(
          mockTaskRegistry,
          mockTokenReward,
          ethers.ZeroAddress,
          mockGovernance,
          mockGovToken
        )
      ).to.be.revertedWith("Invalid ValidatorRegistry");
    });

    it("should revert with zero address for Governance", async function () {
      const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
      await expect(
        OARNRegistry.deploy(
          mockTaskRegistry,
          mockTokenReward,
          mockValidatorRegistry,
          ethers.ZeroAddress,
          mockGovToken
        )
      ).to.be.revertedWith("Invalid Governance");
    });

    it("should revert with zero address for GOVToken", async function () {
      const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
      await expect(
        OARNRegistry.deploy(
          mockTaskRegistry,
          mockTokenReward,
          mockValidatorRegistry,
          mockGovernance,
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("Invalid GOVToken");
    });
  });

  describe("RPC Provider Registration", function () {
    it("should register RPC provider with sufficient stake", async function () {
      const { registry, provider1 } = await loadFixture(deployFixture);

      await expect(
        registry.connect(provider1).registerRPCProvider(
          "https://rpc.example.com",
          "http://abcd1234.onion",
          { value: RPC_MIN_STAKE }
        )
      ).to.emit(registry, "RPCProviderRegistered");

      expect(await registry.rpcProviderCount()).to.equal(1);
      expect(await registry.activeRpcCount()).to.equal(1);
      expect(await registry.rpcProviderIds(provider1.address)).to.equal(1);
    });

    it("should revert with insufficient stake", async function () {
      const { registry, provider1 } = await loadFixture(deployFixture);

      await expect(
        registry.connect(provider1).registerRPCProvider(
          "https://rpc.example.com",
          "",
          { value: ethers.parseEther("100") }
        )
      ).to.be.revertedWith("Insufficient stake");
    });

    it("should revert with empty endpoint", async function () {
      const { registry, provider1 } = await loadFixture(deployFixture);

      await expect(
        registry.connect(provider1).registerRPCProvider(
          "",
          "",
          { value: RPC_MIN_STAKE }
        )
      ).to.be.revertedWith("Empty endpoint");
    });

    it("should revert if already registered", async function () {
      const { registry, provider1 } = await loadFixture(deployWithRPCProviderFixture);

      await expect(
        registry.connect(provider1).registerRPCProvider(
          "https://rpc2.example.com",
          "",
          { value: RPC_MIN_STAKE }
        )
      ).to.be.revertedWith("Already registered");
    });

    it("should store provider data correctly", async function () {
      const { registry, provider1 } = await loadFixture(deployFixture);

      await registry.connect(provider1).registerRPCProvider(
        "https://rpc.example.com",
        "http://test.onion",
        { value: RPC_MIN_STAKE }
      );

      const provider = await registry.rpcProviders(1);
      expect(provider.endpoint).to.equal("https://rpc.example.com");
      expect(provider.onionEndpoint).to.equal("http://test.onion");
      expect(provider.owner).to.equal(provider1.address);
      expect(provider.stake).to.equal(RPC_MIN_STAKE);
      expect(provider.uptime).to.equal(10000);
      expect(provider.isActive).to.be.true;
    });
  });

  describe("RPC Provider Updates", function () {
    it("should update provider endpoints", async function () {
      const { registry, provider1 } = await loadFixture(deployWithRPCProviderFixture);

      await expect(
        registry.connect(provider1).updateRPCProvider(
          "https://new.example.com",
          "http://new.onion"
        )
      ).to.emit(registry, "RPCProviderUpdated");

      const provider = await registry.rpcProviders(1);
      expect(provider.endpoint).to.equal("https://new.example.com");
      expect(provider.onionEndpoint).to.equal("http://new.onion");
    });

    it("should revert if not registered", async function () {
      const { registry, provider2 } = await loadFixture(deployWithRPCProviderFixture);

      await expect(
        registry.connect(provider2).updateRPCProvider(
          "https://new.example.com",
          ""
        )
      ).to.be.revertedWith("Not registered");
    });
  });

  describe("Bootstrap Node Registration", function () {
    it("should register bootstrap node with sufficient stake", async function () {
      const { registry, node1 } = await loadFixture(deployFixture);

      await expect(
        registry.connect(node1).registerBootstrapNode(
          "QmPeerId12345",
          "/ip4/1.2.3.4/tcp/4001",
          "http://node.onion",
          "",
          { value: BOOTSTRAP_MIN_STAKE }
        )
      ).to.emit(registry, "BootstrapNodeRegistered");

      expect(await registry.bootstrapNodeCount()).to.equal(1);
      expect(await registry.activeBootstrapCount()).to.equal(1);
    });

    it("should revert with insufficient stake", async function () {
      const { registry, node1 } = await loadFixture(deployFixture);

      await expect(
        registry.connect(node1).registerBootstrapNode(
          "QmPeerId",
          "/ip4/1.2.3.4/tcp/4001",
          "",
          "",
          { value: ethers.parseEther("100") }
        )
      ).to.be.revertedWith("Insufficient stake");
    });

    it("should revert with empty peer ID", async function () {
      const { registry, node1 } = await loadFixture(deployFixture);

      await expect(
        registry.connect(node1).registerBootstrapNode(
          "",
          "/ip4/1.2.3.4/tcp/4001",
          "",
          "",
          { value: BOOTSTRAP_MIN_STAKE }
        )
      ).to.be.revertedWith("Empty peer ID");
    });

    it("should store node data correctly", async function () {
      const { registry, node1 } = await loadFixture(deployFixture);

      await registry.connect(node1).registerBootstrapNode(
        "QmPeerId12345",
        "/ip4/1.2.3.4/tcp/4001",
        "http://node.onion",
        "node.i2p",
        { value: BOOTSTRAP_MIN_STAKE }
      );

      const node = await registry.bootstrapNodes(1);
      expect(node.peerId).to.equal("QmPeerId12345");
      expect(node.multiaddr).to.equal("/ip4/1.2.3.4/tcp/4001");
      expect(node.onionAddress).to.equal("http://node.onion");
      expect(node.i2pAddress).to.equal("node.i2p");
      expect(node.owner).to.equal(node1.address);
      expect(node.stake).to.equal(BOOTSTRAP_MIN_STAKE);
      expect(node.isActive).to.be.true;
    });
  });

  describe("Heartbeat", function () {
    it("should update heartbeat timestamp", async function () {
      const { registry, provider1 } = await loadFixture(deployWithRPCProviderFixture);

      const beforeHeartbeat = await registry.rpcProviders(1);

      await time.increase(3600); // Advance 1 hour

      await expect(registry.connect(provider1).heartbeat())
        .to.emit(registry, "Heartbeat");

      const afterHeartbeat = await registry.rpcProviders(1);
      expect(afterHeartbeat.lastHeartbeat).to.be.gt(beforeHeartbeat.lastHeartbeat);
    });
  });

  describe("Get Active Providers", function () {
    it("should return all active RPC providers", async function () {
      const { registry } = await loadFixture(deployWithMultipleProvidersFixture);

      const providers = await registry.getActiveRPCProviders();
      expect(providers.length).to.equal(2);
      expect(providers[0].endpoint).to.equal("https://rpc1.example.com");
      expect(providers[1].endpoint).to.equal("https://rpc2.example.com");
    });

    it("should return random RPC providers", async function () {
      const { registry, provider3 } = await loadFixture(deployWithMultipleProvidersFixture);

      await registry.connect(provider3).registerRPCProvider(
        "https://rpc3.example.com",
        "",
        { value: RPC_MIN_STAKE }
      );

      const providers = await registry.getRandomRPCProviders(2);
      expect(providers.length).to.equal(2);
    });

    it("should revert if requesting more providers than available", async function () {
      const { registry } = await loadFixture(deployWithMultipleProvidersFixture);

      await expect(
        registry.getRandomRPCProviders(5)
      ).to.be.revertedWith("Not enough providers");
    });
  });

  describe("Unstaking", function () {
    it("should initiate unstake correctly", async function () {
      const { registry, provider1 } = await loadFixture(deployWithRPCProviderFixture);

      await expect(registry.connect(provider1).initiateUnstake())
        .to.emit(registry, "UnstakeInitiated")
        .to.emit(registry, "RPCProviderDeactivated");

      expect(await registry.activeRpcCount()).to.equal(0);
      expect(await registry.pendingUnstakeAmount(provider1.address)).to.equal(RPC_MIN_STAKE);
    });

    it("should revert if no active stake", async function () {
      const { registry, provider2 } = await loadFixture(deployWithRPCProviderFixture);

      await expect(
        registry.connect(provider2).initiateUnstake()
      ).to.be.revertedWith("No active stake");
    });

    it("should complete unstake after cooldown", async function () {
      const { registry, provider1 } = await loadFixture(deployWithRPCProviderFixture);

      await registry.connect(provider1).initiateUnstake();

      await time.increase(UNSTAKE_COOLDOWN + 1);

      const balanceBefore = await ethers.provider.getBalance(provider1.address);

      await expect(registry.connect(provider1).completeUnstake())
        .to.emit(registry, "UnstakeCompleted");

      const balanceAfter = await ethers.provider.getBalance(provider1.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("should revert if cooldown not complete", async function () {
      const { registry, provider1 } = await loadFixture(deployWithRPCProviderFixture);

      await registry.connect(provider1).initiateUnstake();

      await time.increase(UNSTAKE_COOLDOWN - 100);

      await expect(
        registry.connect(provider1).completeUnstake()
      ).to.be.revertedWith("Cooldown not complete");
    });

    it("should revert if no pending unstake", async function () {
      const { registry, provider1 } = await loadFixture(deployWithRPCProviderFixture);

      await expect(
        registry.connect(provider1).completeUnstake()
      ).to.be.revertedWith("No pending unstake");
    });
  });

  describe("Slashing", function () {
    it("should slash RPC provider", async function () {
      const { registry } = await loadFixture(deployWithRPCAndBootstrapFixture);

      const slashAmount = ethers.parseEther("500");

      await expect(
        registry.slashRPCProvider(1, slashAmount, "Downtime violation")
      ).to.emit(registry, "RPCProviderSlashed");

      const provider = await registry.rpcProviders(1);
      expect(provider.stake).to.equal(RPC_MIN_STAKE - slashAmount);
      expect(provider.reportCount).to.equal(1);
    });

    it("should deactivate RPC provider if stake falls below minimum", async function () {
      const { registry } = await loadFixture(deployWithRPCAndBootstrapFixture);

      const slashAmount = ethers.parseEther("4500"); // Leaves 500, below 5000 minimum

      await registry.slashRPCProvider(1, slashAmount, "Severe violation");

      const provider = await registry.rpcProviders(1);
      expect(provider.isActive).to.be.false;
      expect(await registry.activeRpcCount()).to.equal(0);
    });

    it("should slash bootstrap node", async function () {
      const { registry } = await loadFixture(deployWithRPCAndBootstrapFixture);

      const slashAmount = ethers.parseEther("100");

      await expect(
        registry.slashBootstrapNode(1, slashAmount, "Bad behavior")
      ).to.emit(registry, "BootstrapNodeSlashed");

      const node = await registry.bootstrapNodes(1);
      expect(node.stake).to.equal(BOOTSTRAP_MIN_STAKE - slashAmount);
    });

    it("should revert if non-owner tries to slash", async function () {
      const { registry, provider2 } = await loadFixture(deployWithRPCAndBootstrapFixture);

      await expect(
        registry.connect(provider2).slashRPCProvider(1, ethers.parseEther("100"), "Test")
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("should revert if slashing more than stake", async function () {
      const { registry } = await loadFixture(deployWithRPCAndBootstrapFixture);

      await expect(
        registry.slashRPCProvider(1, ethers.parseEther("10000"), "Test")
      ).to.be.revertedWith("Insufficient stake to slash");
    });
  });

  describe("View Functions", function () {
    it("should return core contracts", async function () {
      const { registry } = await loadFixture(deployWithRPCAndBootstrapFixture);

      const [task, reward, validator, gov, govToken] = await registry.getCoreContracts();
      expect(task).to.equal(mockTaskRegistry);
      expect(reward).to.equal(mockTokenReward);
      expect(validator).to.equal(mockValidatorRegistry);
      expect(gov).to.equal(mockGovernance);
      expect(govToken).to.equal(mockGovToken);
    });

    it("should check if address is active provider", async function () {
      const { registry, provider1 } = await loadFixture(deployWithRPCAndBootstrapFixture);

      const [isRpc, isBootstrap] = await registry.isActiveProvider(provider1.address);
      expect(isRpc).to.be.true;
      expect(isBootstrap).to.be.false;
    });

    it("should check if address is active bootstrap node", async function () {
      const { registry, node1 } = await loadFixture(deployWithRPCAndBootstrapFixture);

      const [isRpc, isBootstrap] = await registry.isActiveProvider(node1.address);
      expect(isRpc).to.be.false;
      expect(isBootstrap).to.be.true;
    });

    it("should return false for non-registered address", async function () {
      const { registry, provider2 } = await loadFixture(deployWithRPCAndBootstrapFixture);

      const [isRpc, isBootstrap] = await registry.isActiveProvider(provider2.address);
      expect(isRpc).to.be.false;
      expect(isBootstrap).to.be.false;
    });
  });

  describe("Constants", function () {
    it("should have correct RPC minimum stake", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.RPC_MIN_STAKE()).to.equal(RPC_MIN_STAKE);
    });

    it("should have correct bootstrap minimum stake", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.BOOTSTRAP_MIN_STAKE()).to.equal(BOOTSTRAP_MIN_STAKE);
    });

    it("should have correct unstake cooldown", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.UNSTAKE_COOLDOWN()).to.equal(UNSTAKE_COOLDOWN);
    });
  });
});
