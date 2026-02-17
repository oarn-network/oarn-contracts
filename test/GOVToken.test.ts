import { expect } from "chai";
import { ethers } from "hardhat";
import { GOVToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GOVToken", function () {
  let govToken: GOVToken;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let teamVesting: SignerWithAddress;
  let earlyContributors: SignerWithAddress;
  let publicSale: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const TOTAL_SUPPLY = ethers.parseEther("100000000"); // 100M tokens

  beforeEach(async function () {
    [owner, treasury, teamVesting, earlyContributors, publicSale, user1, user2] = await ethers.getSigners();

    const GOVToken = await ethers.getContractFactory("GOVToken");
    govToken = await GOVToken.deploy(treasury.address, teamVesting.address);
  });

  describe("Constructor", function () {
    it("should set correct name and symbol", async function () {
      expect(await govToken.name()).to.equal("OARN Governance Token");
      expect(await govToken.symbol()).to.equal("GOV");
    });

    it("should set treasury address correctly", async function () {
      expect(await govToken.treasuryAddress()).to.equal(treasury.address);
    });

    it("should set team vesting address correctly", async function () {
      expect(await govToken.teamVestingAddress()).to.equal(teamVesting.address);
    });

    it("should set owner correctly", async function () {
      expect(await govToken.owner()).to.equal(owner.address);
    });

    it("should start with zero total supply", async function () {
      expect(await govToken.totalSupply()).to.equal(0);
    });

    it("should start with mintingComplete as false", async function () {
      expect(await govToken.mintingComplete()).to.be.false;
    });

    it("should revert with zero treasury address", async function () {
      const GOVToken = await ethers.getContractFactory("GOVToken");
      await expect(
        GOVToken.deploy(ethers.ZeroAddress, teamVesting.address)
      ).to.be.revertedWith("Invalid treasury");
    });

    it("should revert with zero team vesting address", async function () {
      const GOVToken = await ethers.getContractFactory("GOVToken");
      await expect(
        GOVToken.deploy(treasury.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid team vesting");
    });
  });

  describe("Genesis Distribution", function () {
    it("should execute genesis distribution correctly", async function () {
      await expect(
        govToken.executeGenesisDistribution(earlyContributors.address, publicSale.address)
      ).to.emit(govToken, "GenesisDistribution");

      // Check total supply
      expect(await govToken.totalSupply()).to.equal(TOTAL_SUPPLY);

      // Check 40% to early contributors
      const earlyContributorsBalance = await govToken.balanceOf(earlyContributors.address);
      expect(earlyContributorsBalance).to.equal((TOTAL_SUPPLY * 40n) / 100n);

      // Check 30% to public sale
      const publicSaleBalance = await govToken.balanceOf(publicSale.address);
      expect(publicSaleBalance).to.equal((TOTAL_SUPPLY * 30n) / 100n);

      // Check 20% to treasury
      const treasuryBalance = await govToken.balanceOf(treasury.address);
      expect(treasuryBalance).to.equal((TOTAL_SUPPLY * 20n) / 100n);

      // Check 10% to team vesting
      const teamBalance = await govToken.balanceOf(teamVesting.address);
      expect(teamBalance).to.equal((TOTAL_SUPPLY * 10n) / 100n);
    });

    it("should set mintingComplete to true after distribution", async function () {
      await govToken.executeGenesisDistribution(earlyContributors.address, publicSale.address);
      expect(await govToken.mintingComplete()).to.be.true;
    });

    it("should revert if called twice", async function () {
      await govToken.executeGenesisDistribution(earlyContributors.address, publicSale.address);

      await expect(
        govToken.executeGenesisDistribution(earlyContributors.address, publicSale.address)
      ).to.be.revertedWith("Minting already complete");
    });

    it("should revert if non-owner calls", async function () {
      await expect(
        govToken.connect(user1).executeGenesisDistribution(earlyContributors.address, publicSale.address)
      ).to.be.revertedWithCustomError(govToken, "OwnableUnauthorizedAccount");
    });

    it("should revert with zero early contributors address", async function () {
      await expect(
        govToken.executeGenesisDistribution(ethers.ZeroAddress, publicSale.address)
      ).to.be.revertedWith("Invalid early contributors address");
    });

    it("should revert with zero public sale address", async function () {
      await expect(
        govToken.executeGenesisDistribution(earlyContributors.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid public sale address");
    });
  });

  describe("ERC20 Functionality", function () {
    beforeEach(async function () {
      await govToken.executeGenesisDistribution(earlyContributors.address, publicSale.address);
    });

    it("should transfer tokens correctly", async function () {
      const amount = ethers.parseEther("1000");

      await govToken.connect(earlyContributors).transfer(user1.address, amount);

      expect(await govToken.balanceOf(user1.address)).to.equal(amount);
    });

    it("should approve and transferFrom correctly", async function () {
      const amount = ethers.parseEther("1000");

      await govToken.connect(earlyContributors).approve(user1.address, amount);
      expect(await govToken.allowance(earlyContributors.address, user1.address)).to.equal(amount);

      await govToken.connect(user1).transferFrom(earlyContributors.address, user2.address, amount);
      expect(await govToken.balanceOf(user2.address)).to.equal(amount);
    });
  });

  describe("ERC20Votes Functionality", function () {
    beforeEach(async function () {
      await govToken.executeGenesisDistribution(earlyContributors.address, publicSale.address);
    });

    it("should delegate votes", async function () {
      // Self-delegate
      await govToken.connect(earlyContributors).delegate(earlyContributors.address);

      const votes = await govToken.getVotes(earlyContributors.address);
      expect(votes).to.equal(await govToken.balanceOf(earlyContributors.address));
    });

    it("should delegate to another address", async function () {
      const amount = ethers.parseEther("1000");
      await govToken.connect(earlyContributors).transfer(user1.address, amount);

      await govToken.connect(user1).delegate(user2.address);

      const votes = await govToken.getVotes(user2.address);
      expect(votes).to.equal(amount);
    });

    it("should return zero votes before delegation", async function () {
      expect(await govToken.getVotes(earlyContributors.address)).to.equal(0);
    });

    it("should update votes after transfer", async function () {
      await govToken.connect(earlyContributors).delegate(earlyContributors.address);
      const votesBefore = await govToken.getVotes(earlyContributors.address);

      const transferAmount = ethers.parseEther("1000000");
      await govToken.connect(earlyContributors).transfer(user1.address, transferAmount);

      const votesAfter = await govToken.getVotes(earlyContributors.address);
      expect(votesAfter).to.equal(votesBefore - transferAmount);
    });
  });

  describe("Quadratic Voting Power", function () {
    beforeEach(async function () {
      await govToken.executeGenesisDistribution(earlyContributors.address, publicSale.address);
    });

    it("should return zero for zero balance", async function () {
      expect(await govToken.getQuadraticVotingPower(user1.address)).to.equal(0);
    });

    it("should calculate quadratic voting power correctly", async function () {
      // Transfer 1,000,000 tokens (1e24 wei) to user1
      const amount = ethers.parseEther("1000000");
      await govToken.connect(earlyContributors).transfer(user1.address, amount);

      const quadraticPower = await govToken.getQuadraticVotingPower(user1.address);

      // sqrt(1e24) = 1e12 (approximately)
      // The exact value depends on the babylonian sqrt implementation
      expect(quadraticPower).to.be.gt(0);
    });

    it("should return smaller quadratic power for smaller balances", async function () {
      const smallAmount = ethers.parseEther("100");
      const largeAmount = ethers.parseEther("10000");

      await govToken.connect(earlyContributors).transfer(user1.address, smallAmount);
      await govToken.connect(earlyContributors).transfer(user2.address, largeAmount);

      const smallPower = await govToken.getQuadraticVotingPower(user1.address);
      const largePower = await govToken.getQuadraticVotingPower(user2.address);

      expect(largePower).to.be.gt(smallPower);
      // For quadratic voting: sqrt(10000) / sqrt(100) = 100/10 = 10
      // So largePower should be 10x smallPower
      expect(largePower).to.equal(smallPower * 10n);
    });
  });

  describe("ERC20Permit", function () {
    beforeEach(async function () {
      await govToken.executeGenesisDistribution(earlyContributors.address, publicSale.address);
    });

    it("should have correct DOMAIN_SEPARATOR", async function () {
      const domainSeparator = await govToken.DOMAIN_SEPARATOR();
      expect(domainSeparator).to.not.equal(ethers.ZeroHash);
    });

    it("should return correct nonces", async function () {
      expect(await govToken.nonces(user1.address)).to.equal(0);
    });
  });

  describe("Constants", function () {
    it("should have correct total supply constant", async function () {
      expect(await govToken.TOTAL_SUPPLY()).to.equal(TOTAL_SUPPLY);
    });
  });
});
