import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deploy GOVSale and update deployment-addresses.json.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-gov-sale.ts --network arbitrumSepolia
 *
 * After deployment:
 *   1. Call GOVToken.executeGenesisDistribution(earlyContributorsAddr, govSaleAddress)
 *      to fund the sale contract with 30M GOV.
 *   2. Copy GOVSale address to oarn-dashboard/lib/constants.ts → CONTRACT_ADDRESSES.GOV_SALE
 */

async function main() {
  const [deployer] = await ethers.getSigners();

  const addresses = JSON.parse(fs.readFileSync("deployment-addresses.json", "utf8"));
  const govTokenAddress = addresses.contracts.GOVToken;
  if (!govTokenAddress) throw new Error("GOVToken address not found in deployment-addresses.json");

  console.log("Deployer:       ", deployer.address);
  console.log("GOV Token:      ", govTokenAddress);

  // 1 ETH = 10,000 GOV  →  price = 10_000 * 1e18
  const price    = ethers.parseEther("10000");
  // 50,000 GOV max per wallet
  const walletCap = ethers.parseEther("50000");

  console.log("\nDeploying GOVSale...");
  console.log("  Price:      10,000 GOV per ETH");
  console.log("  Wallet cap: 50,000 GOV max");

  const GOVSale = await ethers.getContractFactory("GOVSale");
  const govSale = await GOVSale.deploy(govTokenAddress, price, walletCap);
  await govSale.waitForDeployment();
  const govSaleAddress = await govSale.getAddress();

  console.log("\nGOVSale deployed to:", govSaleAddress);

  // Update deployment-addresses.json
  addresses.contracts.GOVSale = govSaleAddress;
  addresses.govSaleDeployedAt = new Date().toISOString();
  fs.writeFileSync("deployment-addresses.json", JSON.stringify(addresses, null, 2));
  console.log("deployment-addresses.json updated.");

  console.log("\n--- NEXT STEPS ---");
  console.log("1. Fund the sale: call GOVToken.executeGenesisDistribution(earlyContributors, govSaleAddress)");
  console.log("   or transfer GOV directly: GOVToken.transfer(govSaleAddress, 30_000_000 * 1e18)");
  console.log("2. Add to dashboard: NEXT_PUBLIC_GOV_SALE_ADDRESS=" + govSaleAddress);
  console.log("   Update oarn-dashboard/lib/constants.ts → CONTRACT_ADDRESSES.GOV_SALE");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
