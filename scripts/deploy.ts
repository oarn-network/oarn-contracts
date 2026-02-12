import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Deploy COMP Token
  console.log("\n1. Deploying COMP Token...");
  const COMPToken = await ethers.getContractFactory("COMPToken");
  const compToken = await COMPToken.deploy();
  await compToken.waitForDeployment();
  const compAddress = await compToken.getAddress();
  console.log("   COMP Token deployed to:", compAddress);

  // Deploy GOV Token (need treasury and team vesting addresses first)
  // For testnet, use deployer as placeholder
  console.log("\n2. Deploying GOV Token...");
  const GOVToken = await ethers.getContractFactory("GOVToken");
  const govToken = await GOVToken.deploy(
    deployer.address, // treasury (placeholder)
    deployer.address  // team vesting (placeholder)
  );
  await govToken.waitForDeployment();
  const govAddress = await govToken.getAddress();
  console.log("   GOV Token deployed to:", govAddress);

  // Deploy TaskRegistry
  console.log("\n3. Deploying TaskRegistry...");
  const TaskRegistry = await ethers.getContractFactory("TaskRegistry");
  const taskRegistry = await TaskRegistry.deploy(compAddress);
  await taskRegistry.waitForDeployment();
  const taskRegistryAddress = await taskRegistry.getAddress();
  console.log("   TaskRegistry deployed to:", taskRegistryAddress);

  // Deploy OARNRegistry
  console.log("\n4. Deploying OARNRegistry...");
  const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
  const oarnRegistry = await OARNRegistry.deploy(
    taskRegistryAddress,    // TaskRegistry
    compAddress,            // TokenReward (COMP)
    deployer.address,       // ValidatorRegistry (placeholder)
    deployer.address,       // Governance (placeholder)
    govAddress              // GOV Token
  );
  await oarnRegistry.waitForDeployment();
  const oarnRegistryAddress = await oarnRegistry.getAddress();
  console.log("   OARNRegistry deployed to:", oarnRegistryAddress);

  // Configure COMP Token - add TaskRegistry as minter
  console.log("\n5. Configuring COMP Token...");
  await compToken.addMinter(taskRegistryAddress);
  console.log("   TaskRegistry added as minter");

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("\nContract Addresses:");
  console.log("-".repeat(40));
  console.log("COMP Token:      ", compAddress);
  console.log("GOV Token:       ", govAddress);
  console.log("TaskRegistry:    ", taskRegistryAddress);
  console.log("OARNRegistry:    ", oarnRegistryAddress);
  console.log("\n");

  // Write addresses to file for reference
  const fs = await import("fs");
  const addresses = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    contracts: {
      COMPToken: compAddress,
      GOVToken: govAddress,
      TaskRegistry: taskRegistryAddress,
      OARNRegistry: oarnRegistryAddress,
    },
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    "deployment-addresses.json",
    JSON.stringify(addresses, null, 2)
  );
  console.log("Addresses saved to deployment-addresses.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
