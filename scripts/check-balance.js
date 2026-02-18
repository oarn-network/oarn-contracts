const { ethers } = require("ethers");
require("dotenv").config();

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.log("No PRIVATE_KEY in .env");
    return;
  }

  const wallet = new ethers.Wallet(privateKey);
  console.log("Wallet address:", wallet.address);

  const networks = [
    { name: "Ethereum Mainnet", rpc: "https://eth.drpc.org", chainId: 1 },
    { name: "Arbitrum Sepolia", rpc: "https://sepolia-rollup.arbitrum.io/rpc", chainId: 421614 },
    { name: "Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc", chainId: 42161 },
    { name: "Sepolia (ETH)", rpc: "https://rpc.sepolia.org", chainId: 11155111 },
  ];

  console.log("\nBalances:");
  console.log("-".repeat(50));

  for (const net of networks) {
    try {
      const provider = new ethers.JsonRpcProvider(net.rpc);
      const balance = await provider.getBalance(wallet.address);
      console.log(`${net.name.padEnd(20)}: ${ethers.formatEther(balance)} ETH`);
    } catch (e) {
      console.log(`${net.name.padEnd(20)}: Error - ${e.message.substring(0, 30)}`);
    }
  }
}

main();
