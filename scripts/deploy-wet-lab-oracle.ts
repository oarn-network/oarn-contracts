import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("=".repeat(60));
  console.log("WetLabOracle Deployment");
  console.log("=".repeat(60));
  console.log("\nDeploying with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  if (balance < ethers.parseEther("0.001")) {
    console.error("\nERROR: Insufficient balance for deployment!");
    console.log("Please fund your wallet with testnet ETH from:");
    console.log("  https://faucet.quicknode.com/arbitrum/sepolia");
    process.exit(1);
  }

  // Load existing addresses
  const addressesPath = path.join(__dirname, "..", "deployment-addresses.json");
  const existing = JSON.parse(fs.readFileSync(addressesPath, "utf8"));

  const govTokenAddress = existing.contracts.GOVToken;
  const oarnRegistryAddress = existing.contracts.TaskRegistryV2; // use as registry reference

  console.log("\nUsing GOV Token:      ", govTokenAddress);
  console.log("Using OARN Registry:  ", oarnRegistryAddress);

  // Deployment parameters
  const rewardPerVerification = ethers.parseEther("100"); // 100 GOV per verified result
  const requiredLabConfirmations = 2;

  console.log("\nDeploying WetLabOracle...");
  console.log("  Reward per verification:", ethers.formatEther(rewardPerVerification), "GOV");
  console.log("  Required confirmations: ", requiredLabConfirmations);

  const WetLabOracle = await ethers.getContractFactory("WetLabOracle");
  const oracle = await WetLabOracle.deploy(
    govTokenAddress,
    oarnRegistryAddress,
    rewardPerVerification,
    requiredLabConfirmations
  );

  console.log("  Transaction sent, waiting for confirmation...");
  await oracle.waitForDeployment();

  const oracleAddress = await oracle.getAddress();
  console.log("\n  WetLabOracle deployed to:", oracleAddress);

  const deployTx = oracle.deploymentTransaction();
  if (deployTx) {
    const receipt = await deployTx.wait();
    console.log("  Transaction hash:", deployTx.hash);
    console.log("  Block number:    ", receipt?.blockNumber);
    console.log("  Gas used:        ", receipt?.gasUsed.toString());
  }

  // Update deployment-addresses.json
  const updated = {
    ...existing,
    contracts: {
      ...existing.contracts,
      WetLabOracle: oracleAddress,
    },
    wetLabOracleDeployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(addressesPath, JSON.stringify(updated, null, 2));
  console.log("\nAddresses saved to deployment-addresses.json");

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("\nDeployed WetLabOracle:", oracleAddress);

  console.log("\n" + "-".repeat(60));
  console.log("To verify on Arbiscan:");
  console.log(
    `npx hardhat verify --network arbitrumSepolia ${oracleAddress} ${govTokenAddress} ${oarnRegistryAddress} ${rewardPerVerification.toString()} ${requiredLabConfirmations}`
  );
  console.log("-".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
