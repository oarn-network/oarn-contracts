const { ethers } = require("ethers");
require("dotenv").config();

async function main() {
  const address = "0x7379651E169e63272ec57Ce14f2BfC023e28382E";
  const provider = new ethers.JsonRpcProvider("https://sepolia-rollup.arbitrum.io/rpc");

  console.log("Waiting for bridged ETH to arrive on Arbitrum Sepolia...");
  console.log("Address:", address);
  console.log("-".repeat(50));

  let attempts = 0;
  const maxAttempts = 30; // 15 minutes max

  while (attempts < maxAttempts) {
    const balance = await provider.getBalance(address);
    const balanceEth = ethers.formatEther(balance);

    process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Balance: ${balanceEth} ETH`);

    if (balance > 0n) {
      console.log("\n\n*** ETH ARRIVED! ***");
      console.log("Balance:", balanceEth, "ETH");
      console.log("\nReady to deploy contracts!");
      return true;
    }

    await new Promise(r => setTimeout(r, 30000)); // Wait 30 seconds
    attempts++;
  }

  console.log("\n\nTimed out waiting for bridge. Check manually:");
  console.log("https://sepolia.arbiscan.io/address/" + address);
  return false;
}

main().then(success => {
  if (success) {
    console.log("\nRun: deploy-testnet.bat");
  }
});
