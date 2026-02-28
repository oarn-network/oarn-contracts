import { ethers } from "hardhat";

// Existing testnet contract addresses
const EXISTING_CONTRACTS = {
  COMPToken: "0x24249A523A251E38CB0001daBd54DD44Ea8f1838",
  GOVToken: "0xB97eDD49C225d2c43e7203aB9248cAbED2B268d3",
  TaskRegistry: "0x4Dc9dD73834E94545cF041091e1A743FBD09a60f",
  OARNRegistry: "0xa122518Cb6E66A804fc37EB26c8a7aF309dCF04C",
};

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("=".repeat(60));
  console.log("TaskRegistryV2 Deployment");
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

  // Deploy TaskRegistryV2
  console.log("\nDeploying TaskRegistryV2...");
  console.log("  Using COMP Token:", EXISTING_CONTRACTS.COMPToken);

  const TaskRegistryV2 = await ethers.getContractFactory("TaskRegistryV2");
  const taskRegistryV2 = await TaskRegistryV2.deploy(EXISTING_CONTRACTS.COMPToken);

  console.log("  Transaction sent, waiting for confirmation...");
  await taskRegistryV2.waitForDeployment();

  const taskRegistryV2Address = await taskRegistryV2.getAddress();
  console.log("\n  TaskRegistryV2 deployed to:", taskRegistryV2Address);

  // Get deployment info
  const deployTx = taskRegistryV2.deploymentTransaction();
  if (deployTx) {
    console.log("  Transaction hash:", deployTx.hash);
    const receipt = await deployTx.wait();
    console.log("  Block number:", receipt?.blockNumber);
    console.log("  Gas used:", receipt?.gasUsed.toString());
  }

  // Verify contract state
  console.log("\nVerifying contract state...");
  const minReward = await taskRegistryV2.minRewardPerNode();
  const majorityThreshold = await taskRegistryV2.majorityThreshold();
  const superMajorityThreshold = await taskRegistryV2.superMajorityThreshold();

  console.log("  Min reward per node:", ethers.formatEther(minReward), "ETH");
  console.log("  Majority threshold:", Number(majorityThreshold) / 100, "%");
  console.log("  SuperMajority threshold:", Number(superMajorityThreshold) / 100, "%");

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("\nTaskRegistryV2:", taskRegistryV2Address);
  console.log("\nExisting Contracts (unchanged):");
  console.log("  COMP Token:    ", EXISTING_CONTRACTS.COMPToken);
  console.log("  GOV Token:     ", EXISTING_CONTRACTS.GOVToken);
  console.log("  TaskRegistry:  ", EXISTING_CONTRACTS.TaskRegistry);
  console.log("  OARNRegistry:  ", EXISTING_CONTRACTS.OARNRegistry);

  // Update deployment addresses file
  const fs = await import("fs");
  const addresses = {
    network: "arbitrumSepolia",
    chainId: 421614,
    deployer: deployer.address,
    contracts: {
      ...EXISTING_CONTRACTS,
      TaskRegistryV2: taskRegistryV2Address,
    },
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    "deployment-addresses.json",
    JSON.stringify(addresses, null, 2)
  );
  console.log("\nAddresses saved to deployment-addresses.json");

  // Verification command
  console.log("\n" + "-".repeat(60));
  console.log("To verify on Arbiscan:");
  console.log(`npx hardhat verify --network arbitrumSepolia ${taskRegistryV2Address} ${EXISTING_CONTRACTS.COMPToken}`);
  console.log("-".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
