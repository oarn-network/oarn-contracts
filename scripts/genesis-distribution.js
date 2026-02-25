const { ethers } = require("ethers");
require("dotenv").config();

// Contract addresses from deployment
const GOV_TOKEN = "0xB97eDD49C225d2c43e7203aB9248cAbED2B268d3";

const GOV_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mintingComplete() view returns (bool)",
  "function TOTAL_SUPPLY() view returns (uint256)",
  "function treasuryAddress() view returns (address)",
  "function teamVestingAddress() view returns (address)",
  "function executeGenesisDistribution(address earlyContributors, address publicSale) external",
  "event GenesisDistribution(address indexed earlyContributors, address indexed publicSale, address indexed treasury, address teamVesting)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider("https://sepolia-rollup.arbitrum.io/rpc");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log("=".repeat(60));
  console.log("GOV Token Genesis Distribution");
  console.log("=".repeat(60));
  console.log("\nWallet:", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("ETH Balance:", ethers.formatEther(balance), "ETH\n");

  const gov = new ethers.Contract(GOV_TOKEN, GOV_ABI, wallet);

  // Check current state
  console.log("-".repeat(40));
  console.log("Current State");
  console.log("-".repeat(40));
  console.log("Name:", await gov.name());
  console.log("Symbol:", await gov.symbol());
  console.log("Max Supply:", ethers.formatEther(await gov.TOTAL_SUPPLY()), "GOV");
  console.log("Current Supply:", ethers.formatEther(await gov.totalSupply()), "GOV");
  console.log("Minting Complete:", await gov.mintingComplete());
  console.log("Treasury Address:", await gov.treasuryAddress());
  console.log("Team Vesting Address:", await gov.teamVestingAddress());

  const mintingComplete = await gov.mintingComplete();
  if (mintingComplete) {
    console.log("\n[!] Genesis distribution already executed!");
    console.log("\nCurrent balances:");
    console.log("- Deployer:", ethers.formatEther(await gov.balanceOf(wallet.address)), "GOV");
    return;
  }

  // Execute genesis distribution
  console.log("\n" + "-".repeat(40));
  console.log("Executing Genesis Distribution");
  console.log("-".repeat(40));

  // For testnet, use deployer address for early contributors and public sale
  const earlyContributors = wallet.address;
  const publicSale = wallet.address;

  console.log("\nDistribution Plan:");
  console.log("- Early Contributors (40%):", earlyContributors, "-> 40,000,000 GOV");
  console.log("- Public Sale (30%):", publicSale, "-> 30,000,000 GOV");
  console.log("- Treasury (20%):", await gov.treasuryAddress(), "-> 20,000,000 GOV");
  console.log("- Team Vesting (10%):", await gov.teamVestingAddress(), "-> 10,000,000 GOV");

  console.log("\nSending transaction...");

  try {
    const tx = await gov.executeGenesisDistribution(earlyContributors, publicSale);
    console.log("TX Hash:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log("Confirmed in block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());

    // Verify distribution
    console.log("\n" + "-".repeat(40));
    console.log("Distribution Complete!");
    console.log("-".repeat(40));
    console.log("New Total Supply:", ethers.formatEther(await gov.totalSupply()), "GOV");
    console.log("Minting Complete:", await gov.mintingComplete());
    console.log("\nBalances:");
    console.log("- Deployer (Early + Public):", ethers.formatEther(await gov.balanceOf(wallet.address)), "GOV");
    console.log("- Treasury:", ethers.formatEther(await gov.balanceOf(await gov.treasuryAddress())), "GOV");
    console.log("- Team Vesting:", ethers.formatEther(await gov.balanceOf(await gov.teamVestingAddress())), "GOV");

    console.log("\n[SUCCESS] Genesis distribution executed!");

  } catch (e) {
    console.log("Error:", e.message);
    if (e.reason) console.log("Reason:", e.reason);
  }

  console.log("\n" + "=".repeat(60));
}

main().catch(console.error);
