const { ethers } = require("ethers");

async function main() {
  const address = "0x7379651E169e63272ec57Ce14f2BfC023e28382E";
  const provider = new ethers.JsonRpcProvider("https://1rpc.io/eth");

  const balance = await provider.getBalance(address);
  const nonce = await provider.getTransactionCount(address);

  console.log("=== Wallet Status ===");
  console.log("Address:", address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");
  console.log("Transaction Count (nonce):", nonce);
  console.log("");
  console.log("View on Etherscan: https://etherscan.io/address/" + address);
}

main().catch(console.error);
