import { expect } from "chai";
import { ethers } from "hardhat";
import { COMPToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("COMPToken", function () {
  let compToken: COMPToken;
  let owner: SignerWithAddress;
  let minter: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;

  const YEAR_1_EMISSION = ethers.parseEther("100000000"); // 100M tokens
  const ONE_YEAR = 365 * 24 * 60 * 60; // in seconds

  beforeEach(async function () {
    [owner, minter, user1, user2, user3] = await ethers.getSigners();

    const COMPToken = await ethers.getContractFactory("COMPToken");
    compToken = await COMPToken.deploy();
  });

  describe("Constructor", function () {
    it("should set correct name and symbol", async function () {
      expect(await compToken.name()).to.equal("OARN Compute Token");
      expect(await compToken.symbol()).to.equal("COMP");
    });

    it("should set owner correctly", async function () {
      expect(await compToken.owner()).to.equal(owner.address);
    });

    it("should start with zero total supply", async function () {
      expect(await compToken.totalSupply()).to.equal(0);
    });

    it("should set launch time to deployment time", async function () {
      const launchTime = await compToken.launchTime();
      const latestBlock = await ethers.provider.getBlock("latest");
      expect(launchTime).to.be.closeTo(latestBlock!.timestamp, 2);
    });

    it("should have burn disabled by default", async function () {
      expect(await compToken.burnEnabled()).to.be.false;
    });

    it("should have default burn rate of 200 (2%)", async function () {
      expect(await compToken.burnRate()).to.equal(200);
    });
  });

  describe("Minter Management", function () {
    it("should add minter correctly", async function () {
      await expect(compToken.addMinter(minter.address))
        .to.emit(compToken, "MinterAdded")
        .withArgs(minter.address);

      expect(await compToken.minters(minter.address)).to.be.true;
    });

    it("should remove minter correctly", async function () {
      await compToken.addMinter(minter.address);

      await expect(compToken.removeMinter(minter.address))
        .to.emit(compToken, "MinterRemoved")
        .withArgs(minter.address);

      expect(await compToken.minters(minter.address)).to.be.false;
    });

    it("should revert if non-owner adds minter", async function () {
      await expect(
        compToken.connect(user1).addMinter(minter.address)
      ).to.be.revertedWithCustomError(compToken, "OwnableUnauthorizedAccount");
    });

    it("should revert when adding zero address as minter", async function () {
      await expect(
        compToken.addMinter(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid minter");
    });
  });

  describe("Minting", function () {
    beforeEach(async function () {
      await compToken.addMinter(minter.address);
    });

    it("should mint tokens when called by authorized minter", async function () {
      const amount = ethers.parseEther("1000");

      await compToken.connect(minter).mint(user1.address, amount);

      expect(await compToken.balanceOf(user1.address)).to.equal(amount);
      expect(await compToken.totalMinted()).to.equal(amount);
    });

    it("should revert if non-minter tries to mint", async function () {
      await expect(
        compToken.connect(user1).mint(user2.address, ethers.parseEther("100"))
      ).to.be.revertedWith("Not authorized to mint");
    });

    it("should revert when minting to zero address", async function () {
      await expect(
        compToken.connect(minter).mint(ethers.ZeroAddress, ethers.parseEther("100"))
      ).to.be.revertedWith("Cannot mint to zero address");
    });

    it("should track total minted correctly", async function () {
      const amount1 = ethers.parseEther("1000");
      const amount2 = ethers.parseEther("2000");

      await compToken.connect(minter).mint(user1.address, amount1);
      await compToken.connect(minter).mint(user2.address, amount2);

      expect(await compToken.totalMinted()).to.equal(amount1 + amount2);
    });
  });

  describe("Emission Schedule", function () {
    it("should return year 1 emission cap for first year", async function () {
      const cap = await compToken.getYearlyEmissionCap();
      expect(cap).to.equal(YEAR_1_EMISSION);
    });

    it("should decrease emission cap by 20% each year", async function () {
      // Move to year 2
      await time.increase(ONE_YEAR);
      const year2Cap = await compToken.getYearlyEmissionCap();
      expect(year2Cap).to.equal((YEAR_1_EMISSION * 80n) / 100n);

      // Move to year 3
      await time.increase(ONE_YEAR);
      const year3Cap = await compToken.getYearlyEmissionCap();
      expect(year3Cap).to.equal((YEAR_1_EMISSION * 80n * 80n) / 10000n);
    });

    it("should return correct year start timestamp", async function () {
      const launchTime = await compToken.launchTime();
      const yearStart = await compToken.getCurrentYearStart();
      expect(yearStart).to.equal(launchTime);

      // Move to year 2
      await time.increase(ONE_YEAR);
      const year2Start = await compToken.getCurrentYearStart();
      expect(year2Start).to.equal(launchTime + BigInt(ONE_YEAR));
    });
  });

  describe("Burn Functionality", function () {
    beforeEach(async function () {
      await compToken.addMinter(minter.address);
      await compToken.connect(minter).mint(user1.address, ethers.parseEther("10000"));
    });

    it("should not burn on transfer when burn is disabled", async function () {
      const amount = ethers.parseEther("1000");
      const balanceBefore = await compToken.balanceOf(user1.address);

      await compToken.connect(user1).transfer(user2.address, amount);

      expect(await compToken.balanceOf(user2.address)).to.equal(amount);
      expect(await compToken.balanceOf(user1.address)).to.equal(balanceBefore - amount);
    });

    it("should burn on transfer when burn is enabled", async function () {
      await compToken.enableBurn(true);

      const amount = ethers.parseEther("1000");
      const burnRate = await compToken.burnRate();
      const expectedBurn = (amount * burnRate) / 10000n;
      const expectedTransfer = amount - expectedBurn;

      await expect(compToken.connect(user1).transfer(user2.address, amount))
        .to.emit(compToken, "TokensBurned")
        .withArgs(user1.address, expectedBurn);

      expect(await compToken.balanceOf(user2.address)).to.equal(expectedTransfer);
    });

    it("should update burn rate correctly", async function () {
      const newRate = 500; // 5%

      await expect(compToken.setBurnRate(newRate))
        .to.emit(compToken, "BurnRateUpdated")
        .withArgs(newRate);

      expect(await compToken.burnRate()).to.equal(newRate);
    });

    it("should revert if burn rate is too high", async function () {
      await expect(
        compToken.setBurnRate(1001) // > 10%
      ).to.be.revertedWith("Burn rate too high");
    });

    it("should not burn on mint even when burn enabled", async function () {
      await compToken.enableBurn(true);

      const amount = ethers.parseEther("1000");
      const supplyBefore = await compToken.totalSupply();

      await compToken.connect(minter).mint(user2.address, amount);

      expect(await compToken.totalSupply()).to.equal(supplyBefore + amount);
      expect(await compToken.balanceOf(user2.address)).to.equal(amount);
    });
  });

  describe("ERC20Burnable", function () {
    beforeEach(async function () {
      await compToken.addMinter(minter.address);
      await compToken.connect(minter).mint(user1.address, ethers.parseEther("10000"));
    });

    it("should allow users to burn their own tokens", async function () {
      const amount = ethers.parseEther("1000");
      const balanceBefore = await compToken.balanceOf(user1.address);

      await compToken.connect(user1).burn(amount);

      expect(await compToken.balanceOf(user1.address)).to.equal(balanceBefore - amount);
    });

    it("should allow burnFrom with approval", async function () {
      const amount = ethers.parseEther("1000");

      await compToken.connect(user1).approve(user2.address, amount);
      await compToken.connect(user2).burnFrom(user1.address, amount);

      expect(await compToken.balanceOf(user1.address)).to.equal(
        ethers.parseEther("10000") - amount
      );
    });
  });

  describe("Admin Functions", function () {
    it("should enable and disable burn", async function () {
      await compToken.enableBurn(true);
      expect(await compToken.burnEnabled()).to.be.true;

      await compToken.enableBurn(false);
      expect(await compToken.burnEnabled()).to.be.false;
    });

    it("should only allow owner to enable burn", async function () {
      await expect(
        compToken.connect(user1).enableBurn(true)
      ).to.be.revertedWithCustomError(compToken, "OwnableUnauthorizedAccount");
    });

    it("should only allow owner to set burn rate", async function () {
      await expect(
        compToken.connect(user1).setBurnRate(100)
      ).to.be.revertedWithCustomError(compToken, "OwnableUnauthorizedAccount");
    });
  });

  describe("Constants", function () {
    it("should have correct year 1 emission constant", async function () {
      expect(await compToken.YEAR_1_EMISSION()).to.equal(YEAR_1_EMISSION);
    });

    it("should have correct emission decrease rate", async function () {
      expect(await compToken.EMISSION_DECREASE_RATE()).to.equal(80);
    });
  });

  describe("Edge Cases", function () {
    beforeEach(async function () {
      await compToken.addMinter(minter.address);
    });

    it("should handle zero burn rate", async function () {
      await compToken.enableBurn(true);
      await compToken.setBurnRate(0);

      await compToken.connect(minter).mint(user1.address, ethers.parseEther("1000"));

      const amount = ethers.parseEther("500");
      await compToken.connect(user1).transfer(user2.address, amount);

      expect(await compToken.balanceOf(user2.address)).to.equal(amount);
    });

    it("should handle multiple minters", async function () {
      await compToken.addMinter(user1.address);

      await compToken.connect(minter).mint(user2.address, ethers.parseEther("100"));
      await compToken.connect(user1).mint(user2.address, ethers.parseEther("200"));

      expect(await compToken.balanceOf(user2.address)).to.equal(ethers.parseEther("300"));
    });
  });
});
