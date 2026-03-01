import { expect } from "chai";
import { ethers } from "hardhat";
import { OARNGovernance, GOVToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time, mine, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("OARNGovernance", function () {
  let governance: OARNGovernance;
  let govToken: GOVToken;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let teamVesting: SignerWithAddress;
  let earlyContributors: SignerWithAddress;
  let publicSale: SignerWithAddress;
  let proposer: SignerWithAddress;
  let voter1: SignerWithAddress;
  let voter2: SignerWithAddress;
  let voter3: SignerWithAddress;

  const VOTING_DELAY = 7200; // 1 day in blocks
  const VOTING_PERIOD = 50400; // 1 week in blocks
  const PROPOSAL_THRESHOLD = ethers.parseEther("1000"); // 1000 GOV tokens

  async function deployFixture() {
    [owner, treasury, teamVesting, earlyContributors, publicSale, proposer, voter1, voter2, voter3] =
      await ethers.getSigners();

    // Deploy GOV Token
    const GOVToken = await ethers.getContractFactory("GOVToken");
    govToken = await GOVToken.deploy(treasury.address, teamVesting.address);

    // Deploy Governance
    const OARNGovernance = await ethers.getContractFactory("OARNGovernance");
    governance = await OARNGovernance.deploy(await govToken.getAddress());

    // Execute genesis distribution
    await govToken.executeGenesisDistribution(earlyContributors.address, publicSale.address);

    // Transfer tokens to proposer (needs 1000 GOV to propose)
    await govToken.connect(earlyContributors).transfer(proposer.address, ethers.parseEther("2000"));
    await govToken.connect(earlyContributors).transfer(voter1.address, ethers.parseEther("5000"));
    await govToken.connect(earlyContributors).transfer(voter2.address, ethers.parseEther("3000"));
    await govToken.connect(earlyContributors).transfer(voter3.address, ethers.parseEther("1000"));

    // Delegate to self to activate voting power
    await govToken.connect(proposer).delegate(proposer.address);
    await govToken.connect(voter1).delegate(voter1.address);
    await govToken.connect(voter2).delegate(voter2.address);
    await govToken.connect(voter3).delegate(voter3.address);
    await govToken.connect(earlyContributors).delegate(earlyContributors.address);

    return { governance, govToken, owner, treasury, earlyContributors, proposer, voter1, voter2, voter3 };
  }

  describe("Constructor", function () {
    it("should set correct name", async function () {
      const { governance } = await loadFixture(deployFixture);
      expect(await governance.name()).to.equal("OARN Governance");
    });

    it("should set correct voting delay", async function () {
      const { governance } = await loadFixture(deployFixture);
      expect(await governance.votingDelay()).to.equal(VOTING_DELAY);
    });

    it("should set correct voting period", async function () {
      const { governance } = await loadFixture(deployFixture);
      expect(await governance.votingPeriod()).to.equal(VOTING_PERIOD);
    });

    it("should set correct proposal threshold", async function () {
      const { governance } = await loadFixture(deployFixture);
      expect(await governance.proposalThreshold()).to.equal(PROPOSAL_THRESHOLD);
    });

    it("should set 4% quorum", async function () {
      const { governance } = await loadFixture(deployFixture);
      expect(await governance.quorumNumerator()).to.equal(4);
    });
  });

  describe("Proposal Creation", function () {
    it("should create a proposal with metadata", async function () {
      const { governance, proposer, earlyContributors } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];
      const title = "Test Proposal";
      const description = "This is a test proposal";

      // Mine a block to ensure voting power is active
      await mine(1);

      const tx = await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        title,
        description
      );

      await expect(tx).to.emit(governance, "ProposalCreatedWithDescription");
      await expect(tx).to.emit(governance, "ProposalCreated");

      expect(await governance.proposalCount()).to.equal(1);
    });

    it("should store proposal title and description", async function () {
      const { governance, proposer, earlyContributors } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];
      const title = "My Proposal Title";
      const description = "Detailed description here";

      await mine(1);

      const tx = await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        title,
        description
      );

      const receipt = await tx.wait();
      const proposalId = await governance.getProposalId(0);

      expect(await governance.proposalTitles(proposalId)).to.equal(title);
      expect(await governance.proposalDescriptions(proposalId)).to.equal(description);
    });

    it("should reject proposal from user with insufficient voting power", async function () {
      const { governance, earlyContributors } = await loadFixture(deployFixture);

      // Get a signer that has no tokens
      const signers = await ethers.getSigners();
      const noTokensUser = signers[9]; // This user has no tokens

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await expect(
        governance.connect(noTokensUser).proposeWithMetadata(
          targets,
          values,
          calldatas,
          "Title",
          "Description"
        )
      ).to.be.revertedWithCustomError(governance, "GovernorInsufficientProposerVotes");
    });

    it("should track proposal ID", async function () {
      const { governance, proposer, earlyContributors } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "First Proposal",
        "Description 1"
      );

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Second Proposal",
        "Description 2"
      );

      expect(await governance.proposalCount()).to.equal(2);

      const proposalId1 = await governance.getProposalId(0);
      const proposalId2 = await governance.getProposalId(1);

      expect(proposalId1).to.not.equal(proposalId2);
    });

    it("should revert for out of bounds proposal index", async function () {
      const { governance } = await loadFixture(deployFixture);

      await expect(
        governance.getProposalId(999)
      ).to.be.revertedWith("Index out of bounds");
    });
  });

  describe("Voting", function () {
    async function createProposal() {
      const { governance, proposer, earlyContributors, voter1, voter2, voter3 } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      const tx = await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Test Proposal",
        "Description"
      );

      const proposalId = await governance.getProposalId(0);

      // Move past voting delay
      await mine(VOTING_DELAY + 1);

      return { governance, proposalId, proposer, voter1, voter2, voter3 };
    }

    it("should allow voting for", async function () {
      const { governance, proposalId, voter1 } = await createProposal();

      // 1 = For
      await expect(governance.connect(voter1).castVote(proposalId, 1))
        .to.emit(governance, "VoteCast");
    });

    it("should allow voting against", async function () {
      const { governance, proposalId, voter1 } = await createProposal();

      // 0 = Against
      await expect(governance.connect(voter1).castVote(proposalId, 0))
        .to.emit(governance, "VoteCast");
    });

    it("should allow abstain voting", async function () {
      const { governance, proposalId, voter1 } = await createProposal();

      // 2 = Abstain
      await expect(governance.connect(voter1).castVote(proposalId, 2))
        .to.emit(governance, "VoteCast");
    });

    it("should prevent double voting", async function () {
      const { governance, proposalId, voter1 } = await createProposal();

      await governance.connect(voter1).castVote(proposalId, 1);

      await expect(
        governance.connect(voter1).castVote(proposalId, 1)
      ).to.be.revertedWithCustomError(governance, "GovernorAlreadyCastVote");
    });

    it("should prevent voting before delay", async function () {
      const { governance, proposer, earlyContributors, voter1 } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Test",
        "Test"
      );

      const proposalId = await governance.getProposalId(0);

      // Don't advance blocks
      await expect(
        governance.connect(voter1).castVote(proposalId, 1)
      ).to.be.revertedWithCustomError(governance, "GovernorUnexpectedProposalState");
    });

    it("should prevent voting after deadline", async function () {
      const { governance, proposalId, voter1 } = await createProposal();

      // Move past voting period
      await mine(VOTING_PERIOD + 1);

      await expect(
        governance.connect(voter1).castVote(proposalId, 1)
      ).to.be.revertedWithCustomError(governance, "GovernorUnexpectedProposalState");
    });

    it("should count votes correctly", async function () {
      const { governance, proposalId, voter1, voter2, voter3 } = await createProposal();

      // voter1 (5000 GOV) votes for
      await governance.connect(voter1).castVote(proposalId, 1);
      // voter2 (3000 GOV) votes against
      await governance.connect(voter2).castVote(proposalId, 0);
      // voter3 (1000 GOV) abstains
      await governance.connect(voter3).castVote(proposalId, 2);

      const [againstVotes, forVotes, abstainVotes] = await governance.proposalVotes(proposalId);

      expect(forVotes).to.equal(ethers.parseEther("5000"));
      expect(againstVotes).to.equal(ethers.parseEther("3000"));
      expect(abstainVotes).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("Proposal States", function () {
    it("should be Pending after creation", async function () {
      const { governance, proposer, earlyContributors } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Test",
        "Test"
      );

      const proposalId = await governance.getProposalId(0);
      expect(await governance.state(proposalId)).to.equal(0); // Pending
    });

    it("should be Active after voting delay", async function () {
      const { governance, proposer, earlyContributors } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Test",
        "Test"
      );

      const proposalId = await governance.getProposalId(0);

      await mine(VOTING_DELAY + 1);

      expect(await governance.state(proposalId)).to.equal(1); // Active
    });

    it("should be Defeated if quorum not met", async function () {
      const { governance, proposer, earlyContributors, voter3 } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Test",
        "Test"
      );

      const proposalId = await governance.getProposalId(0);

      await mine(VOTING_DELAY + 1);

      // Only voter3 votes (1000 GOV) - not enough for 4% quorum
      await governance.connect(voter3).castVote(proposalId, 1);

      await mine(VOTING_PERIOD + 1);

      expect(await governance.state(proposalId)).to.equal(3); // Defeated
    });

    it("should be Defeated if more against votes", async function () {
      const { governance, proposer, earlyContributors, voter1, voter2 } = await loadFixture(deployFixture);

      // Give earlyContributors more tokens for quorum
      await govToken.connect(earlyContributors).delegate(voter2.address);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Test",
        "Test"
      );

      const proposalId = await governance.getProposalId(0);

      await mine(VOTING_DELAY + 1);

      // earlyContributors has lots of tokens, votes against
      await governance.connect(earlyContributors).castVote(proposalId, 0);
      await governance.connect(voter1).castVote(proposalId, 1);

      await mine(VOTING_PERIOD + 1);

      expect(await governance.state(proposalId)).to.equal(3); // Defeated
    });

    it("should be Succeeded with enough for votes and quorum", async function () {
      const { governance, proposer, earlyContributors, voter1, voter2 } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Test",
        "Test"
      );

      const proposalId = await governance.getProposalId(0);

      await mine(VOTING_DELAY + 1);

      // Large holders vote for
      await governance.connect(earlyContributors).castVote(proposalId, 1);
      await governance.connect(voter1).castVote(proposalId, 1);

      await mine(VOTING_PERIOD + 1);

      expect(await governance.state(proposalId)).to.equal(4); // Succeeded
    });
  });

  describe("Proposal Summary", function () {
    it("should return correct proposal summary", async function () {
      const { governance, proposer, earlyContributors, voter1, voter2 } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];
      const title = "Important Proposal";
      const description = "This proposal does important things";

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        title,
        description
      );

      const proposalId = await governance.getProposalId(0);

      await mine(VOTING_DELAY + 1);

      await governance.connect(voter1).castVote(proposalId, 1); // 5000 for
      await governance.connect(voter2).castVote(proposalId, 0); // 3000 against

      const summary = await governance.getProposalSummary(proposalId);

      expect(summary.title).to.equal(title);
      expect(summary.description).to.equal(description);
      expect(summary.proposer).to.equal(proposer.address);
      expect(summary.status).to.equal(1); // Active
      expect(summary.forVotes).to.equal(ethers.parseEther("5000"));
      expect(summary.againstVotes).to.equal(ethers.parseEther("3000"));
      expect(summary.abstainVotes).to.equal(0);
    });
  });

  describe("Quorum", function () {
    it("should calculate quorum correctly", async function () {
      const { governance, govToken } = await loadFixture(deployFixture);

      const totalSupply = await govToken.totalSupply();
      const expectedQuorum = (totalSupply * 4n) / 100n;

      // Get quorum at current block
      const blockNumber = await ethers.provider.getBlockNumber();
      const quorum = await governance.quorum(blockNumber - 1);

      expect(quorum).to.equal(expectedQuorum);
    });
  });

  describe("Delegation", function () {
    it("should allow delegation before proposal", async function () {
      const { governance, govToken, proposer, voter1, voter2, earlyContributors } = await loadFixture(deployFixture);

      // voter2 delegates to voter1
      await govToken.connect(voter2).delegate(voter1.address);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Test",
        "Test"
      );

      const proposalId = await governance.getProposalId(0);

      await mine(VOTING_DELAY + 1);

      // voter1 votes with combined power (5000 + 3000 = 8000)
      await governance.connect(voter1).castVote(proposalId, 1);

      const [, forVotes,] = await governance.proposalVotes(proposalId);
      expect(forVotes).to.equal(ethers.parseEther("8000"));
    });
  });

  describe("Edge Cases", function () {
    it("should handle proposal with empty calldata", async function () {
      const { governance, proposer, earlyContributors } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await expect(
        governance.connect(proposer).proposeWithMetadata(
          targets,
          values,
          calldatas,
          "Empty calldata proposal",
          "Description"
        )
      ).to.not.be.reverted;
    });

    it("should handle proposal with ETH value", async function () {
      const { governance, proposer, earlyContributors } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [ethers.parseEther("1")];
      const calldatas = ["0x"];

      await mine(1);

      await expect(
        governance.connect(proposer).proposeWithMetadata(
          targets,
          values,
          calldatas,
          "ETH transfer proposal",
          "Description"
        )
      ).to.not.be.reverted;
    });

    it("should handle multiple targets", async function () {
      const { governance, proposer, voter1, voter2 } = await loadFixture(deployFixture);

      const targets = [voter1.address, voter2.address];
      const values = [0, 0];
      const calldatas = ["0x", "0x"];

      await mine(1);

      await expect(
        governance.connect(proposer).proposeWithMetadata(
          targets,
          values,
          calldatas,
          "Multi-target proposal",
          "Description"
        )
      ).to.not.be.reverted;
    });

    it("should check proposal existence", async function () {
      const { governance, proposer, earlyContributors } = await loadFixture(deployFixture);

      const targets = [earlyContributors.address];
      const values = [0];
      const calldatas = ["0x"];

      await mine(1);

      await governance.connect(proposer).proposeWithMetadata(
        targets,
        values,
        calldatas,
        "Test",
        "Test"
      );

      const proposalId = await governance.getProposalId(0);
      expect(await governance.proposalExists(proposalId)).to.be.true;

      // Random proposal ID should not exist in mapping
      expect(await governance.proposalExists(12345)).to.be.false;
    });
  });
});
