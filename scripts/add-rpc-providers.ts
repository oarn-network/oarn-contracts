import { ethers } from "hardhat";

/**
 * Script to redeploy OARNRegistry with admin functions and add public RPC providers
 *
 * Public RPC endpoints for Arbitrum Sepolia:
 * - Arbitrum Official
 * - BlockPI
 * - Blast API
 * - Ankr
 */

// Existing contract addresses
const TASK_REGISTRY = "0x4Dc9dD73834E94545cF041091e1A743FBD09a60f";
const TASK_REGISTRY_V2 = "0x7b4898aDf69447d6ED3d62F6917CE10bD6519562";
const COMP_TOKEN = "0x24249A523A251E38CB0001daBd54DD44Ea8f1838";
const GOV_TOKEN = "0xB97eDD49C225d2c43e7203aB9248cAbED2B268d3";

// Public RPC providers to add (Arbitrum Sepolia)
const RPC_PROVIDERS = [
  {
    name: "Arbitrum Official",
    endpoint: "https://sepolia-rollup.arbitrum.io/rpc",
    onionEndpoint: "",
  },
  {
    name: "BlockPI",
    endpoint: "https://arbitrum-sepolia.blockpi.network/v1/rpc/public",
    onionEndpoint: "",
  },
  {
    name: "Blast API",
    endpoint: "https://arbitrum-sepolia.public.blastapi.io",
    onionEndpoint: "",
  },
  {
    name: "Ankr",
    endpoint: "https://rpc.ankr.com/arbitrum_sepolia",
    onionEndpoint: "",
  },
  {
    name: "Alchemy",
    endpoint: "https://arb-sepolia.g.alchemy.com/v2/demo",
    onionEndpoint: "",
  },
];

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("=".repeat(60));
  console.log("OARN Registry - Add RPC Providers");
  console.log("=".repeat(60));
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // Step 1: Deploy new OARNRegistry with admin functions
  console.log("\n1. Deploying OARNRegistry with admin functions...");
  const OARNRegistry = await ethers.getContractFactory("OARNRegistry");
  const oarnRegistry = await OARNRegistry.deploy(
    TASK_REGISTRY,
    COMP_TOKEN,
    deployer.address,  // validatorRegistry placeholder
    deployer.address,  // governance placeholder
    GOV_TOKEN
  );
  await oarnRegistry.waitForDeployment();
  const registryAddress = await oarnRegistry.getAddress();
  console.log("   OARNRegistry deployed to:", registryAddress);

  // Step 2: Set TaskRegistryV2
  console.log("\n2. Setting TaskRegistryV2...");
  let tx = await oarnRegistry.setTaskRegistryV2(TASK_REGISTRY_V2);
  await tx.wait();
  console.log("   TaskRegistryV2 set to:", TASK_REGISTRY_V2);

  // Step 3: Add RPC providers
  console.log("\n3. Adding RPC providers...");

  for (let i = 0; i < RPC_PROVIDERS.length; i++) {
    const provider = RPC_PROVIDERS[i];
    // Use a deterministic address for each provider (deployer address + index)
    const providerAddress = ethers.getAddress(
      "0x" + (BigInt(deployer.address) + BigInt(i + 1)).toString(16).padStart(40, "0")
    );

    console.log(`   Adding ${provider.name}...`);
    try {
      tx = await oarnRegistry.addRPCProviderAdmin(
        provider.endpoint,
        provider.onionEndpoint,
        providerAddress
      );
      await tx.wait();
      console.log(`   ✓ Added: ${provider.endpoint}`);
    } catch (error: any) {
      console.log(`   ✗ Failed: ${error.message}`);
    }
  }

  // Step 4: Verify
  console.log("\n4. Verifying RPC providers...");
  const activeCount = await oarnRegistry.activeRpcCount();
  console.log("   Active RPC providers:", activeCount.toString());

  const providers = await oarnRegistry.getActiveRPCProviders();
  console.log("\n   Registered providers:");
  for (const p of providers) {
    console.log(`   - ${p.endpoint}`);
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("\nNew OARNRegistry Address:", registryAddress);
  console.log("RPC Providers Added:", activeCount.toString());
  console.log("\n⚠️  Update your node config.toml with:");
  console.log(`   oarn_registry = "${registryAddress}"`);
  console.log("\nCore contracts:");
  const core = await oarnRegistry.getCoreContractsV2();
  console.log("   TaskRegistry:", core._taskRegistry);
  console.log("   TaskRegistryV2:", core._taskRegistryV2);
  console.log("   COMP Token:", core._tokenReward);
  console.log("   GOV Token:", core._govToken);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
