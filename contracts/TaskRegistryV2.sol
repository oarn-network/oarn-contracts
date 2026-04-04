// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

// ============ Interface ============

interface INodeReputation {
    /// @notice Returns a node's score (0–100) and tier ("New"/"Bronze"/…/"Platinum").
    function getScore(address node) external view returns (uint256 score, string memory tier);
    /// @notice Record a task result for a node (called after consensus).
    function recordResult(address node, bool matchedConsensus, uint256 earnedWei) external;
    /// @notice Increment a node's tasksClaimed counter (called on claimTask).
    function recordClaim(address node) external;
}

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

    enum TaskMode {
        OneShot,
        Continuous
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

    struct ContinuousInfo {
        uint256 maxRounds;
        uint256 roundsTriggered;  // rounds started (1 on creation, increments on each triggerNextRound)
        uint256 maxSpendWei;      // total ETH cap across all rounds
        uint256 totalSpent;       // ETH committed so far
        bool active;
        uint256[] roundTaskIds;   // task IDs for each round in order
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

    mapping(uint256 => TaskMode) public taskMode;
    mapping(uint256 => ContinuousInfo) private _continuousInfo;
    mapping(uint256 => uint256) public continuousParent; // child taskId => parent taskId

    uint256 public taskCount;
    uint256 public activeTaskCount;

    address public immutable tokenReward;
    uint256 public minRewardPerNode = 0.001 ether;

    // #140/#141 — On-chain reputation and COMP multiplier pool
    address public reputationRegistry;
    /// ETH pool funded by the owner; used to pay the 1.2× multiplier bonus to high-rep nodes.
    uint256 public multiplierPool;

    // Consensus thresholds (in basis points, 10000 = 100%)
    uint256 public majorityThreshold = 5001;      // >50%
    uint256 public superMajorityThreshold = 6667; // >66.67%

    // Dispute resolution
    uint256 public constant DISPUTE_WINDOW = 1 hours;
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

    /// #141 — Emitted when a high-reputation node receives a multiplier bonus.
    event MultiplierBonusPaid(uint256 indexed taskId, address indexed node, uint256 bonus);

    event TaskFunded(
        uint256 indexed taskId,
        address indexed funder,
        uint256 fundingAmount,
        uint256 newRewardPerNode
    );

    event ContinuousTaskTriggered(
        uint256 indexed parentTaskId,
        uint256 indexed newTaskId,
        uint256 round
    );

    // ============ Constructor ============

    constructor(address _tokenReward) Ownable(msg.sender) {
        require(_tokenReward != address(0), "Invalid token reward address");
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

    /**
     * @notice Fund an existing task with additional ETH to increase rewards
     * @param taskId The task ID to fund
     */
    function fundTask(uint256 taskId) external payable nonReentrant whenNotPaused {
        Task storage task = tasks[taskId];

        require(task.id != 0, "Task not found");
        require(task.status == TaskStatus.Pending || task.status == TaskStatus.Active,
                "Task not fundable");
        require(msg.value > 0, "Must send ETH");
        require(block.timestamp < task.deadline, "Task expired");

        // Calculate new reward per node
        uint256 currentPool = task.rewardPerNode * task.requiredNodes;
        uint256 newPool = currentPool + msg.value;
        uint256 newRewardPerNode = newPool / task.requiredNodes;

        // Update task reward
        task.rewardPerNode = newRewardPerNode;

        emit TaskFunded(taskId, msg.sender, msg.value, newRewardPerNode);
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

        // #140: record the claim in the reputation registry (non-critical — ignore failures)
        if (reputationRegistry != address(0)) {
            try INodeReputation(reputationRegistry).recordClaim(msg.sender) {} catch {}
        }
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
            disputeDeadline[taskId] = block.timestamp + DISPUTE_WINDOW;

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
     * @notice Distribute rewards to nodes that matched consensus.
     * @dev Uses checks-effects-interactions pattern to prevent reentrancy.
     *      #140: Records each result in the reputation registry (if set).
     *      #141: Applies a 1.2× ETH bonus to nodes with ≥95 reputation score,
     *            funded from multiplierPool (set by fundMultiplierPool()).
     */
    function _distributeRewards(uint256 taskId) internal {
        Task storage task = tasks[taskId];
        NodeResult[] storage results = taskResults[taskId];

        // EFFECTS: Update state BEFORE external calls (reentrancy protection)
        task.status = TaskStatus.Completed;
        activeTaskCount--;

        uint256 rewardPerNode = task.rewardPerNode;
        uint256 requiredNodes = task.requiredNodes;
        address requester = task.requester;

        // Mark nodes as rewarded BEFORE transfers
        address[] memory nodesToReward = new address[](requiredNodes);
        uint256 nodeCount = 0;
        uint256 rewardedCount = 0;

        for (uint256 i = 0; i < results.length && rewardedCount < requiredNodes; i++) {
            if (results[i].matchesConsensus && !results[i].rewarded) {
                results[i].rewarded = true;
                nodesToReward[nodeCount] = results[i].node;
                nodeCount++;
                rewardedCount++;
            }
        }

        // #141 EFFECTS: Pre-calculate and reserve multiplier bonuses before external calls.
        // getScore() is a view call on a trusted contract — using try/catch for safety.
        uint256[] memory bonuses = new uint256[](nodeCount);
        if (reputationRegistry != address(0)) {
            for (uint256 i = 0; i < nodeCount; i++) {
                try INodeReputation(reputationRegistry).getScore(nodesToReward[i])
                    returns (uint256 score, string memory)
                {
                    if (score >= 95 && multiplierPool > 0) {
                        uint256 b = rewardPerNode * 2 / 10; // 20% bonus = 1.2× total
                        if (b > multiplierPool) b = multiplierPool;
                        bonuses[i] = b;
                        multiplierPool -= b; // deduct in effects phase
                    }
                } catch {}
            }
        }

        // INTERACTIONS: External calls AFTER all state changes
        uint256 baseDistributed = 0;
        for (uint256 i = 0; i < nodeCount; i++) {
            address node = nodesToReward[i];
            uint256 payout = rewardPerNode + bonuses[i];
            (bool success, ) = node.call{value: payout}("");
            if (success) {
                baseDistributed += rewardPerNode;
                emit RewardDistributed(taskId, node, payout, true);
                if (bonuses[i] > 0) {
                    emit MultiplierBonusPaid(taskId, node, bonuses[i]);
                }
            } else if (bonuses[i] > 0) {
                // Return unspent bonus to pool if the send failed
                multiplierPool += bonuses[i];
            }

            // #140: record matching result in reputation registry (non-critical)
            if (reputationRegistry != address(0)) {
                try INodeReputation(reputationRegistry).recordResult(
                    node, true, success ? payout : 0
                ) {} catch {}
            }
        }

        // #140: record non-matching submissions so submissionRate stays accurate
        if (reputationRegistry != address(0)) {
            for (uint256 i = 0; i < results.length; i++) {
                if (!results[i].matchesConsensus) {
                    try INodeReputation(reputationRegistry).recordResult(
                        results[i].node, false, 0
                    ) {} catch {}
                }
            }
        }

        // Refund unused base budget to requester
        uint256 totalBudget = rewardPerNode * requiredNodes;
        if (baseDistributed < totalBudget) {
            uint256 refund = totalBudget - baseDistributed;
            (bool success, ) = requester.call{value: refund}("");
            // Non-critical: don't revert if refund fails
        }

        emit TaskCompleted(taskId, baseDistributed);
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

    // ============ Continuous Task Mode ============

    /**
     * @notice Submit a recurring task that can be re-triggered each round.
     * @param maxRounds  Maximum number of rounds allowed (2–100).
     * @param maxSpendWei Hard cap on total ETH spent across all rounds.
     * @dev   Only the first round's ETH is taken here; each subsequent round is
     *        funded individually via triggerNextRound().
     */
    function submitTaskContinuous(
        bytes32 modelHash,
        bytes32 inputHash,
        string calldata modelRequirements,
        uint256 rewardPerNode,
        uint256 requiredNodes,
        uint256 deadline,
        ConsensusType consensusType,
        uint256 maxRounds,
        uint256 maxSpendWei
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        require(maxRounds >= 2 && maxRounds <= 100, "maxRounds: 2-100");
        require(modelHash != bytes32(0), "Invalid model hash");
        require(requiredNodes >= 3, "Need at least 3 nodes for consensus");
        require(requiredNodes <= 100, "Too many nodes");
        require(deadline > block.timestamp, "Invalid deadline");
        require(rewardPerNode >= minRewardPerNode, "Reward too low");

        uint256 roundCost = rewardPerNode * requiredNodes;
        require(maxSpendWei >= roundCost, "maxSpendWei < single round cost");
        require(msg.value >= roundCost, "Insufficient payment");

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

        if (msg.value > roundCost) {
            (bool success, ) = msg.sender.call{value: msg.value - roundCost}("");
            require(success, "Refund failed");
        }

        emit TaskCreated(taskId, msg.sender, modelHash, rewardPerNode, requiredNodes, consensusType);

        taskMode[taskId] = TaskMode.Continuous;
        _continuousInfo[taskId].maxRounds = maxRounds;
        _continuousInfo[taskId].maxSpendWei = maxSpendWei;
        _continuousInfo[taskId].active = true;
        _continuousInfo[taskId].roundsTriggered = 1;
        _continuousInfo[taskId].totalSpent = roundCost;
        _continuousInfo[taskId].roundTaskIds.push(taskId);

        return taskId;
    }

    /**
     * @notice Start the next round of a continuous task.
     * @param parentTaskId The task ID returned by submitTaskContinuous.
     * @dev   Caller must send exactly rewardPerNode * requiredNodes ETH.
     *        The previous round must be Completed before this can be called.
     */
    function triggerNextRound(uint256 parentTaskId)
        external payable nonReentrant whenNotPaused returns (uint256)
    {
        ContinuousInfo storage info = _continuousInfo[parentTaskId];
        require(info.active, "Not a continuous task or stopped");
        require(info.roundsTriggered < info.maxRounds, "Max rounds reached");

        uint256 lastTaskId = info.roundTaskIds[info.roundTaskIds.length - 1];
        Task storage lastTask = tasks[lastTaskId];
        require(lastTask.status == TaskStatus.Completed, "Previous round not complete");
        require(lastTask.requester == msg.sender, "Only requester can trigger next round");

        uint256 roundCost = lastTask.rewardPerNode * lastTask.requiredNodes;
        require(info.totalSpent + roundCost <= info.maxSpendWei, "Would exceed maxSpendWei");
        require(msg.value >= roundCost, "Insufficient payment");

        // Duration of previous round (reuse same window)
        uint256 duration = lastTask.deadline - lastTask.createdAt;

        taskCount++;
        uint256 newTaskId = taskCount;
        uint256 newRound = info.roundsTriggered + 1;

        tasks[newTaskId] = Task({
            id: newTaskId,
            requester: lastTask.requester,
            modelHash: lastTask.modelHash,
            inputHash: lastTask.inputHash,
            modelRequirements: lastTask.modelRequirements,
            rewardPerNode: lastTask.rewardPerNode,
            requiredNodes: lastTask.requiredNodes,
            claimedCount: 0,
            submittedCount: 0,
            deadline: block.timestamp + duration,
            status: TaskStatus.Pending,
            consensusType: lastTask.consensusType,
            createdAt: block.timestamp,
            consensusResult: bytes32(0)
        });

        activeTaskCount++;
        taskMode[newTaskId] = TaskMode.Continuous;
        continuousParent[newTaskId] = parentTaskId;

        info.roundTaskIds.push(newTaskId);
        info.roundsTriggered++;
        info.totalSpent += roundCost;

        if (msg.value > roundCost) {
            (bool success, ) = msg.sender.call{value: msg.value - roundCost}("");
            require(success, "Refund failed");
        }

        emit TaskCreated(newTaskId, lastTask.requester, lastTask.modelHash, lastTask.rewardPerNode, lastTask.requiredNodes, lastTask.consensusType);
        emit ContinuousTaskTriggered(parentTaskId, newTaskId, newRound);

        return newTaskId;
    }

    /**
     * @notice Stop a continuous task from being re-triggered (requester or owner).
     */
    function stopContinuousTask(uint256 parentTaskId) external {
        require(
            tasks[parentTaskId].requester == msg.sender || owner() == msg.sender,
            "Not authorized"
        );
        require(_continuousInfo[parentTaskId].active, "Not an active continuous task");
        _continuousInfo[parentTaskId].active = false;
    }

    // ============ Continuous View Functions ============

    function getTaskMode(uint256 taskId) external view returns (TaskMode) {
        return taskMode[taskId];
    }

    function getContinuousInfo(uint256 taskId) external view returns (
        uint256 maxRounds,
        uint256 roundsTriggered,
        uint256 maxSpendWei,
        uint256 totalSpent,
        bool active,
        uint256[] memory roundTaskIds
    ) {
        ContinuousInfo storage info = _continuousInfo[taskId];
        return (
            info.maxRounds,
            info.roundsTriggered,
            info.maxSpendWei,
            info.totalSpent,
            info.active,
            info.roundTaskIds
        );
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

    // ============ Reputation & Multiplier Admin (#140 / #141) ============

    /**
     * @notice Set the NodeReputation contract address.
     * @dev After setting, call NodeReputation.setTrustedUpdater(address(this), true).
     */
    function setReputationRegistry(address registry) external onlyOwner {
        reputationRegistry = registry;
    }

    /**
     * @notice Deposit ETH into the multiplier bonus pool.
     * @dev Funds the 1.2× bonus paid to nodes with ≥95 reputation score (#141).
     */
    function fundMultiplierPool() external payable onlyOwner {
        require(msg.value > 0, "Must send ETH");
        multiplierPool += msg.value;
    }

    // ============ View Helpers (used by WetLabOracle #147) ============

    /**
     * @notice Returns true if a task was ever created.
     */
    function taskExists(uint256 taskId) external view returns (bool) {
        return tasks[taskId].createdAt != 0;
    }

    /**
     * @notice Returns the raw uint8 value of a task's current status.
     *         Pending=0, Active=1, Consensus=2, Completed=3,
     *         Disputed=4, Cancelled=5, Expired=6.
     */
    function getTaskStatus(uint256 taskId) external view returns (uint8) {
        return uint8(tasks[taskId].status);
    }

    receive() external payable {}
}
