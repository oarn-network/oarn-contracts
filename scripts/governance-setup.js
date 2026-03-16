/**
 * governance-setup.js
 *
 * Complete OARN Governance activation script. Run after deploy-governance.ts.
 *
 * Steps:
 *   1. Check / execute GOV genesis distribution
 *   2. Self-delegate deployer voting power
 *   3. Distribute 100,000 GOV to 5 test wallets (if TEST_WALLET_1..5 set)
 *   4. Create first governance proposal: "Approve GENESIS-001 Research Parameters"
 *
 * Usage:
 *   PRIVATE_KEY=0x... GOVERNANCE_ADDRESS=0x... node scripts/governance-setup.js
 *
 *   Optional (for test wallet distribution):
 *   TEST_WALLET_1=0x... TEST_WALLET_2=0x... ... TEST_WALLET_5=0x... node scripts/governance-setup.js
 */

const { ethers } = require("ethers");
require("dotenv").config();

// ============ Config ============

const GOV_TOKEN = "0xB97eDD49C225d2c43e7203aB9248cAbED2B268d3";
const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
const GOVERNANCE_ADDRESS = process.env.GOVERNANCE_ADDRESS || "";
const GOV_PER_TEST_WALLET = ethers.parseEther("100000"); // 100,000 GOV each

const TEST_WALLETS = [
  process.env.TEST_WALLET_1,
  process.env.TEST_WALLET_2,
  process.env.TEST_WALLET_3,
  process.env.TEST_WALLET_4,
  process.env.TEST_WALLET_5,
].filter(Boolean);

// ============ ABIs ============

const GOV_TOKEN_ABI = [
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mintingComplete() view returns (bool)",
  "function TOTAL_SUPPLY() view returns (uint256)",
  "function treasuryAddress() view returns (address)",
  "function teamVestingAddress() view returns (address)",
  "function executeGenesisDistribution(address earlyContributors, address publicSale) external",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function delegate(address delegatee) external",
  "function delegates(address account) view returns (address)",
  "function getVotes(address account) view returns (uint256)",
];

const GOVERNANCE_ABI = [
  "function proposalCount() view returns (uint256)",
  "function getProposalId(uint256 index) view returns (uint256)",
  "function getProposalSummary(uint256 proposalId) view returns (string title, string description, address proposer, uint256 startBlock, uint256 endBlock, uint8 status, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes)",
  "function proposeWithMetadata(address[] targets, uint256[] values, bytes[] calldatas, string title, string description) returns (uint256)",
  "function votingDelay() view returns (uint256)",
  "function votingPeriod() view returns (uint256)",
  "function proposalThreshold() view returns (uint256)",
  "function state(uint256 proposalId) view returns (uint8)",
  "function castVote(uint256 proposalId, uint8 support) returns (uint256 balance)",
];

// Proposal state names (OpenZeppelin)
const PROPOSAL_STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];

// ============ Main ============

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error("ERROR: PRIVATE_KEY env var not set");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log("=".repeat(60));
  console.log("OARN Governance Setup");
  console.log("=".repeat(60));
  console.log("\nDeployer:", wallet.address);
  console.log("ETH Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH");

  const gov = new ethers.Contract(GOV_TOKEN, GOV_TOKEN_ABI, wallet);

  // ── Step 1: Genesis Distribution ──────────────────────────────
  console.log("\n--- Step 1: Genesis Distribution ---");
  const mintingComplete = await gov.mintingComplete();

  if (mintingComplete) {
    console.log("[SKIP] Already executed");
    console.log("Total Supply:", ethers.formatEther(await gov.totalSupply()), "GOV");
    console.log("Deployer Balance:", ethers.formatEther(await gov.balanceOf(wallet.address)), "GOV");
  } else {
    console.log("Executing genesis distribution...");
    console.log("  40% Early Contributors →", wallet.address);
    console.log("  30% Public Sale →", wallet.address);
    console.log("  20% Treasury →", await gov.treasuryAddress());
    console.log("  10% Team Vesting →", await gov.teamVestingAddress());

    const tx = await gov.executeGenesisDistribution(wallet.address, wallet.address);
    console.log("  TX:", tx.hash);
    const receipt = await tx.wait();
    console.log("  Confirmed in block:", receipt.blockNumber);

    console.log("[OK] Genesis distribution complete");
    console.log("  Total Supply:", ethers.formatEther(await gov.totalSupply()), "GOV");
    console.log("  Deployer Balance:", ethers.formatEther(await gov.balanceOf(wallet.address)), "GOV");
  }

  // ── Step 2: Self-Delegate ─────────────────────────────────────
  console.log("\n--- Step 2: Self-Delegate (Activate Voting Power) ---");
  const currentDelegate = await gov.delegates(wallet.address);

  if (currentDelegate.toLowerCase() === wallet.address.toLowerCase()) {
    console.log("[SKIP] Already delegated to self");
  } else {
    const tx = await gov.delegate(wallet.address);
    console.log("  TX:", tx.hash);
    await tx.wait();
    console.log("[OK] Delegated to self");
  }

  const votes = await gov.getVotes(wallet.address);
  console.log("  Active Voting Power:", ethers.formatEther(votes), "GOV");

  // ── Step 3: Distribute to Test Wallets ───────────────────────
  console.log("\n--- Step 3: Distribute to Test Wallets ---");

  if (TEST_WALLETS.length === 0) {
    console.log("[SKIP] No TEST_WALLET_1..5 env vars set");
    console.log("  To distribute tokens, set:");
    console.log("  TEST_WALLET_1=0x... TEST_WALLET_2=0x... node scripts/governance-setup.js");
  } else {
    const deployerBalance = await gov.balanceOf(wallet.address);
    const needed = GOV_PER_TEST_WALLET * BigInt(TEST_WALLETS.length);

    if (deployerBalance < needed) {
      console.log("[WARN] Insufficient balance for full distribution");
      console.log(`  Have: ${ethers.formatEther(deployerBalance)} GOV`);
      console.log(`  Need: ${ethers.formatEther(needed)} GOV`);
    }

    for (const testWallet of TEST_WALLETS) {
      const bal = await gov.balanceOf(testWallet);
      if (bal >= GOV_PER_TEST_WALLET) {
        console.log(`[SKIP] ${testWallet} already has ${ethers.formatEther(bal)} GOV`);
        continue;
      }
      const amount = GOV_PER_TEST_WALLET - bal;
      const tx = await gov.transfer(testWallet, amount);
      console.log(`  TX: ${tx.hash}`);
      await tx.wait();
      console.log(`  [OK] Sent ${ethers.formatEther(amount)} GOV to ${testWallet}`);
    }

    console.log("\n  [!] IMPORTANT: Each test wallet must call delegate(self) before voting.");
    console.log("      Use vote-proposal.js --delegate or call gov.delegate(ownAddress) from each wallet.");
  }

  // ── Step 4: Create First Proposal ────────────────────────────
  console.log("\n--- Step 4: Create First Proposal ---");

  if (!GOVERNANCE_ADDRESS) {
    console.log("[SKIP] GOVERNANCE_ADDRESS not set");
    console.log("  1. Deploy governance: npx hardhat run scripts/deploy-governance.ts --network arbitrumSepolia");
    console.log("  2. Re-run: GOVERNANCE_ADDRESS=0x... node scripts/governance-setup.js");
    return;
  }

  const governance = new ethers.Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, wallet);
  const count = await governance.proposalCount();

  if (count > 0n) {
    console.log("[SKIP] Proposals already exist:", count.toString());
    const pid = await governance.getProposalId(0n);
    const summary = await governance.getProposalSummary(pid);
    console.log("  Title:", summary.title);
    console.log("  State:", PROPOSAL_STATES[summary.status] || summary.status.toString());
  } else {
    const currentVotes = await gov.getVotes(wallet.address);
    const threshold = await governance.proposalThreshold();

    if (currentVotes < threshold) {
      console.log("[ERROR] Insufficient voting power to propose");
      console.log("  Current votes:", ethers.formatEther(currentVotes), "GOV");
      console.log("  Required:", ethers.formatEther(threshold), "GOV");
      console.log("  Run genesis distribution (Step 1) and self-delegate (Step 2) first.");
      return;
    }

    const title = "Approve GENESIS-001 Research Parameters";
    const description = [
      "# GENESIS-001: Insulin Synthesis Optimization",
      "",
      "## Summary",
      "Approve the initial parameters for GENESIS-001, the OARN Network's first official",
      "research task — AI-driven optimization of insulin synthesis pathways.",
      "",
      "## Research Goal",
      "Use distributed AI inference across OARN nodes to run molecular dynamics simulations",
      "and identify optimized insulin synthesis routes with improved yield and purity.",
      "",
      "## Parameters",
      "- **Model:** GENESIS-001-v1 (ONNX, stored on IPFS)",
      "- **Required Nodes:** 3 (consensus threshold)",
      "- **Reward per Node:** 100 COMP tokens",
      "- **Deadline:** 30 days from activation",
      "- **Consensus Type:** SuperMajority (2/3 nodes must agree)",
      "",
      "## Voting",
      "- Vote **FOR** to approve these parameters and activate GENESIS-001",
      "- Vote **AGAINST** to block and require revised parameters",
      "- Vote **ABSTAIN** to count toward quorum without taking a position",
    ].join("\n");

    // No-op proposal (governance text vote — no on-chain action)
    const targets = [GOVERNANCE_ADDRESS];
    const values = [0n];
    const calldatas = ["0x"];

    console.log("  Creating proposal:", title);
    const tx = await governance.proposeWithMetadata(targets, values, calldatas, title, description);
    console.log("  TX:", tx.hash);
    const receipt = await tx.wait();
    console.log("  Confirmed in block:", receipt.blockNumber);

    const proposalId = await governance.getProposalId(0n);
    const delay = await governance.votingDelay();
    const period = await governance.votingPeriod();

    console.log("\n  [OK] Proposal created!");
    console.log("  Proposal ID:", proposalId.toString());
    console.log("  Voting starts in:", delay.toString(), "blocks (~1 day)");
    console.log("  Voting ends after:", period.toString(), "more blocks (~1 week)");
    console.log("\n  To vote: node scripts/vote-proposal.js --id", proposalId.toString(), "--support 1");
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("GOVERNANCE SETUP COMPLETE");
  console.log("=".repeat(60));

  const totalSupply = await gov.totalSupply();
  const deployerBal = await gov.balanceOf(wallet.address);
  const deployerVotes = await gov.getVotes(wallet.address);

  console.log("\nToken State:");
  console.log("  Total Supply:", ethers.formatEther(totalSupply), "GOV");
  console.log("  Deployer Balance:", ethers.formatEther(deployerBal), "GOV");
  console.log("  Deployer Votes:", ethers.formatEther(deployerVotes), "GOV");

  if (GOVERNANCE_ADDRESS) {
    const count = await governance.proposalCount();
    console.log("\nGovernance State:");
    console.log("  Address:", GOVERNANCE_ADDRESS);
    console.log("  Proposals:", count.toString());
  }

  console.log("\nNext Steps:");
  console.log("  1. Wait for voting delay (~1 day on Arbitrum Sepolia)");
  console.log("  2. Token holders delegate to themselves: gov.delegate(ownAddress)");
  console.log("  3. Cast votes: node scripts/vote-proposal.js --id <id> --support 1");
  console.log("  4. After voting period: check quorum (4% of 100M = 4M GOV required)");
  console.log("  5. Execute if passed: npx hardhat run scripts/execute-proposal.js --network arbitrumSepolia");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
