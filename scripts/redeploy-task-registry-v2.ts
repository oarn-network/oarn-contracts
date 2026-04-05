import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Redeploy TaskRegistryV2 with NFT/SBT/ProtocolFee hooks and rewire all contracts.
 *
 * Usage:
 *   npx hardhat run scripts/redeploy-task-registry-v2.ts --network arbitrumSepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const addresses = JSON.parse(fs.readFileSync("deployment-addresses.json", "utf8"));

  const compToken         = addresses.contracts.COMPToken;
  const resultNFT         = addresses.contracts.ResultNFT;
  const sbt               = addresses.contracts.ReproducibilitySBT;
  const veGOV             = addresses.contracts.VeGOV;
  const protocolFee       = addresses.contracts.ProtocolFee;
  const reputationRegistry = addresses.contracts.NodeReputation || "";

  console.log("Deployer:", deployer.address);
  console.log("Redeploying TaskRegistryV2 with updated hooks...\n");

  const TaskRegistryV2 = await ethers.getContractFactory("TaskRegistryV2");
  const taskRegistry   = await TaskRegistryV2.deploy(compToken);
  await taskRegistry.waitForDeployment();
  const newAddress = await taskRegistry.getAddress();
  console.log("New TaskRegistryV2:", newAddress);

  // Wire optional integrations
  if (reputationRegistry) {
    console.log("Setting reputationRegistry...");
    await (await taskRegistry.setReputationRegistry(reputationRegistry)).wait();
  }
  if (resultNFT) {
    console.log("Setting ResultNFT...");
    await (await taskRegistry.setResultNFTContract(resultNFT)).wait();
  }
  if (sbt) {
    console.log("Setting ReproducibilitySBT...");
    await (await taskRegistry.setReproducibilitySBTContract(sbt)).wait();
  }
  if (protocolFee) {
    console.log("Setting ProtocolFee (2%)...");
    await (await taskRegistry.setProtocolFeeCollector(protocolFee, 200)).wait();
  }

  // Update ResultNFT + SBT minter to new TaskRegistryV2
  if (resultNFT) {
    const resultNFTContract = await ethers.getContractAt("ResultNFT", resultNFT);
    console.log("Updating ResultNFT minter...");
    await (await resultNFTContract.setMinter(newAddress)).wait();
  }
  if (sbt) {
    const sbtContract = await ethers.getContractAt("ReproducibilitySBT", sbt);
    console.log("Updating ReproducibilitySBT minter...");
    await (await sbtContract.setMinter(newAddress)).wait();
  }

  // Update addresses.json
  addresses.contracts.TaskRegistryV2 = newAddress;
  addresses.taskRegistryV2RedployedAt = new Date().toISOString();
  fs.writeFileSync("deployment-addresses.json", JSON.stringify(addresses, null, 2));
  console.log("\ndeployment-addresses.json updated.");

  console.log("\n=== TaskRegistryV2 redeployed and fully wired ===");
  console.log("New address:", newAddress);
  console.log("\nIMPORTANT: Update oarn-dashboard/lib/constants.ts TASK_REGISTRY with new address.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
