import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("=".repeat(60));
  console.log("Deploying OARNGovernance");
  console.log("=".repeat(60));
  console.log("\nDeployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // Read current deployment addresses
  const addressesPath = path.join(__dirname, "..", "deployment-addresses.json");
  const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const govTokenAddress = addresses.contracts.GOVToken;

  if (!govTokenAddress) {
    throw new Error("GOVToken address not found in deployment-addresses.json");
  }

  console.log("\nUsing GOVToken:", govTokenAddress);

  // Deploy OARNGovernance
  console.log("\nDeploying OARNGovernance...");
  const OARNGovernance = await ethers.getContractFactory("OARNGovernance");
  const governance = await OARNGovernance.deploy(govTokenAddress);
  await governance.waitForDeployment();
  const governanceAddress = await governance.getAddress();

  console.log("OARNGovernance deployed to:", governanceAddress);

  // Verify settings
  const votingDelay = await governance.votingDelay();
  const votingPeriod = await governance.votingPeriod();
  const threshold = await governance.proposalThreshold();
  console.log("\nGovernance settings:");
  console.log("  Voting delay:", votingDelay.toString(), "blocks (~1 day)");
  console.log("  Voting period:", votingPeriod.toString(), "blocks (~1 week)");
  console.log("  Proposal threshold:", ethers.formatEther(threshold), "GOV");
  console.log("  Quorum: 4% of total supply");

  // Update deployment-addresses.json
  addresses.contracts.OARNGovernance = governanceAddress;
  addresses.governanceDeployedAt = new Date().toISOString();
  fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));

  console.log("\nUpdated deployment-addresses.json");
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("\nNext step — run governance setup:");
  console.log(`  GOVERNANCE_ADDRESS=${governanceAddress} node scripts/governance-setup.js`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
