// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title TaskRegistryV2
 * @notice Task registry with multi-node consensus verification
 * @dev Only rewards nodes that submit the majority consensus result
 *
 * Consensus mechanism:
 * 1. Multiple nodes claim and execute the same task
 * 2. Each node submits a result hash
 * 3. When enough nodes submit, consensus is calculated
 * 4. Only nodes matching the majority result get rewarded
 * 5. Nodes with wrong results can be penalized
 */
contract TaskRegistryV2 is Ownable, ReentrancyGuard, Pausable {

    // ============ Enums ============

    enum TaskStatus {
        Pending,      // Created, waiting for nodes
        Active,       // Being processed
        Consensus,    // Verifying consensus
        Completed,    // Consensus reached, rewards distributed
        Disputed,     // No clear consensus
        Cancelled,
        Expired
    }

    enum ConsensusType {
        Majority,     // >50% must agree
        SuperMajority,// >66% must agree
        Unanimous     // 100% must agree
    }

    // ============ Structs ============

    struct Task {
        uint256 id;
        address requester;
        bytes32 modelHash;
        bytes32 inputHash;
        string modelRequirements;
        uint256 rewardPerNode;
        uint256 requiredNodes;
        uint256 claimedCount;
        uint256 submittedCount;
        uint256 deadline;
        TaskStatus status;
        ConsensusType consensusType;
        uint256 createdAt;
        bytes32 consensusResult;  // The agreed-upon result hash
    }

    struct NodeResult {
        address node;
        bytes32 resultHash;
        uint256 submittedAt;
        bool matchesConsensus;
        bool rewarded;
    }

    struct ConsensusInfo {
        bytes32 winningHash;
        uint256 winningCount;
        uint256 totalSubmissions;
        bool reached;
        uint256 calculatedAt;
    }

    // ============ State Variables ============

    mapping(uint256 => Task) public tasks;
    mapping(uint256 => NodeResult[]) public taskResults;
    mapping(uint256 => mapping(address => bool)) public hasClaimedTask;
    mapping(uint256 => mapping(address => bool)) public hasSubmittedResult;
    mapping(uint256 => ConsensusInfo) public consensusInfo;

    // Track unique result hashes per task
    mapping(uint256 => mapping(bytes32 => uint256)) public resultHashCounts;
    mapping(uint256 => bytes32[]) public uniqueResultHashes;

    uint256 public taskCount;
    uint256 public activeTaskCount;

    address public tokenReward;
    uint256 public minRewardPerNode = 0.001 ether;

    // Consensus thresholds (in basis points, 10000 = 100%)
    uint256 public majorityThreshold = 5001;      // >50%
    uint256 public superMajorityThreshold = 6667; // >66.67%

    // Dispute resolution
    uint256 public disputeWindow = 1 hours;
    mapping(uint256 => uint256) public disputeDeadline;

    // ============ Events ============

    event TaskCreated(
        uint256 indexed taskId,
        address indexed requester,
        bytes32 modelHash,
        uint256 rewardPerNode,
        uint256 requiredNodes,
        ConsensusType consensusType
    );

    event TaskClaimed(uint256 indexed taskId, address indexed node);

    event ResultSubmitted(
        uint256 indexed taskId,
        address indexed node,
        bytes32 resultHash
    );

    event ConsensusReached(
        uint256 indexed taskId,
        bytes32 consensusHash,
        uint256 agreeingNodes,
        uint256 totalNodes
    );

    event ConsensusDisputed(
        uint256 indexed taskId,
        uint256 uniqueResults,
        uint256 highestCount
    );

    event RewardDistributed(
        uint256 indexed taskId,
        address indexed node,
        uint256 amount,
        bool matchedConsensus
    );

    event TaskCompleted(uint256 indexed taskId, uint256 totalRewards);

    // ============ Constructor ============

    constructor(address _tokenReward) Ownable(msg.sender) {
        tokenReward = _tokenReward;
    }

    // ============ Task Submission ============

    /**
     * @notice Submit a task requiring multi-node consensus
     */
    function submitTask(
        bytes32 modelHash,
        bytes32 inputHash,
        string calldata modelRequirements,
        uint256 rewardPerNode,
        uint256 requiredNodes,
        uint256 deadline,
        ConsensusType consensusType
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        require(modelHash != bytes32(0), "Invalid model hash");
        require(requiredNodes >= 3, "Need at least 3 nodes for consensus");
        require(requiredNodes <= 100, "Too many nodes");
        require(deadline > block.timestamp, "Invalid deadline");
        require(rewardPerNode >= minRewardPerNode, "Reward too low");

        uint256 totalReward = rewardPerNode * requiredNodes;
        require(msg.value >= totalReward, "Insufficient payment");

        taskCount++;
        uint256 taskId = taskCount;

        tasks[taskId] = Task({
            id: taskId,
            requester: msg.sender,
            modelHash: modelHash,
            inputHash: inputHash,
            modelRequirements: modelRequirements,
            rewardPerNode: rewardPerNode,
            requiredNodes: requiredNodes,
            claimedCount: 0,
            submittedCount: 0,
            deadline: deadline,
            status: TaskStatus.Pending,
            consensusType: consensusType,
            createdAt: block.timestamp,
            consensusResult: bytes32(0)
        });

        activeTaskCount++;

        // Refund excess
        if (msg.value > totalReward) {
            (bool success, ) = msg.sender.call{value: msg.value - totalReward}("");
            require(success, "Refund failed");
        }

        emit TaskCreated(taskId, msg.sender, modelHash, rewardPerNode, requiredNodes, consensusType);
        return taskId;
    }

    /**
     * @notice Submit task with default majority consensus
     */
    function submitTask(
        bytes32 modelHash,
        bytes32 inputHash,
        string calldata modelRequirements,
        uint256 rewardPerNode,
        uint256 requiredNodes,
        uint256 deadline
    ) external payable returns (uint256) {
        return this.submitTask{value: msg.value}(
            modelHash,
            inputHash,
            modelRequirements,
            rewardPerNode,
            requiredNodes,
            deadline,
            ConsensusType.Majority
        );
    }

    // ============ Task Processing ============

    /**
     * @notice Claim a task to work on
     */
    function claimTask(uint256 taskId) external nonReentrant whenNotPaused {
        Task storage task = tasks[taskId];

        require(task.id != 0, "Task not found");
        require(task.status == TaskStatus.Pending || task.status == TaskStatus.Active, "Task not available");
        require(block.timestamp < task.deadline, "Task expired");
        require(!hasClaimedTask[taskId][msg.sender], "Already claimed");
        require(task.claimedCount < task.requiredNodes * 2, "Max claims reached"); // Allow 2x overclaiming

        hasClaimedTask[taskId][msg.sender] = true;
        task.claimedCount++;

        if (task.status == TaskStatus.Pending) {
            task.status = TaskStatus.Active;
        }

        emit TaskClaimed(taskId, msg.sender);
    }

    /**
     * @notice Submit result for a claimed task
     */
    function submitResult(
        uint256 taskId,
        bytes32 resultHash
    ) external nonReentrant whenNotPaused {
        Task storage task = tasks[taskId];

        require(task.id != 0, "Task not found");
        require(task.status == TaskStatus.Active, "Task not active");
        require(block.timestamp < task.deadline, "Task expired");
        require(hasClaimedTask[taskId][msg.sender], "Not claimed");
        require(!hasSubmittedResult[taskId][msg.sender], "Already submitted");
        require(resultHash != bytes32(0), "Invalid result hash");

        hasSubmittedResult[taskId][msg.sender] = true;
        task.submittedCount++;

        // Track result hash
        if (resultHashCounts[taskId][resultHash] == 0) {
            uniqueResultHashes[taskId].push(resultHash);
        }
        resultHashCounts[taskId][resultHash]++;

        taskResults[taskId].push(NodeResult({
            node: msg.sender,
            resultHash: resultHash,
            submittedAt: block.timestamp,
            matchesConsensus: false,
            rewarded: false
        }));

        emit ResultSubmitted(taskId, msg.sender, resultHash);

        // Check if we have enough submissions for consensus
        if (task.submittedCount >= task.requiredNodes) {
            _calculateConsensus(taskId);
        }
    }

    /**
     * @notice Calculate consensus from submitted results
     */
    function _calculateConsensus(uint256 taskId) internal {
        Task storage task = tasks[taskId];

        // Find the most common result hash
        bytes32 winningHash;
        uint256 winningCount = 0;

        bytes32[] storage hashes = uniqueResultHashes[taskId];
        for (uint256 i = 0; i < hashes.length; i++) {
            uint256 count = resultHashCounts[taskId][hashes[i]];
            if (count > winningCount) {
                winningCount = count;
                winningHash = hashes[i];
            }
        }

        // Calculate threshold based on consensus type
        uint256 threshold;
        if (task.consensusType == ConsensusType.Unanimous) {
            threshold = 10000; // 100%
        } else if (task.consensusType == ConsensusType.SuperMajority) {
            threshold = superMajorityThreshold;
        } else {
            threshold = majorityThreshold;
        }

        uint256 percentage = (winningCount * 10000) / task.submittedCount;

        consensusInfo[taskId] = ConsensusInfo({
            winningHash: winningHash,
            winningCount: winningCount,
            totalSubmissions: task.submittedCount,
            reached: percentage >= threshold,
            calculatedAt: block.timestamp
        });

        if (percentage >= threshold) {
            // Consensus reached
            task.consensusResult = winningHash;
            task.status = TaskStatus.Consensus;

            emit ConsensusReached(taskId, winningHash, winningCount, task.submittedCount);

            // Mark which results match consensus
            _markConsensusResults(taskId, winningHash);

            // Distribute rewards
            _distributeRewards(taskId);
        } else {
            // No clear consensus - enter dispute
            task.status = TaskStatus.Disputed;
            disputeDeadline[taskId] = block.timestamp + disputeWindow;

            emit ConsensusDisputed(taskId, hashes.length, winningCount);
        }
    }

    /**
     * @notice Mark which results match the consensus
     */
    function _markConsensusResults(uint256 taskId, bytes32 consensusHash) internal {
        NodeResult[] storage results = taskResults[taskId];
        for (uint256 i = 0; i < results.length; i++) {
            results[i].matchesConsensus = (results[i].resultHash == consensusHash);
        }
    }

    /**
     * @notice Distribute rewards to nodes that matched consensus
     */
    function _distributeRewards(uint256 taskId) internal {
        Task storage task = tasks[taskId];
        NodeResult[] storage results = taskResults[taskId];

        uint256 totalDistributed = 0;
        uint256 rewardedCount = 0;

        for (uint256 i = 0; i < results.length && rewardedCount < task.requiredNodes; i++) {
            if (results[i].matchesConsensus && !results[i].rewarded) {
                results[i].rewarded = true;
                rewardedCount++;

                (bool success, ) = results[i].node.call{value: task.rewardPerNode}("");
                if (success) {
                    totalDistributed += task.rewardPerNode;
                    emit RewardDistributed(taskId, results[i].node, task.rewardPerNode, true);
                }
            }
        }

        task.status = TaskStatus.Completed;
        activeTaskCount--;

        // Refund unused rewards to requester
        uint256 totalBudget = task.rewardPerNode * task.requiredNodes;
        if (totalDistributed < totalBudget) {
            uint256 refund = totalBudget - totalDistributed;
            (bool success, ) = task.requester.call{value: refund}("");
            // Don't revert if refund fails, just continue
        }

        emit TaskCompleted(taskId, totalDistributed);
    }

    // ============ Dispute Resolution ============

    /**
     * @notice Resolve a disputed task (admin only for now)
     * @param taskId The disputed task
     * @param winningHash The correct result hash (determined off-chain)
     */
    function resolveDispute(
        uint256 taskId,
        bytes32 winningHash
    ) external onlyOwner {
        Task storage task = tasks[taskId];
        require(task.status == TaskStatus.Disputed, "Not disputed");

        task.consensusResult = winningHash;
        task.status = TaskStatus.Consensus;

        _markConsensusResults(taskId, winningHash);
        _distributeRewards(taskId);
    }

    /**
     * @notice Refund a disputed task that couldn't be resolved
     */
    function refundDisputedTask(uint256 taskId) external onlyOwner {
        Task storage task = tasks[taskId];
        require(task.status == TaskStatus.Disputed, "Not disputed");
        require(block.timestamp > disputeDeadline[taskId], "Dispute window not over");

        task.status = TaskStatus.Cancelled;
        activeTaskCount--;

        uint256 refund = task.rewardPerNode * task.requiredNodes;
        (bool success, ) = task.requester.call{value: refund}("");
        require(success, "Refund failed");
    }

    // ============ View Functions ============

    /**
     * @notice Get consensus status for a task
     */
    function getConsensusStatus(uint256 taskId) external view returns (
        bytes32 winningHash,
        uint256 winningCount,
        uint256 totalSubmissions,
        bool reached,
        uint256 uniqueResults
    ) {
        ConsensusInfo storage info = consensusInfo[taskId];
        return (
            info.winningHash,
            info.winningCount,
            info.totalSubmissions,
            info.reached,
            uniqueResultHashes[taskId].length
        );
    }

    /**
     * @notice Get all results for a task
     */
    function getTaskResults(uint256 taskId) external view returns (NodeResult[] memory) {
        return taskResults[taskId];
    }

    /**
     * @notice Check if a node's result matched consensus
     */
    function didNodeMatchConsensus(uint256 taskId, address node) external view returns (bool) {
        NodeResult[] storage results = taskResults[taskId];
        for (uint256 i = 0; i < results.length; i++) {
            if (results[i].node == node) {
                return results[i].matchesConsensus;
            }
        }
        return false;
    }

    // ============ Admin Functions ============

    function setMinRewardPerNode(uint256 _minReward) external onlyOwner {
        minRewardPerNode = _minReward;
    }

    function setMajorityThreshold(uint256 _threshold) external onlyOwner {
        require(_threshold > 5000 && _threshold <= 10000, "Invalid threshold");
        majorityThreshold = _threshold;
    }

    function setSuperMajorityThreshold(uint256 _threshold) external onlyOwner {
        require(_threshold > majorityThreshold && _threshold <= 10000, "Invalid threshold");
        superMajorityThreshold = _threshold;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    receive() external payable {}
}
