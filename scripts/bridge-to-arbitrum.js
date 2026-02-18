const { ethers } = require("ethers");
require("dotenv").config();

// Arbitrum Sepolia Bridge (Inbox contract on Sepolia L1)
const INBOX_ADDRESS = "0xaAe29B0366299461418F5324a79Afc425BE5ae21";

const INBOX_ABI = [
  "function depositEth() external payable returns (uint256)"
];

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.log("No PRIVATE_KEY in .env");
    return;
  }

  // Connect to Sepolia L1
  const sepoliaRpc = "https://ethereum-sepolia-rpc.publicnode.com";
  const provider = new ethers.JsonRpcProvider(sepoliaRpc);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log("Wallet:", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("Sepolia Balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    console.log("No Sepolia ETH to bridge!");
    return;
  }

  // Bridge 0.1 ETH to Arbitrum Sepolia (keep some for gas)
  const amountToBridge = ethers.parseEther("0.1");

  console.log("\nBridging 0.1 ETH to Arbitrum Sepolia...");
  console.log("This will take ~10 minutes to arrive on L2.");

  const inbox = new ethers.Contract(INBOX_ADDRESS, INBOX_ABI, wallet);

  try {
    const tx = await inbox.depositEth({ value: amountToBridge });
    console.log("Transaction sent:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log("Confirmed in block:", receipt.blockNumber);
    console.log("\nBridge initiated successfully!");
    console.log("Wait ~10 minutes, then check Arbitrum Sepolia balance.");
    console.log("Track at: https://sepolia.arbiscan.io/address/" + wallet.address);
  } catch (e) {
    console.log("Error:", e.message);
  }
}

main();
