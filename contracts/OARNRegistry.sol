// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title OARNRegistry
 * @notice Decentralized registry for OARN network infrastructure discovery
 * @dev This contract is NON-UPGRADEABLE by design - core addresses are immutable
 *
 * Clients discover all OARN infrastructure through this single entry point:
 * 1. Query ENS (oarn-registry.eth) to find this contract
 * 2. Get core contract addresses (TaskRegistry, TokenReward, etc.)
 * 3. Get list of active RPC providers and bootstrap nodes
 *
 * NO HARDCODED VALUES IN CLIENTS - everything discovered via this registry
 */
contract OARNRegistry is Ownable, ReentrancyGuard {

    // ============ Structs ============

    struct RPCProvider {
        string endpoint;          // HTTPS RPC URL
        string onionEndpoint;     // .onion URL for Tor access
        address owner;
        uint256 stake;
        uint256 registeredAt;
        uint256 lastHeartbeat;
        uint256 uptime;           // Percentage * 100 (e.g., 9950 = 99.50%)
        uint256 reportCount;      // Bad behavior reports
        bool isActive;
    }

    struct BootstrapNode {
        string peerId;            // libp2p peer ID
        string multiaddr;         // Primary multiaddress
        string onionAddress;      // .onion address for Tor
        string i2pAddress;        // .i2p address (optional)
        address owner;
        uint256 stake;
        uint256 registeredAt;
        uint256 lastHeartbeat;
        bool isActive;
    }

    // ============ Immutable Core Addresses ============
    // Set once at deployment, never changed

    address public immutable taskRegistry;
    address public immutable tokenReward;
    address public immutable validatorRegistry;
    address public immutable governance;
    address public immutable govToken;

    // ============ Upgradeable Contract Addresses ============
    // Can be updated by owner for contract upgrades

    address public taskRegistryV2;  // Multi-node consensus version

    // ============ State Variables ============

    // RPC Providers
    mapping(uint256 => RPCProvider) public rpcProviders;
    mapping(address => uint256) public rpcProviderIds;
    uint256 public rpcProviderCount;
    uint256 public activeRpcCount;

    // Bootstrap Nodes
    mapping(uint256 => BootstrapNode) public bootstrapNodes;
    mapping(address => uint256) public bootstrapNodeIds;
    uint256 public bootstrapNodeCount;
    uint256 public activeBootstrapCount;

    // Staking requirements
    uint256 public constant RPC_MIN_STAKE = 5000 ether;      // 5000 GOV tokens
    uint256 public constant BOOTSTRAP_MIN_STAKE = 1000 ether; // 1000 GOV tokens
    uint256 public constant UNSTAKE_COOLDOWN = 7 days;

    // Pending unstakes
    mapping(address => uint256) public pendingUnstakeTime;
    mapping(address => uint256) public pendingUnstakeAmount;

    // ============ Events ============

    event RPCProviderRegistered(uint256 indexed id, address indexed owner, string endpoint);
    event RPCProviderUpdated(uint256 indexed id, string endpoint, string onionEndpoint);
    event RPCProviderDeactivated(uint256 indexed id, address indexed owner);
    event RPCProviderSlashed(uint256 indexed id, uint256 amount, string reason);

    event BootstrapNodeRegistered(uint256 indexed id, address indexed owner, string peerId);
    event BootstrapNodeUpdated(uint256 indexed id, string peerId, string multiaddr);
    event BootstrapNodeDeactivated(uint256 indexed id, address indexed owner);
    event BootstrapNodeSlashed(uint256 indexed id, uint256 amount, string reason);

    event UnstakeInitiated(address indexed owner, uint256 amount, uint256 availableAt);
    event UnstakeCompleted(address indexed owner, uint256 amount);

    event Heartbeat(address indexed provider, uint256 timestamp);

    event TaskRegistryV2Updated(address indexed oldAddress, address indexed newAddress);

    // ============ Constructor ============

    constructor(
        address _taskRegistry,
        address _tokenReward,
        address _validatorRegistry,
        address _governance,
        address _govToken
    ) Ownable(msg.sender) {
        require(_taskRegistry != address(0), "Invalid TaskRegistry");
        require(_tokenReward != address(0), "Invalid TokenReward");
        require(_validatorRegistry != address(0), "Invalid ValidatorRegistry");
        require(_governance != address(0), "Invalid Governance");
        require(_govToken != address(0), "Invalid GOVToken");

        taskRegistry = _taskRegistry;
        tokenReward = _tokenReward;
        validatorRegistry = _validatorRegistry;
        governance = _governance;
        govToken = _govToken;
    }

    // ============ RPC Provider Functions ============

    /**
     * @notice Register as an RPC provider with stake
     * @param endpoint HTTPS RPC endpoint URL
     * @param onionEndpoint Tor .onion endpoint URL
     */
    function registerRPCProvider(
        string calldata endpoint,
        string calldata onionEndpoint
    ) external payable nonReentrant {
        require(msg.value >= RPC_MIN_STAKE, "Insufficient stake");
        require(bytes(endpoint).length > 0, "Empty endpoint");
        require(rpcProviderIds[msg.sender] == 0, "Already registered");

        rpcProviderCount++;
        uint256 id = rpcProviderCount;

        rpcProviders[id] = RPCProvider({
            endpoint: endpoint,
            onionEndpoint: onionEndpoint,
            owner: msg.sender,
            stake: msg.value,
            registeredAt: block.timestamp,
            lastHeartbeat: block.timestamp,
            uptime: 10000, // Start at 100%
            reportCount: 0,
            isActive: true
        });

        rpcProviderIds[msg.sender] = id;
        activeRpcCount++;

        emit RPCProviderRegistered(id, msg.sender, endpoint);
    }

    /**
     * @notice Update RPC provider endpoints
     */
    function updateRPCProvider(
        string calldata endpoint,
        string calldata onionEndpoint
    ) external {
        uint256 id = rpcProviderIds[msg.sender];
        require(id != 0, "Not registered");
        require(rpcProviders[id].isActive, "Provider inactive");

        rpcProviders[id].endpoint = endpoint;
        rpcProviders[id].onionEndpoint = onionEndpoint;

        emit RPCProviderUpdated(id, endpoint, onionEndpoint);
    }

    /**
     * @notice Send heartbeat to prove liveness
     */
    function heartbeat() external {
        uint256 rpcId = rpcProviderIds[msg.sender];
        uint256 bootstrapId = bootstrapNodeIds[msg.sender];

        if (rpcId != 0 && rpcProviders[rpcId].isActive) {
            rpcProviders[rpcId].lastHeartbeat = block.timestamp;
        }

        if (bootstrapId != 0 && bootstrapNodes[bootstrapId].isActive) {
            bootstrapNodes[bootstrapId].lastHeartbeat = block.timestamp;
        }

        emit Heartbeat(msg.sender, block.timestamp);
    }

    /**
     * @notice Get all active RPC providers
     */
    function getActiveRPCProviders() external view returns (RPCProvider[] memory) {
        RPCProvider[] memory active = new RPCProvider[](activeRpcCount);
        uint256 index = 0;

        for (uint256 i = 1; i <= rpcProviderCount; i++) {
            if (rpcProviders[i].isActive) {
                active[index] = rpcProviders[i];
                index++;
            }
        }

        return active;
    }

    /**
     * @notice Get N random active RPC providers using block hash as randomness
     * @dev Not cryptographically secure - adequate for load balancing
     */
    function getRandomRPCProviders(uint256 count) external view returns (RPCProvider[] memory) {
        require(count <= activeRpcCount, "Not enough providers");

        RPCProvider[] memory result = new RPCProvider[](count);
        uint256[] memory indices = new uint256[](activeRpcCount);
        uint256 activeIndex = 0;

        // Collect active provider IDs
        for (uint256 i = 1; i <= rpcProviderCount; i++) {
            if (rpcProviders[i].isActive) {
                indices[activeIndex] = i;
                activeIndex++;
            }
        }

        // Fisher-Yates shuffle using block hash
        bytes32 seed = blockhash(block.number - 1);
        for (uint256 i = 0; i < count; i++) {
            uint256 remaining = activeRpcCount - i;
            uint256 randomIndex = uint256(keccak256(abi.encodePacked(seed, i))) % remaining;

            result[i] = rpcProviders[indices[randomIndex]];

            // Swap with last element
            indices[randomIndex] = indices[remaining - 1];
        }

        return result;
    }

    // ============ Bootstrap Node Functions ============

    /**
     * @notice Register as a bootstrap node with stake
     */
    function registerBootstrapNode(
        string calldata peerId,
        string calldata multiaddr,
        string calldata onionAddress,
        string calldata i2pAddress
    ) external payable nonReentrant {
        require(msg.value >= BOOTSTRAP_MIN_STAKE, "Insufficient stake");
        require(bytes(peerId).length > 0, "Empty peer ID");
        require(bootstrapNodeIds[msg.sender] == 0, "Already registered");

        bootstrapNodeCount++;
        uint256 id = bootstrapNodeCount;

        bootstrapNodes[id] = BootstrapNode({
            peerId: peerId,
            multiaddr: multiaddr,
            onionAddress: onionAddress,
            i2pAddress: i2pAddress,
            owner: msg.sender,
            stake: msg.value,
            registeredAt: block.timestamp,
            lastHeartbeat: block.timestamp,
            isActive: true
        });

        bootstrapNodeIds[msg.sender] = id;
        activeBootstrapCount++;

        emit BootstrapNodeRegistered(id, msg.sender, peerId);
    }

    /**
     * @notice Update bootstrap node information
     */
    function updateBootstrapNode(
        string calldata peerId,
        string calldata multiaddr,
        string calldata onionAddress,
        string calldata i2pAddress
    ) external {
        uint256 id = bootstrapNodeIds[msg.sender];
        require(id != 0, "Not registered");
        require(bootstrapNodes[id].isActive, "Node inactive");

        bootstrapNodes[id].peerId = peerId;
        bootstrapNodes[id].multiaddr = multiaddr;
        bootstrapNodes[id].onionAddress = onionAddress;
        bootstrapNodes[id].i2pAddress = i2pAddress;

        emit BootstrapNodeUpdated(id, peerId, multiaddr);
    }

    /**
     * @notice Get all active bootstrap nodes
     */
    function getActiveBootstrapNodes() external view returns (BootstrapNode[] memory) {
        BootstrapNode[] memory active = new BootstrapNode[](activeBootstrapCount);
        uint256 index = 0;

        for (uint256 i = 1; i <= bootstrapNodeCount; i++) {
            if (bootstrapNodes[i].isActive) {
                active[index] = bootstrapNodes[i];
                index++;
            }
        }

        return active;
    }

    /**
     * @notice Get N random active bootstrap nodes
     */
    function getRandomBootstrapNodes(uint256 count) external view returns (BootstrapNode[] memory) {
        require(count <= activeBootstrapCount, "Not enough nodes");

        BootstrapNode[] memory result = new BootstrapNode[](count);
        uint256[] memory indices = new uint256[](activeBootstrapCount);
        uint256 activeIndex = 0;

        for (uint256 i = 1; i <= bootstrapNodeCount; i++) {
            if (bootstrapNodes[i].isActive) {
                indices[activeIndex] = i;
                activeIndex++;
            }
        }

        bytes32 seed = blockhash(block.number - 1);
        for (uint256 i = 0; i < count; i++) {
            uint256 remaining = activeBootstrapCount - i;
            uint256 randomIndex = uint256(keccak256(abi.encodePacked(seed, i))) % remaining;

            result[i] = bootstrapNodes[indices[randomIndex]];
            indices[randomIndex] = indices[remaining - 1];
        }

        return result;
    }

    // ============ Unstaking Functions ============

    /**
     * @notice Initiate unstake process (7 day cooldown)
     */
    function initiateUnstake() external nonReentrant {
        uint256 rpcId = rpcProviderIds[msg.sender];
        uint256 bootstrapId = bootstrapNodeIds[msg.sender];

        uint256 totalStake = 0;

        if (rpcId != 0 && rpcProviders[rpcId].isActive) {
            totalStake += rpcProviders[rpcId].stake;
            rpcProviders[rpcId].isActive = false;
            activeRpcCount--;
            emit RPCProviderDeactivated(rpcId, msg.sender);
        }

        if (bootstrapId != 0 && bootstrapNodes[bootstrapId].isActive) {
            totalStake += bootstrapNodes[bootstrapId].stake;
            bootstrapNodes[bootstrapId].isActive = false;
            activeBootstrapCount--;
            emit BootstrapNodeDeactivated(bootstrapId, msg.sender);
        }

        require(totalStake > 0, "No active stake");

        pendingUnstakeTime[msg.sender] = block.timestamp + UNSTAKE_COOLDOWN;
        pendingUnstakeAmount[msg.sender] = totalStake;

        emit UnstakeInitiated(msg.sender, totalStake, pendingUnstakeTime[msg.sender]);
    }

    /**
     * @notice Complete unstake after cooldown period
     */
    function completeUnstake() external nonReentrant {
        require(pendingUnstakeAmount[msg.sender] > 0, "No pending unstake");
        require(block.timestamp >= pendingUnstakeTime[msg.sender], "Cooldown not complete");

        uint256 amount = pendingUnstakeAmount[msg.sender];
        pendingUnstakeAmount[msg.sender] = 0;
        pendingUnstakeTime[msg.sender] = 0;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        emit UnstakeCompleted(msg.sender, amount);
    }

    // ============ Admin Functions ============

    /**
     * @notice Add an RPC provider without stake (owner only, for bootstrapping)
     * @dev Used for adding public RPC endpoints that don't need stake
     */
    function addRPCProviderAdmin(
        string calldata endpoint,
        string calldata onionEndpoint,
        address providerOwner
    ) external onlyOwner {
        require(bytes(endpoint).length > 0, "Empty endpoint");
        require(providerOwner != address(0), "Invalid owner");
        require(rpcProviderIds[providerOwner] == 0, "Already registered");

        rpcProviderCount++;
        uint256 id = rpcProviderCount;

        rpcProviders[id] = RPCProvider({
            endpoint: endpoint,
            onionEndpoint: onionEndpoint,
            owner: providerOwner,
            stake: 0,  // No stake required for admin-added providers
            registeredAt: block.timestamp,
            lastHeartbeat: block.timestamp,
            uptime: 10000,
            reportCount: 0,
            isActive: true
        });

        rpcProviderIds[providerOwner] = id;
        activeRpcCount++;

        emit RPCProviderRegistered(id, providerOwner, endpoint);
    }

    /**
     * @notice Add a bootstrap node without stake (owner only, for bootstrapping)
     */
    function addBootstrapNodeAdmin(
        string calldata peerId,
        string calldata multiaddr,
        string calldata onionAddress,
        string calldata i2pAddress,
        address nodeOwner
    ) external onlyOwner {
        require(bytes(peerId).length > 0, "Empty peer ID");
        require(nodeOwner != address(0), "Invalid owner");
        require(bootstrapNodeIds[nodeOwner] == 0, "Already registered");

        bootstrapNodeCount++;
        uint256 id = bootstrapNodeCount;

        bootstrapNodes[id] = BootstrapNode({
            peerId: peerId,
            multiaddr: multiaddr,
            onionAddress: onionAddress,
            i2pAddress: i2pAddress,
            owner: nodeOwner,
            stake: 0,  // No stake required for admin-added nodes
            registeredAt: block.timestamp,
            lastHeartbeat: block.timestamp,
            isActive: true
        });

        bootstrapNodeIds[nodeOwner] = id;
        activeBootstrapCount++;

        emit BootstrapNodeRegistered(id, nodeOwner, peerId);
    }

    /**
     * @notice Slash a misbehaving RPC provider (governance only)
     */
    function slashRPCProvider(uint256 id, uint256 amount, string calldata reason) external onlyOwner {
        require(rpcProviders[id].stake >= amount, "Insufficient stake to slash");

        rpcProviders[id].stake -= amount;
        rpcProviders[id].reportCount++;

        // If stake falls below minimum, deactivate
        if (rpcProviders[id].stake < RPC_MIN_STAKE) {
            rpcProviders[id].isActive = false;
            activeRpcCount--;
        }

        emit RPCProviderSlashed(id, amount, reason);
    }

    /**
     * @notice Slash a misbehaving bootstrap node (governance only)
     */
    function slashBootstrapNode(uint256 id, uint256 amount, string calldata reason) external onlyOwner {
        require(bootstrapNodes[id].stake >= amount, "Insufficient stake to slash");

        bootstrapNodes[id].stake -= amount;

        if (bootstrapNodes[id].stake < BOOTSTRAP_MIN_STAKE) {
            bootstrapNodes[id].isActive = false;
            activeBootstrapCount--;
        }

        emit BootstrapNodeSlashed(id, amount, reason);
    }

    /**
     * @notice Update TaskRegistryV2 address (for contract upgrades)
     * @param _taskRegistryV2 New TaskRegistryV2 contract address
     */
    function setTaskRegistryV2(address _taskRegistryV2) external onlyOwner {
        require(_taskRegistryV2 != address(0), "Invalid TaskRegistryV2 address");
        address oldAddress = taskRegistryV2;
        taskRegistryV2 = _taskRegistryV2;
        emit TaskRegistryV2Updated(oldAddress, _taskRegistryV2);
    }

    // ============ View Functions ============

    /**
     * @notice Get all core contract addresses in one call
     */
    function getCoreContracts() external view returns (
        address _taskRegistry,
        address _tokenReward,
        address _validatorRegistry,
        address _governance,
        address _govToken
    ) {
        return (taskRegistry, tokenReward, validatorRegistry, governance, govToken);
    }

    /**
     * @notice Get all core contract addresses including V2 contracts
     */
    function getCoreContractsV2() external view returns (
        address _taskRegistry,
        address _taskRegistryV2,
        address _tokenReward,
        address _validatorRegistry,
        address _governance,
        address _govToken
    ) {
        return (taskRegistry, taskRegistryV2, tokenReward, validatorRegistry, governance, govToken);
    }

    /**
     * @notice Check if an address is an active provider/node
     */
    function isActiveProvider(address addr) external view returns (bool isRpc, bool isBootstrap) {
        uint256 rpcId = rpcProviderIds[addr];
        uint256 bootstrapId = bootstrapNodeIds[addr];

        isRpc = rpcId != 0 && rpcProviders[rpcId].isActive;
        isBootstrap = bootstrapId != 0 && bootstrapNodes[bootstrapId].isActive;
    }
}
