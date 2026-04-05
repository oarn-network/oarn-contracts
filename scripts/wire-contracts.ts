import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Wire ResultNFT, ReproducibilitySBT, and ProtocolFee into the existing TaskRegistryV2.
 * Also update minter on ResultNFT and SBT to point to TaskRegistryV2.
 *
 * Usage:
 *   npx hardhat run scripts/wire-contracts.ts --network arbitrumSepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const addresses = JSON.parse(fs.readFileSync("deployment-addresses.json", "utf8"));

  const taskRegistryV2Address  = addresses.contracts.TaskRegistryV2;
  const resultNFTAddress       = addresses.contracts.ResultNFT;
  const sbtAddress             = addresses.contracts.ReproducibilitySBT;
  const protocolFeeAddress     = addresses.contracts.ProtocolFee;
  const reputationAddress      = addresses.contracts.NodeReputation || "";

  console.log("Deployer:          ", deployer.address);
  console.log("TaskRegistryV2:    ", taskRegistryV2Address);
  console.log("ResultNFT:         ", resultNFTAddress);
  console.log("ReproducibilitySBT:", sbtAddress);
  console.log("ProtocolFee:       ", protocolFeeAddress);
  console.log("");

  const taskRegistry = await ethers.getContractAt("TaskRegistryV2", taskRegistryV2Address);

  if (reputationAddress) {
    console.log("Setting reputationRegistry...");
    await (await taskRegistry.setReputationRegistry(reputationAddress)).wait();
    console.log("  done.");
  }

  console.log("Setting ResultNFT contract...");
  await (await taskRegistry.setResultNFTContract(resultNFTAddress)).wait();
  console.log("  done.");

  console.log("Setting ReproducibilitySBT contract...");
  await (await taskRegistry.setReproducibilitySBTContract(sbtAddress)).wait();
  console.log("  done.");

  console.log("Setting ProtocolFee collector (2%)...");
  await (await taskRegistry.setProtocolFeeCollector(protocolFeeAddress, 200)).wait();
  console.log("  done.");

  // Ensure NFT/SBT minter is set to this TaskRegistryV2
  const resultNFT = await ethers.getContractAt("ResultNFT", resultNFTAddress);
  console.log("Updating ResultNFT minter to TaskRegistryV2...");
  await (await resultNFT.setMinter(taskRegistryV2Address)).wait();
  console.log("  done.");

  const sbt = await ethers.getContractAt("ReproducibilitySBT", sbtAddress);
  console.log("Updating ReproducibilitySBT minter to TaskRegistryV2...");
  await (await sbt.setMinter(taskRegistryV2Address)).wait();
  console.log("  done.");

  console.log("\n=== All contracts wired successfully ===");
  console.log("TaskRegistryV2:", taskRegistryV2Address);
  console.log("  -> ResultNFT:          ", resultNFTAddress);
  console.log("  -> ReproducibilitySBT: ", sbtAddress);
  console.log("  -> ProtocolFee (2%):   ", protocolFeeAddress);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
