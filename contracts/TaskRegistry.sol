// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title TaskRegistry
 * @notice Core contract for OARN task management
 * @dev Handles task submission, claiming, result submission, and reward distribution
 */
contract TaskRegistry is Ownable, ReentrancyGuard, Pausable {

    // ============ Enums ============

    enum TaskStatus {
        Pending,      // Created, waiting for nodes to claim
        Active,       // Being processed by nodes
        Completed,    // All results submitted and verified
        Cancelled,    // Cancelled by requester before completion
        Expired       // Deadline passed without completion
    }

    enum TaskMode {
        Standard,         // P2P distributed, eventual consistency
        ValidatorRouted   // High-speed via validator network
    }

    // ============ Structs ============

    struct Task {
        uint256 id;
        address requester;
        bytes32 modelHash;          // IPFS CID of model
        bytes32 inputHash;          // IPFS CID of input data
        string modelRequirements;   // JSON: {"min_vram": "8GB", "framework": "pytorch"}
        uint256 rewardPerNode;      // COMP tokens per completing node
        uint256 requiredNodes;      // Number of nodes needed
        uint256 completedNodes;     // Nodes that have submitted results
        uint256 deadline;           // Unix timestamp
        TaskStatus status;
        TaskMode mode;
        uint256 createdAt;
    }

    struct TaskResult {
        address node;
        bytes32 resultHash;         // IPFS CID of result
        uint256 submittedAt;
        bool verified;
        bool rewarded;
    }

    // ============ State Variables ============

    // Task storage
    mapping(uint256 => Task) public tasks;
    mapping(uint256 => TaskResult[]) public taskResults;
    mapping(uint256 => mapping(address => bool)) public hasClaimedTask;
    mapping(uint256 => mapping(address => bool)) public hasSubmittedResult;

    uint256 public taskCount;
    uint256 public activeTaskCount;

    // Token contract for rewards
    address public tokenReward;

    // Fee for validator-routed mode (basis points, 100 = 1%)
    uint256 public validatorFeeRate = 500; // 5% extra for speed

    // Minimum reward per node
    uint256 public minRewardPerNode = 1 ether; // 1 COMP minimum

    // ============ Events ============

    event TaskCreated(
        uint256 indexed taskId,
        address indexed requester,
        bytes32 modelHash,
        uint256 rewardPerNode,
        uint256 requiredNodes,
        TaskMode mode
    );

    event TaskClaimed(uint256 indexed taskId, address indexed node);

    event ResultSubmitted(
        uint256 indexed taskId,
        address indexed node,
        bytes32 resultHash
    );

    event TaskCompleted(uint256 indexed taskId, uint256 totalRewards);

    event TaskCancelled(uint256 indexed taskId, uint256 refundAmount);

    event TaskExpired(uint256 indexed taskId);

    event RewardDistributed(
        uint256 indexed taskId,
        address indexed node,
        uint256 amount
    );

    // ============ Constructor ============

    constructor(address _tokenReward) Ownable(msg.sender) {
        require(_tokenReward != address(0), "Invalid token address");
        tokenReward = _tokenReward;
    }

    // ============ Task Submission ============

    /**
     * @notice Submit a new task for distributed processing
     * @param modelHash IPFS CID of the model to run
     * @param inputHash IPFS CID of the input data
     * @param modelRequirements JSON string of hardware requirements
     * @param rewardPerNode COMP tokens to pay each completing node
     * @param requiredNodes Number of nodes needed for consensus
     * @param deadline Unix timestamp when task expires
     */
    function submitTask(
        bytes32 modelHash,
        bytes32 inputHash,
        string calldata modelRequirements,
        uint256 rewardPerNode,
        uint256 requiredNodes,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        return _createTask(
            modelHash,
            inputHash,
            modelRequirements,
            rewardPerNode,
            requiredNodes,
            deadline,
            TaskMode.Standard
        );
    }

    /**
     * @notice Submit a validator-routed task for faster processing
     * @dev Charges additional fee for priority routing
     */
    function submitTaskValidatorRouted(
        bytes32 modelHash,
        bytes32 inputHash,
        string calldata modelRequirements,
        uint256 rewardPerNode,
        uint256 requiredNodes,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        return _createTask(
            modelHash,
            inputHash,
            modelRequirements,
            rewardPerNode,
            requiredNodes,
            deadline,
            TaskMode.ValidatorRouted
        );
    }

    function _createTask(
        bytes32 modelHash,
        bytes32 inputHash,
        string calldata modelRequirements,
        uint256 rewardPerNode,
        uint256 requiredNodes,
        uint256 deadline,
        TaskMode mode
    ) internal returns (uint256) {
        require(modelHash != bytes32(0), "Invalid model hash");
        require(requiredNodes > 0 && requiredNodes <= 100, "Invalid node count");
        require(deadline > block.timestamp, "Invalid deadline");
        require(rewardPerNode >= minRewardPerNode, "Reward too low");

        // Calculate total cost
        uint256 totalReward = rewardPerNode * requiredNodes;
        uint256 fee = mode == TaskMode.ValidatorRouted
            ? (totalReward * validatorFeeRate) / 10000
            : 0;
        uint256 totalCost = totalReward + fee;

        require(msg.value >= totalCost, "Insufficient payment");

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
            completedNodes: 0,
            deadline: deadline,
            status: TaskStatus.Pending,
            mode: mode,
            createdAt: block.timestamp
        });

        activeTaskCount++;

        // Refund excess payment
        if (msg.value > totalCost) {
            (bool success, ) = msg.sender.call{value: msg.value - totalCost}("");
            require(success, "Refund failed");
        }

        emit TaskCreated(taskId, msg.sender, modelHash, rewardPerNode, requiredNodes, mode);

        return taskId;
    }

    // ============ Task Processing ============

    /**
     * @notice Claim a task to work on
     * @param taskId The task to claim
     */
    function claimTask(uint256 taskId) external nonReentrant whenNotPaused {
        Task storage task = tasks[taskId];

        require(task.id != 0, "Task not found");
        require(task.status == TaskStatus.Pending || task.status == TaskStatus.Active, "Task not available");
        require(block.timestamp < task.deadline, "Task expired");
        require(!hasClaimedTask[taskId][msg.sender], "Already claimed");

        hasClaimedTask[taskId][msg.sender] = true;

        if (task.status == TaskStatus.Pending) {
            task.status = TaskStatus.Active;
        }

        emit TaskClaimed(taskId, msg.sender);
    }

    /**
     * @notice Submit result for a claimed task
     * @param taskId The task ID
     * @param resultHash IPFS CID of the result
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
        task.completedNodes++;

        taskResults[taskId].push(TaskResult({
            node: msg.sender,
            resultHash: resultHash,
            submittedAt: block.timestamp,
            verified: false,
            rewarded: false
        }));

        emit ResultSubmitted(taskId, msg.sender, resultHash);

        // Check if task is complete
        if (task.completedNodes >= task.requiredNodes) {
            _completeTask(taskId);
        }
    }

    function _completeTask(uint256 taskId) internal {
        Task storage task = tasks[taskId];
        task.status = TaskStatus.Completed;
        activeTaskCount--;

        // Distribute rewards to all nodes that submitted results
        uint256 totalDistributed = 0;
        TaskResult[] storage results = taskResults[taskId];

        for (uint256 i = 0; i < results.length; i++) {
            if (!results[i].rewarded) {
                results[i].rewarded = true;
                results[i].verified = true;

                (bool success, ) = results[i].node.call{value: task.rewardPerNode}("");
                if (success) {
                    totalDistributed += task.rewardPerNode;
                    emit RewardDistributed(taskId, results[i].node, task.rewardPerNode);
                }
            }
        }

        emit TaskCompleted(taskId, totalDistributed);
    }

    // ============ Task Management ============

    /**
     * @notice Cancel a pending task and get refund
     * @param taskId The task to cancel
     */
    function cancelTask(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];

        require(task.id != 0, "Task not found");
        require(task.requester == msg.sender, "Not task owner");
        require(task.status == TaskStatus.Pending, "Cannot cancel active task");

        task.status = TaskStatus.Cancelled;
        activeTaskCount--;

        uint256 refund = task.rewardPerNode * task.requiredNodes;

        (bool success, ) = msg.sender.call{value: refund}("");
        require(success, "Refund failed");

        emit TaskCancelled(taskId, refund);
    }

    /**
     * @notice Mark expired tasks (can be called by anyone)
     * @param taskId The task to check
     */
    function expireTask(uint256 taskId) external {
        Task storage task = tasks[taskId];

        require(task.id != 0, "Task not found");
        require(block.timestamp >= task.deadline, "Not expired yet");
        require(task.status == TaskStatus.Pending || task.status == TaskStatus.Active, "Already finalized");

        task.status = TaskStatus.Expired;
        activeTaskCount--;

        // Refund remaining funds to requester
        uint256 usedRewards = task.completedNodes * task.rewardPerNode;
        uint256 totalDeposit = task.rewardPerNode * task.requiredNodes;
        uint256 refund = totalDeposit - usedRewards;

        if (refund > 0) {
            (bool success, ) = task.requester.call{value: refund}("");
            require(success, "Refund failed");
        }

        emit TaskExpired(taskId);
    }

    // ============ View Functions ============

    /**
     * @notice Get task details
     */
    function getTask(uint256 taskId) external view returns (Task memory) {
        require(tasks[taskId].id != 0, "Task not found");
        return tasks[taskId];
    }

    /**
     * @notice Get results for a task
     */
    function getTaskResults(uint256 taskId) external view returns (TaskResult[] memory) {
        return taskResults[taskId];
    }

    /**
     * @notice Get available tasks for claiming
     */
    function getAvailableTasks(uint256 offset, uint256 limit) external view returns (Task[] memory) {
        uint256 count = 0;

        // Count available tasks
        for (uint256 i = 1; i <= taskCount; i++) {
            if ((tasks[i].status == TaskStatus.Pending || tasks[i].status == TaskStatus.Active)
                && block.timestamp < tasks[i].deadline) {
                count++;
            }
        }

        if (offset >= count) {
            return new Task[](0);
        }

        uint256 resultCount = count - offset;
        if (resultCount > limit) {
            resultCount = limit;
        }

        Task[] memory result = new Task[](resultCount);
        uint256 resultIndex = 0;
        uint256 skipped = 0;

        for (uint256 i = 1; i <= taskCount && resultIndex < resultCount; i++) {
            if ((tasks[i].status == TaskStatus.Pending || tasks[i].status == TaskStatus.Active)
                && block.timestamp < tasks[i].deadline) {
                if (skipped < offset) {
                    skipped++;
                } else {
                    result[resultIndex] = tasks[i];
                    resultIndex++;
                }
            }
        }

        return result;
    }

    /**
     * @notice Get tasks by requester
     */
    function getTasksByRequester(
        address requester,
        uint256 offset,
        uint256 limit
    ) external view returns (Task[] memory) {
        uint256 count = 0;

        for (uint256 i = 1; i <= taskCount; i++) {
            if (tasks[i].requester == requester) {
                count++;
            }
        }

        if (offset >= count) {
            return new Task[](0);
        }

        uint256 resultCount = count - offset;
        if (resultCount > limit) {
            resultCount = limit;
        }

        Task[] memory result = new Task[](resultCount);
        uint256 resultIndex = 0;
        uint256 skipped = 0;

        for (uint256 i = 1; i <= taskCount && resultIndex < resultCount; i++) {
            if (tasks[i].requester == requester) {
                if (skipped < offset) {
                    skipped++;
                } else {
                    result[resultIndex] = tasks[i];
                    resultIndex++;
                }
            }
        }

        return result;
    }

    // ============ Admin Functions ============

    function setTokenReward(address _tokenReward) external onlyOwner {
        require(_tokenReward != address(0), "Invalid address");
        tokenReward = _tokenReward;
    }

    function setValidatorFeeRate(uint256 _rate) external onlyOwner {
        require(_rate <= 2000, "Fee too high"); // Max 20%
        validatorFeeRate = _rate;
    }

    function setMinRewardPerNode(uint256 _minReward) external onlyOwner {
        minRewardPerNode = _minReward;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // Emergency withdrawal (governance only, for stuck funds)
    function emergencyWithdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid address");
        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
    }

    receive() external payable {}
}
