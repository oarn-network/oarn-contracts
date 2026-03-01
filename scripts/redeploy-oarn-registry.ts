import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Redeploying OARNRegistry with TaskRegistryV2 support");
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // Existing contract addresses from previous deployment
  const TASK_REGISTRY = "0x4Dc9dD73834E94545cF041091e1A743FBD09a60f";
  const TASK_REGISTRY_V2 = "0x7b4898aDf69447d6ED3d62F6917CE10bD6519562";
  const COMP_TOKEN = "0x24249A523A251E38CB0001daBd54DD44Ea8f1838";
  const GOV_TOKEN = "0xB97eDD49C225d2c43e7203aB9248cAbED2B268d3";

  // Deploy new OARNRegistry
  console.log("\n1. Deploying new OARNRegistry...");
  const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
  const oarnRegistry = await OARNRegistry.deploy(
    TASK_REGISTRY,      // taskRegistry (immutable)
    COMP_TOKEN,         // tokenReward (immutable)
    deployer.address,   // validatorRegistry (placeholder)
    deployer.address,   // governance (placeholder)
    GOV_TOKEN           // govToken
  );
  await oarnRegistry.waitForDeployment();
  const oarnRegistryAddress = await oarnRegistry.getAddress();
  console.log("   OARNRegistry deployed to:", oarnRegistryAddress);

  // Set TaskRegistryV2 address
  console.log("\n2. Setting TaskRegistryV2 address...");
  const tx = await oarnRegistry.setTaskRegistryV2(TASK_REGISTRY_V2);
  await tx.wait();
  console.log("   TaskRegistryV2 set to:", TASK_REGISTRY_V2);

  // Verify
  console.log("\n3. Verifying...");
  const storedV2 = await oarnRegistry.taskRegistryV2();
  console.log("   Stored TaskRegistryV2:", storedV2);

  // Get all core contracts
  const coreV2 = await oarnRegistry.getCoreContractsV2();
  console.log("\n   getCoreContractsV2():");
  console.log("   - taskRegistry:", coreV2._taskRegistry);
  console.log("   - taskRegistryV2:", coreV2._taskRegistryV2);
  console.log("   - tokenReward:", coreV2._tokenReward);
  console.log("   - validatorRegistry:", coreV2._validatorRegistry);
  console.log("   - governance:", coreV2._governance);
  console.log("   - govToken:", coreV2._govToken);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("\nNew OARNRegistry Address:", oarnRegistryAddress);
  console.log("TaskRegistryV2 Address:", TASK_REGISTRY_V2);
  console.log("\nUpdate your node config with the new OARNRegistry address!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
