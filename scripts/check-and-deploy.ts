import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Wallet:", deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    console.log("\n❌ No funds available.");
    console.log("\nGet testnet ETH from:");
    console.log("  - https://www.alchemy.com/faucets/arbitrum-sepolia");
    console.log("  - https://faucet.quicknode.com/arbitrum/sepolia");
    process.exit(1);
  }

  const minRequired = ethers.parseEther("0.005");
  if (balance < minRequired) {
    console.log(`\n⚠️  Low balance. Need at least 0.005 ETH, have ${ethers.formatEther(balance)}`);
    process.exit(1);
  }

  console.log("\n✅ Sufficient funds. Starting deployment...\n");

  // Import and run deploy script
  const deploy = await import("./deploy");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
