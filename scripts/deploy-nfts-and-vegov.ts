import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deploy ResultNFT, ReproducibilitySBT, VeGOV, and ProtocolFee.
 * Then wire them into TaskRegistryV2.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-nfts-and-vegov.ts --network arbitrumSepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const addresses = JSON.parse(fs.readFileSync("deployment-addresses.json", "utf8"));

  const taskRegistryV2Address = addresses.contracts.TaskRegistryV2;
  const govTokenAddress       = addresses.contracts.GOVToken;
  if (!taskRegistryV2Address) throw new Error("TaskRegistryV2 address not found");
  if (!govTokenAddress)       throw new Error("GOVToken address not found");

  console.log("Deployer:       ", deployer.address);
  console.log("TaskRegistryV2: ", taskRegistryV2Address);
  console.log("GOVToken:       ", govTokenAddress);
  console.log("");

  // ── 1. ResultNFT ────────────────────────────────────────────────────────────
  console.log("Deploying ResultNFT...");
  const ResultNFT = await ethers.getContractFactory("ResultNFT");
  const resultNFT = await ResultNFT.deploy(taskRegistryV2Address);
  await resultNFT.waitForDeployment();
  const resultNFTAddress = await resultNFT.getAddress();
  console.log("ResultNFT deployed to:", resultNFTAddress);

  // ── 2. ReproducibilitySBT ───────────────────────────────────────────────────
  console.log("\nDeploying ReproducibilitySBT...");
  const ReproducibilitySBT = await ethers.getContractFactory("ReproducibilitySBT");
  const sbt = await ReproducibilitySBT.deploy(taskRegistryV2Address);
  await sbt.waitForDeployment();
  const sbtAddress = await sbt.getAddress();
  console.log("ReproducibilitySBT deployed to:", sbtAddress);

  // ── 3. VeGOV ────────────────────────────────────────────────────────────────
  console.log("\nDeploying VeGOV...");
  const VeGOV = await ethers.getContractFactory("VeGOV");
  const veGOV = await VeGOV.deploy(govTokenAddress);
  await veGOV.waitForDeployment();
  const veGOVAddress = await veGOV.getAddress();
  console.log("VeGOV deployed to:", veGOVAddress);

  // ── 4. ProtocolFee ──────────────────────────────────────────────────────────
  console.log("\nDeploying ProtocolFee...");
  const ProtocolFee = await ethers.getContractFactory("ProtocolFee");
  const protocolFee = await ProtocolFee.deploy(veGOVAddress);
  await protocolFee.waitForDeployment();
  const protocolFeeAddress = await protocolFee.getAddress();
  console.log("ProtocolFee deployed to:", protocolFeeAddress);

  // ── 5. Wire into TaskRegistryV2 ─────────────────────────────────────────────
  console.log("\nWiring contracts into TaskRegistryV2...");
  const taskRegistry = await ethers.getContractAt("TaskRegistryV2", taskRegistryV2Address);

  console.log("  setResultNFTContract...");
  await (await taskRegistry.setResultNFTContract(resultNFTAddress)).wait();

  console.log("  setReproducibilitySBTContract...");
  await (await taskRegistry.setReproducibilitySBTContract(sbtAddress)).wait();

  console.log("  setProtocolFeeCollector (2%)...");
  await (await taskRegistry.setProtocolFeeCollector(protocolFeeAddress, 200)).wait();

  // ── 6. Update deployment-addresses.json ─────────────────────────────────────
  addresses.contracts.ResultNFT          = resultNFTAddress;
  addresses.contracts.ReproducibilitySBT = sbtAddress;
  addresses.contracts.VeGOV              = veGOVAddress;
  addresses.contracts.ProtocolFee        = protocolFeeAddress;
  addresses.nftsAndVeGOVDeployedAt       = new Date().toISOString();
  fs.writeFileSync("deployment-addresses.json", JSON.stringify(addresses, null, 2));
  console.log("\ndeployment-addresses.json updated.");

  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log("ResultNFT:          ", resultNFTAddress);
  console.log("ReproducibilitySBT: ", sbtAddress);
  console.log("VeGOV:              ", veGOVAddress);
  console.log("ProtocolFee:        ", protocolFeeAddress);
  console.log("\nAll contracts wired into TaskRegistryV2.");
  console.log("\n--- NEXT STEPS ---");
  console.log("1. Add contract addresses to oarn-dashboard/lib/constants.ts");
  console.log("2. Redeploy dashboard with NEXT_PUBLIC_* env vars if needed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
