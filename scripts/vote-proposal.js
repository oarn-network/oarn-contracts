/**
 * vote-proposal.js
 *
 * Cast a vote on a governance proposal, or delegate voting power.
 *
 * Usage:
 *   # Delegate voting power to yourself (required before voting)
 *   PRIVATE_KEY=0x... node scripts/vote-proposal.js --delegate
 *
 *   # Vote FOR proposal (support=1)
 *   PRIVATE_KEY=0x... GOVERNANCE_ADDRESS=0x... node scripts/vote-proposal.js --id <proposalId> --support 1
 *
 *   # Vote AGAINST (support=0)
 *   PRIVATE_KEY=0x... GOVERNANCE_ADDRESS=0x... node scripts/vote-proposal.js --id <proposalId> --support 0
 *
 *   # Vote ABSTAIN (support=2)
 *   PRIVATE_KEY=0x... GOVERNANCE_ADDRESS=0x... node scripts/vote-proposal.js --id <proposalId> --support 2
 *
 *   # Check proposal status
 *   GOVERNANCE_ADDRESS=0x... node scripts/vote-proposal.js --status --id <proposalId>
 *
 * Support values: 0 = Against, 1 = For, 2 = Abstain
 */

const { ethers } = require("ethers");
require("dotenv").config();

const GOV_TOKEN = "0xB97eDD49C225d2c43e7203aB9248cAbED2B268d3";
const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
const GOVERNANCE_ADDRESS = process.env.GOVERNANCE_ADDRESS || "";

const PROPOSAL_STATES = [
  "Pending",    // 0 — waiting for voting delay
  "Active",     // 1 — voting open
  "Canceled",   // 2
  "Defeated",   // 3 — failed quorum or majority
  "Succeeded",  // 4 — passed, awaiting execution
  "Queued",     // 5
  "Expired",    // 6
  "Executed",   // 7
];

const GOV_TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function delegate(address delegatee) external",
  "function delegates(address account) view returns (address)",
  "function getVotes(address account) view returns (uint256)",
];

const GOVERNANCE_ABI = [
  "function proposalCount() view returns (uint256)",
  "function getProposalId(uint256 index) view returns (uint256)",
  "function getProposalSummary(uint256 proposalId) view returns (string title, string description, address proposer, uint256 startBlock, uint256 endBlock, uint8 status, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes)",
  "function state(uint256 proposalId) view returns (uint8)",
  "function castVote(uint256 proposalId, uint8 support) returns (uint256 balance)",
  "function hasVoted(uint256 proposalId, address account) view returns (bool)",
  "function votingDelay() view returns (uint256)",
  "function votingPeriod() view returns (uint256)",
  "function quorum(uint256 blockNumber) view returns (uint256)",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--delegate") result.delegate = true;
    if (args[i] === "--status") result.status = true;
    if (args[i] === "--id" && args[i + 1]) result.id = args[++i];
    if (args[i] === "--support" && args[i + 1]) result.support = parseInt(args[++i]);
  }
  return result;
}

async function main() {
  const args = parseArgs();
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Status check doesn't require private key
  if (args.status) {
    if (!GOVERNANCE_ADDRESS) { console.error("GOVERNANCE_ADDRESS not set"); process.exit(1); }
    if (!args.id) { console.error("--id required"); process.exit(1); }

    const governance = new ethers.Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, provider);
    const summary = await governance.getProposalSummary(args.id);
    const currentBlock = await provider.getBlockNumber();

    console.log("=".repeat(60));
    console.log("Proposal Status");
    console.log("=".repeat(60));
    console.log("Title:", summary.title);
    console.log("State:", PROPOSAL_STATES[summary.status] || summary.status.toString());
    console.log("Proposer:", summary.proposer);
    console.log("Start Block:", summary.startBlock.toString());
    console.log("End Block:", summary.endBlock.toString());
    console.log("Current Block:", currentBlock);

    if (currentBlock < summary.startBlock) {
      console.log("Blocks until voting opens:", (summary.startBlock - BigInt(currentBlock)).toString());
    } else if (currentBlock <= summary.endBlock) {
      console.log("Blocks until voting closes:", (summary.endBlock - BigInt(currentBlock)).toString());
    }

    console.log("\nVotes:");
    console.log("  For:", ethers.formatEther(summary.forVotes), "GOV");
    console.log("  Against:", ethers.formatEther(summary.againstVotes), "GOV");
    console.log("  Abstain:", ethers.formatEther(summary.abstainVotes), "GOV");

    const quorum = await governance.quorum(summary.startBlock > 0n ? summary.startBlock - 1n : 0n);
    console.log("  Required Quorum:", ethers.formatEther(quorum), "GOV");
    return;
  }

  // All other actions require PRIVATE_KEY
  if (!process.env.PRIVATE_KEY) {
    console.error("PRIVATE_KEY env var not set");
    process.exit(1);
  }

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log("Wallet:", wallet.address);

  const govToken = new ethers.Contract(GOV_TOKEN, GOV_TOKEN_ABI, wallet);

  // Delegate
  if (args.delegate) {
    const currentDelegate = await govToken.delegates(wallet.address);
    const votes = await govToken.getVotes(wallet.address);
    const balance = await govToken.balanceOf(wallet.address);

    console.log("GOV Balance:", ethers.formatEther(balance), "GOV");
    console.log("Current Delegate:", currentDelegate);
    console.log("Current Voting Power:", ethers.formatEther(votes), "GOV");

    if (currentDelegate.toLowerCase() === wallet.address.toLowerCase()) {
      console.log("[SKIP] Already delegated to self. Voting power active.");
      return;
    }

    console.log("\nDelegating to self...");
    const tx = await govToken.delegate(wallet.address);
    console.log("TX:", tx.hash);
    await tx.wait();
    console.log("[OK] Delegation complete");
    console.log("New Voting Power:", ethers.formatEther(await govToken.getVotes(wallet.address)), "GOV");
    return;
  }

  // Vote
  if (args.id !== undefined && args.support !== undefined) {
    if (!GOVERNANCE_ADDRESS) { console.error("GOVERNANCE_ADDRESS not set"); process.exit(1); }
    if (![0, 1, 2].includes(args.support)) {
      console.error("--support must be 0 (Against), 1 (For), or 2 (Abstain)");
      process.exit(1);
    }

    const governance = new ethers.Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, wallet);
    const state = await governance.state(args.id);
    const supportLabel = ["Against", "For", "Abstain"][args.support];

    console.log("Proposal ID:", args.id);
    console.log("State:", PROPOSAL_STATES[state] || state.toString());
    console.log("Voting:", supportLabel);

    if (state !== 1n) {
      console.error(`\nERROR: Proposal is not Active (state=${PROPOSAL_STATES[state]})`);
      if (state === 0n) console.log("Waiting for voting delay — check again in ~1 day");
      process.exit(1);
    }

    const alreadyVoted = await governance.hasVoted(args.id, wallet.address);
    if (alreadyVoted) {
      console.log("[SKIP] Already voted from this address");
      return;
    }

    const votes = await govToken.getVotes(wallet.address);
    console.log("Voting Power:", ethers.formatEther(votes), "GOV");

    if (votes === 0n) {
      console.error("\nERROR: No voting power. Call: node scripts/vote-proposal.js --delegate");
      process.exit(1);
    }

    const tx = await governance.castVote(args.id, args.support);
    console.log("TX:", tx.hash);
    const receipt = await tx.wait();
    console.log("[OK] Vote cast in block:", receipt.blockNumber);

    const summary = await governance.getProposalSummary(args.id);
    console.log("\nUpdated Votes:");
    console.log("  For:", ethers.formatEther(summary.forVotes), "GOV");
    console.log("  Against:", ethers.formatEther(summary.againstVotes), "GOV");
    console.log("  Abstain:", ethers.formatEther(summary.abstainVotes), "GOV");
    return;
  }

  console.log("Usage:");
  console.log("  node scripts/vote-proposal.js --delegate");
  console.log("  node scripts/vote-proposal.js --id <proposalId> --support <0|1|2>");
  console.log("  node scripts/vote-proposal.js --status --id <proposalId>");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
