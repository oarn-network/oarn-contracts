const { ethers } = require("ethers");
require("dotenv").config();

// Contract addresses from deployment
const CONTRACTS = {
  COMPToken: "0x24249A523A251E38CB0001daBd54DD44Ea8f1838",
  GOVToken: "0xB97eDD49C225d2c43e7203aB9248cAbED2B268d3",
  TaskRegistry: "0x4Dc9dD73834E94545cF041091e1A743FBD09a60f",
  OARNRegistry: "0xa122518Cb6E66A804fc37EB26c8a7aF309dCF04C"
};

// Minimal ABIs for testing
const COMP_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function minters(address) view returns (bool)"
];

const GOV_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mintingComplete() view returns (bool)",
  "function TOTAL_SUPPLY() view returns (uint256)"
];

const TASK_ABI = [
  "function taskCount() view returns (uint256)",
  "function tokenReward() view returns (address)",
  "function minRewardPerNode() view returns (uint256)",
  "function setMinRewardPerNode(uint256 _minReward) external",
  "function submitTask(bytes32 modelHash, bytes32 inputHash, string modelRequirements, uint256 rewardPerNode, uint256 requiredNodes, uint256 deadline) payable returns (uint256)",
  "function getTask(uint256) view returns (tuple(uint256 id, address submitter, bytes32 modelHash, bytes32 inputHash, string requirements, uint256 rewardPerNode, uint256 requiredNodes, uint256 deadline, uint8 status, uint8 mode, uint256 createdAt, uint256 completedCount))",
  "event TaskSubmitted(uint256 indexed taskId, address indexed submitter, bytes32 modelHash, uint256 totalReward)"
];

const REGISTRY_ABI = [
  "function taskRegistry() view returns (address)",
  "function tokenReward() view returns (address)",
  "function govToken() view returns (address)",
  "function rpcProviderCount() view returns (uint256)",
  "function bootstrapNodeCount() view returns (uint256)",
  "function activeRpcCount() view returns (uint256)",
  "function activeBootstrapCount() view returns (uint256)",
  "function getCoreContracts() view returns (address,address,address,address,address)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider("https://sepolia-rollup.arbitrum.io/rpc");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log("=".repeat(60));
  console.log("OARN Contract Testing - Arbitrum Sepolia");
  console.log("=".repeat(60));
  console.log("\nWallet:", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH\n");

  // Test COMP Token
  console.log("-".repeat(40));
  console.log("1. COMP Token");
  console.log("-".repeat(40));
  const comp = new ethers.Contract(CONTRACTS.COMPToken, COMP_ABI, provider);
  console.log("   Name:", await comp.name());
  console.log("   Symbol:", await comp.symbol());
  console.log("   Total Supply:", ethers.formatEther(await comp.totalSupply()), "COMP");
  console.log("   TaskRegistry is minter:", await comp.minters(CONTRACTS.TaskRegistry));

  // Test GOV Token
  console.log("\n" + "-".repeat(40));
  console.log("2. GOV Token");
  console.log("-".repeat(40));
  const gov = new ethers.Contract(CONTRACTS.GOVToken, GOV_ABI, provider);
  console.log("   Name:", await gov.name());
  console.log("   Symbol:", await gov.symbol());
  console.log("   Max Supply:", ethers.formatEther(await gov.TOTAL_SUPPLY()), "GOV");
  console.log("   Current Supply:", ethers.formatEther(await gov.totalSupply()), "GOV");
  console.log("   Genesis Complete:", await gov.mintingComplete());

  // Test OARNRegistry
  console.log("\n" + "-".repeat(40));
  console.log("3. OARNRegistry");
  console.log("-".repeat(40));
  const registry = new ethers.Contract(CONTRACTS.OARNRegistry, REGISTRY_ABI, provider);
  console.log("   TaskRegistry:", await registry.taskRegistry());
  console.log("   TokenReward:", await registry.tokenReward());
  console.log("   GOV Token:", await registry.govToken());
  console.log("   RPC Providers:", (await registry.rpcProviderCount()).toString());
  console.log("   Bootstrap Nodes:", (await registry.bootstrapNodeCount()).toString());
  console.log("   Active RPCs:", (await registry.activeRpcCount()).toString());
  console.log("   Active Bootstraps:", (await registry.activeBootstrapCount()).toString());

  // Test TaskRegistry
  console.log("\n" + "-".repeat(40));
  console.log("4. TaskRegistry");
  console.log("-".repeat(40));
  const tasks = new ethers.Contract(CONTRACTS.TaskRegistry, TASK_ABI, wallet);
  console.log("   Token Reward:", await tasks.tokenReward());
  console.log("   Task Count:", (await tasks.taskCount()).toString());
  const currentMinReward = await tasks.minRewardPerNode();
  console.log("   Min Reward/Node:", ethers.formatEther(currentMinReward), "ETH");

  // Lower minimum reward for testing (owner only)
  console.log("\n" + "-".repeat(40));
  console.log("5. Setting Min Reward for Testing");
  console.log("-".repeat(40));

  try {
    const newMinReward = ethers.parseEther("0.001");
    console.log("   Lowering min reward to 0.001 ETH...");
    const setTx = await tasks.setMinRewardPerNode(newMinReward);
    await setTx.wait();
    console.log("   Min reward updated!");
  } catch (e) {
    console.log("   Skipping (not owner or already set):", e.reason || e.message.slice(0, 50));
  }

  // Submit a test task
  console.log("\n" + "-".repeat(40));
  console.log("6. Submitting Test Task");
  console.log("-".repeat(40));

  try {
    // Create model and input hashes (keccak256 of CIDs)
    const modelCid = "QmTestModel123456789";
    const inputCid = "QmTestInput123456789";
    const modelHash = ethers.keccak256(ethers.toUtf8Bytes(modelCid));
    const inputHash = ethers.keccak256(ethers.toUtf8Bytes(inputCid));
    const requirements = JSON.stringify({
      framework: "onnx",
      min_ram: "4GB"
    });
    const rewardPerNode = ethers.parseEther("0.001"); // 0.001 ETH per node
    const requiredNodes = 1; // 1 node required
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

    console.log("   Model CID:", modelCid);
    console.log("   Model Hash:", modelHash);
    console.log("   Input CID:", inputCid);
    console.log("   Input Hash:", inputHash);
    console.log("   Requirements:", requirements);
    console.log("   Reward per Node: 0.001 ETH");
    console.log("   Required Nodes:", requiredNodes);
    console.log("   Deadline:", new Date(deadline * 1000).toISOString());
    console.log("\n   Sending transaction...");

    const tx = await tasks.submitTask(
      modelHash,
      inputHash,
      requirements,
      rewardPerNode,
      requiredNodes,
      deadline,
      { value: ethers.parseEther("0.001") }
    );

    console.log("   TX Hash:", tx.hash);
    console.log("   Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log("   Confirmed in block:", receipt.blockNumber);
    console.log("   Gas used:", receipt.gasUsed.toString());

    // Get task count after
    const newCount = await tasks.taskCount();
    console.log("\n   New Task Count:", newCount.toString());
    console.log("   Task ID:", newCount.toString());

    // Get task details
    const taskData = await tasks.getTask(newCount);
    console.log("\n   Task Details:");
    console.log("   - ID:", taskData[0].toString());
    console.log("   - Submitter:", taskData[1]);
    console.log("   - Model Hash:", taskData[2]);
    console.log("   - Input Hash:", taskData[3]);
    console.log("   - Requirements:", taskData[4]);
    console.log("   - Status:", taskData[8] === 0n ? "Pending" : taskData[8] === 1n ? "Active" : "Completed");

    console.log("\n   TEST TASK SUBMITTED SUCCESSFULLY!");

  } catch (e) {
    console.log("   Error:", e.message);
    if (e.message.includes("insufficient funds")) {
      console.log("   Need more ETH for gas + reward");
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Testing Complete!");
  console.log("=".repeat(60));
}

main().catch(console.error);
