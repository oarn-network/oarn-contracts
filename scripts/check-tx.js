const { ethers } = require("ethers");

async function main() {
  const txHash = "0xdec8a0fcfac836ab144b9715ba5efcd38a3f42a7488ee50fb49a6d447f231c1f";

  const networks = [
    { name: "Arbitrum Sepolia", rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io/tx/" },
    { name: "Sepolia (ETH)", rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io/tx/" },
    { name: "Ethereum Mainnet", rpc: "https://eth.drpc.org", explorer: "https://etherscan.io/tx/" },
    { name: "Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io/tx/" },
  ];

  console.log("Searching for transaction:", txHash);
  console.log("-".repeat(60));

  for (const net of networks) {
    try {
      const provider = new ethers.JsonRpcProvider(net.rpc);
      const tx = await provider.getTransaction(txHash);

      if (tx) {
        console.log(`\nFOUND on ${net.name}!`);
        console.log("Explorer:", net.explorer + txHash);
        console.log("From:", tx.from);
        console.log("To:", tx.to);
        console.log("Value:", ethers.formatEther(tx.value), "ETH");
        console.log("Block:", tx.blockNumber);

        const receipt = await provider.getTransactionReceipt(txHash);
        console.log("Status:", receipt.status === 1 ? "SUCCESS" : "FAILED");
        return;
      }
    } catch (e) {
      // Transaction not found on this network
    }
  }

  console.log("\nTransaction not found on any checked network.");
  console.log("It might be on a different testnet.");
}

main();
