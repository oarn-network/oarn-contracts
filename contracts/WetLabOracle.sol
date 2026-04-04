// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title WetLabOracle
 * @notice On-chain validation oracle for physical wet lab experiment results.
 * @dev Certified labs submit measured results linked to OARN task IDs.
 *      When requiredLabConfirmations labs submit the same result hash, consensus
 *      is reached and each confirming lab earns GOV token rewards.
 *
 * Flow:
 * 1. Owner schedules then executes certifyLab() after the 48-hour timelock (#145)
 * 2. Owner deposits GOV reward pool via depositRewardPool()
 * 3. Labs call submitResult() after running physical experiments
 *    — submitResult validates the taskId against TaskRegistryV2 (#147)
 * 4. Once enough *currently-certified* labs agree on the same resultHash,
 *    ConsensusReached is emitted and rewards are credited (#146)
 * 5. Labs call claimReward() to pull their GOV tokens
 *
 * Pre-mainnet hardening:
 *   #145 — 48-hour timelock on owner actions (certifyLab, decertifyLab,
 *           setRewardPerVerification, setRequiredConfirmations).
 *   #146 — Decertified labs are excluded from consensus counting so that
 *           revoking a bad actor immediately affects open experiments.
 *   #147 — submitResult validates that the referenced taskId exists in
 *           TaskRegistryV2 and is in an active state (Pending/Active/Consensus).
 */

// ============ Interface ============

interface ITaskRegistryV2 {
    /// @notice Returns true if the task was ever created (createdAt != 0).
    function taskExists(uint256 taskId) external view returns (bool);
    /// @notice Returns the raw uint8 representation of TaskStatus enum.
    function getTaskStatus(uint256 taskId) external view returns (uint8);
}

// ============ Contract ============

contract WetLabOracle is Ownable, ReentrancyGuard {

    // ============ Structs ============

    struct LabResult {
        bytes32 resultHash;       // keccak256(abi.encode(parametersHash, measuredValue, metric))
        int256  measuredValue;    // basis points, e.g. 6048 = 60.48%
        string  metric;           // "yield_pct", "cost_per_gram", "purity_pct"
        bytes32 parametersHash;   // links to the specific OARN batch combo tested
        uint256 submittedAt;
        bool    rewarded;
    }

    struct ExperimentConsensus {
        bytes32   agreedHash;
        uint256   confirmingLabCount;
        address[] confirmingLabs;
        uint256   verifiedAt;
        bool      reached;
    }

    // ============ Constants ============

    /// Maximum certified labs that may submit per task; caps the O(n²) _checkConsensus loop.
    uint256 public constant MAX_SUBMITTERS_PER_TASK = 50;

    /// Maximum byte-length for the metric string stored on-chain.
    uint256 public constant MAX_METRIC_LENGTH = 64;

    /// #145 — Minimum delay between scheduling and executing an owner action.
    uint256 public constant TIMELOCK_DELAY = 48 hours;

    // ============ State Variables ============

    address public immutable govToken;
    /// Points to TaskRegistryV2 — used for taskId validation (#147).
    address public immutable oarnRegistry;

    uint256 public rewardPerVerification;       // GOV tokens (18 decimals)
    uint256 public requiredLabConfirmations;    // default 2

    mapping(address => bool)                          public certifiedLabs;
    mapping(uint256 => mapping(address => LabResult)) public labResults;       // taskId → lab → result
    mapping(uint256 => address[])                     public taskLabSubmitters; // taskId → ordered submitters
    mapping(uint256 => ExperimentConsensus)           public consensus;
    mapping(address => uint256)                       public pendingRewards;    // lab → claimable GOV

    /// Running sum of all GOV credited to labs but not yet claimed.
    uint256 public totalPendingRewards;

    /// #145 — actionId → timestamp when the action was scheduled (0 = unscheduled).
    mapping(bytes32 => uint256) public timelockQueue;

    // ============ Events ============

    event LabCertified(address indexed lab);
    event LabDecertified(address indexed lab);
    event ResultSubmitted(uint256 indexed taskId, address indexed lab, bytes32 resultHash);
    event ConsensusReached(uint256 indexed taskId, bytes32 resultHash, uint256 labCount);
    event RewardClaimed(address indexed lab, uint256 amount);
    event RewardPoolDeposited(uint256 amount);
    event RewardPoolWithdrawn(uint256 amount);
    event RewardPerVerificationUpdated(uint256 newReward);
    event RequiredConfirmationsUpdated(uint256 newRequired);
    /// Emitted when consensus is reached but the pool is insufficient to cover rewards.
    event RewardPoolInsufficient(uint256 indexed taskId, uint256 required, uint256 available);
    /// #145 — Emitted when an owner action enters the timelock queue.
    event TimelockScheduled(bytes32 indexed actionId, uint256 executeAfter);
    /// #145 — Emitted when a queued action is cancelled by the owner.
    event TimelockCancelled(bytes32 indexed actionId);

    // ============ Constructor ============

    constructor(
        address _govToken,
        address _oarnRegistry,
        uint256 _rewardPerVerification,
        uint256 _requiredLabConfirmations
    ) Ownable(msg.sender) {
        require(_govToken != address(0), "Invalid GOV token address");
        require(_oarnRegistry != address(0), "Invalid registry address");
        require(_requiredLabConfirmations >= 2, "Need at least 2 confirmations");
        govToken = _govToken;
        oarnRegistry = _oarnRegistry;
        rewardPerVerification = _rewardPerVerification;
        requiredLabConfirmations = _requiredLabConfirmations;
    }

    // ============ Timelock Scheduling (#145) ============

    /**
     * @notice Schedule a certifyLab() call. Must wait TIMELOCK_DELAY before executing.
     */
    function scheduleCertifyLab(address lab) external onlyOwner {
        require(lab != address(0), "Invalid lab address");
        bytes32 id = keccak256(abi.encode("certifyLab", lab));
        timelockQueue[id] = block.timestamp;
        emit TimelockScheduled(id, block.timestamp + TIMELOCK_DELAY);
    }

    /**
     * @notice Schedule a decertifyLab() call. Must wait TIMELOCK_DELAY before executing.
     */
    function scheduleDecertifyLab(address lab) external onlyOwner {
        require(certifiedLabs[lab], "Not certified");
        bytes32 id = keccak256(abi.encode("decertifyLab", lab));
        timelockQueue[id] = block.timestamp;
        emit TimelockScheduled(id, block.timestamp + TIMELOCK_DELAY);
    }

    /**
     * @notice Schedule a setRewardPerVerification() call.
     */
    function scheduleSetRewardPerVerification(uint256 newReward) external onlyOwner {
        bytes32 id = keccak256(abi.encode("setRewardPerVerification", newReward));
        timelockQueue[id] = block.timestamp;
        emit TimelockScheduled(id, block.timestamp + TIMELOCK_DELAY);
    }

    /**
     * @notice Schedule a setRequiredConfirmations() call.
     */
    function scheduleSetRequiredConfirmations(uint256 newRequired) external onlyOwner {
        require(newRequired >= 2, "Need at least 2 confirmations");
        bytes32 id = keccak256(abi.encode("setRequiredConfirmations", newRequired));
        timelockQueue[id] = block.timestamp;
        emit TimelockScheduled(id, block.timestamp + TIMELOCK_DELAY);
    }

    /**
     * @notice Cancel a pending timelock action before it is executed.
     */
    function cancelTimelockAction(bytes32 actionId) external onlyOwner {
        require(timelockQueue[actionId] != 0, "Not scheduled");
        delete timelockQueue[actionId];
        emit TimelockCancelled(actionId);
    }

    // ============ Lab Management ============

    /**
     * @notice Certify a lab address to submit results.
     * @dev Requires a prior scheduleCertifyLab() call at least TIMELOCK_DELAY ago (#145).
     */
    function certifyLab(address lab) external onlyOwner {
        require(lab != address(0), "Invalid lab address");
        require(!certifiedLabs[lab], "Already certified");
        _consumeTimelock(keccak256(abi.encode("certifyLab", lab)));
        certifiedLabs[lab] = true;
        emit LabCertified(lab);
    }

    /**
     * @notice Remove certification from a lab.
     * @dev Requires a prior scheduleDecertifyLab() call at least TIMELOCK_DELAY ago (#145).
     *      The lab's existing results are excluded from future consensus checks (#146).
     */
    function decertifyLab(address lab) external onlyOwner {
        require(certifiedLabs[lab], "Not certified");
        _consumeTimelock(keccak256(abi.encode("decertifyLab", lab)));
        certifiedLabs[lab] = false;
        emit LabDecertified(lab);
    }

    // ============ Result Submission ============

    /**
     * @notice Submit a measured experiment result for an OARN task.
     * @param taskId         The OARN task ID this result corresponds to.
     * @param parametersHash keccak256 hash of the experimental parameters batch tested.
     * @param measuredValue  Result in basis points (e.g. 6048 = 60.48% yield).
     * @param metric         Human-readable metric name, e.g. "yield_pct".
     */
    function submitResult(
        uint256 taskId,
        bytes32 parametersHash,
        int256  measuredValue,
        string calldata metric
    ) external nonReentrant {
        require(taskId > 0, "Invalid taskId");
        require(certifiedLabs[msg.sender], "Not a certified lab");
        require(labResults[taskId][msg.sender].submittedAt == 0, "Already submitted for this task");
        require(parametersHash != bytes32(0), "Invalid parameters hash");
        require(bytes(metric).length > 0, "Metric cannot be empty");
        require(bytes(metric).length <= MAX_METRIC_LENGTH, "Metric string too long");
        require(taskLabSubmitters[taskId].length < MAX_SUBMITTERS_PER_TASK, "Max submitters reached for task");

        // #147: Validate the taskId exists in TaskRegistryV2 and is in a processable state.
        // TaskRegistryV2 is stored in oarnRegistry (set at deploy time).
        require(
            ITaskRegistryV2(oarnRegistry).taskExists(taskId),
            "Task does not exist in registry"
        );
        // TaskStatus: Pending(0), Active(1), Consensus(2) are valid.
        // Completed(3), Disputed(4), Cancelled(5), Expired(6) are terminal — no point submitting.
        require(
            ITaskRegistryV2(oarnRegistry).getTaskStatus(taskId) <= 2,
            "Task is not in a valid state for wet-lab submission"
        );

        bytes32 resultHash = keccak256(abi.encode(parametersHash, measuredValue, metric));

        labResults[taskId][msg.sender] = LabResult({
            resultHash:     resultHash,
            measuredValue:  measuredValue,
            metric:         metric,
            parametersHash: parametersHash,
            submittedAt:    block.timestamp,
            rewarded:       false
        });

        taskLabSubmitters[taskId].push(msg.sender);

        emit ResultSubmitted(taskId, msg.sender, resultHash);

        _checkConsensus(taskId);
    }

    // ============ Rewards ============

    /**
     * @notice Claim all pending GOV token rewards.
     */
    function claimReward() external nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "No pending rewards");

        // Checks-Effects-Interactions: update state before transfer
        pendingRewards[msg.sender] = 0;
        totalPendingRewards -= amount;

        require(
            IERC20(govToken).transfer(msg.sender, amount),
            "GOV transfer failed"
        );

        emit RewardClaimed(msg.sender, amount);
    }

    /**
     * @notice Deposit GOV tokens into the reward pool.
     * @dev Caller must have approved this contract to spend `amount` of GOV.
     */
    function depositRewardPool(uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be positive");
        require(
            IERC20(govToken).transferFrom(msg.sender, address(this), amount),
            "GOV transfer failed"
        );
        emit RewardPoolDeposited(amount);
    }

    /**
     * @notice Withdraw GOV tokens from the reward pool back to the owner.
     * @dev Only the unallocated portion (total balance minus pending rewards) may be withdrawn.
     */
    function withdrawRewardPool(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be positive");

        uint256 poolBalance = IERC20(govToken).balanceOf(address(this));
        uint256 unallocated = poolBalance > totalPendingRewards
            ? poolBalance - totalPendingRewards
            : 0;
        require(amount <= unallocated, "Amount exceeds unallocated pool balance");

        require(
            IERC20(govToken).transfer(msg.sender, amount),
            "GOV transfer failed"
        );
        emit RewardPoolWithdrawn(amount);
    }

    // ============ Admin ============

    /**
     * @notice Update the GOV reward credited per verified result.
     * @dev Requires a prior scheduleSetRewardPerVerification() call at least TIMELOCK_DELAY ago.
     */
    function setRewardPerVerification(uint256 newReward) external onlyOwner {
        _consumeTimelock(keccak256(abi.encode("setRewardPerVerification", newReward)));
        rewardPerVerification = newReward;
        emit RewardPerVerificationUpdated(newReward);
    }

    /**
     * @notice Update the number of matching lab submissions required for consensus.
     * @dev Requires a prior scheduleSetRequiredConfirmations() call at least TIMELOCK_DELAY ago.
     */
    function setRequiredConfirmations(uint256 newRequired) external onlyOwner {
        require(newRequired >= 2, "Need at least 2 confirmations");
        _consumeTimelock(keccak256(abi.encode("setRequiredConfirmations", newRequired)));
        requiredLabConfirmations = newRequired;
        emit RequiredConfirmationsUpdated(newRequired);
    }

    // ============ View Functions ============

    /**
     * @notice Returns the verified result for a task, reverts if not yet verified.
     */
    function getVerifiedResult(uint256 taskId) external view returns (
        bytes32 agreedHash,
        uint256 confirmingLabCount,
        address[] memory confirmingLabs,
        uint256 verifiedAt
    ) {
        ExperimentConsensus storage c = consensus[taskId];
        require(c.reached, "No consensus yet");
        return (c.agreedHash, c.confirmingLabCount, c.confirmingLabs, c.verifiedAt);
    }

    /**
     * @notice Check whether an address is a certified lab.
     */
    function isLabCertified(address lab) external view returns (bool) {
        return certifiedLabs[lab];
    }

    /**
     * @notice Get all lab addresses that have submitted results for a task.
     */
    function getTaskSubmitters(uint256 taskId) external view returns (address[] memory) {
        return taskLabSubmitters[taskId];
    }

    /**
     * @notice Get the current GOV token balance held in the reward pool.
     */
    function rewardPoolBalance() external view returns (uint256) {
        return IERC20(govToken).balanceOf(address(this));
    }

    // ============ Internal ============

    /**
     * @notice Consume a scheduled timelock action, reverting if not ready.
     * @dev Deletes the queue entry on success to prevent replay.
     */
    function _consumeTimelock(bytes32 actionId) internal {
        uint256 scheduledAt = timelockQueue[actionId];
        require(scheduledAt != 0, "Action not scheduled: call schedule* first");
        require(
            block.timestamp >= scheduledAt + TIMELOCK_DELAY,
            "Timelock delay not elapsed"
        );
        delete timelockQueue[actionId];
    }

    /**
     * @notice Check whether the latest submission tips any result hash over the
     *         confirmation threshold. O(n²) over certified lab submissions —
     *         acceptable given MAX_SUBMITTERS_PER_TASK cap.
     *
     * #146: Submissions from decertified labs are excluded. If a lab is
     *       decertified after submitting, their result no longer contributes
     *       to consensus on any open task.
     */
    function _checkConsensus(uint256 taskId) internal {
        if (consensus[taskId].reached) return;

        address[] storage submitters = taskLabSubmitters[taskId];
        uint256 n = submitters.length;

        // #146: count only currently-certified submitters for the quorum check
        uint256 certifiedCount = 0;
        for (uint256 i = 0; i < n; i++) {
            if (certifiedLabs[submitters[i]]) certifiedCount++;
        }
        if (certifiedCount < requiredLabConfirmations) return;

        // Count occurrences of each resultHash, considering only certified labs
        for (uint256 i = 0; i < n; i++) {
            // #146: skip decertified labs when picking the candidate hash
            if (!certifiedLabs[submitters[i]]) continue;

            bytes32 candidateHash = labResults[taskId][submitters[i]].resultHash;
            uint256 count = 0;
            address[] memory confirming = new address[](n);

            for (uint256 j = 0; j < n; j++) {
                // #146: skip decertified labs when counting support
                if (!certifiedLabs[submitters[j]]) continue;
                if (labResults[taskId][submitters[j]].resultHash == candidateHash) {
                    confirming[count] = submitters[j];
                    count++;
                }
            }

            if (count >= requiredLabConfirmations) {
                // Build exact-sized confirming labs array
                address[] memory confirmingLabs = new address[](count);
                for (uint256 k = 0; k < count; k++) {
                    confirmingLabs[k] = confirming[k];
                }

                // Record consensus
                ExperimentConsensus storage c = consensus[taskId];
                c.agreedHash         = candidateHash;
                c.confirmingLabCount = count;
                c.confirmingLabs     = confirmingLabs;
                c.verifiedAt         = block.timestamp;
                c.reached            = true;

                emit ConsensusReached(taskId, candidateHash, count);

                // H-1: verify the pool can cover all rewards before crediting anyone.
                if (rewardPerVerification > 0) {
                    uint256 totalReward = rewardPerVerification * count;
                    uint256 poolBalance = IERC20(govToken).balanceOf(address(this));
                    if (totalReward > poolBalance) {
                        emit RewardPoolInsufficient(taskId, totalReward, poolBalance);
                    } else {
                        for (uint256 k = 0; k < count; k++) {
                            address lab = confirmingLabs[k];
                            if (!labResults[taskId][lab].rewarded) {
                                labResults[taskId][lab].rewarded = true;
                                pendingRewards[lab] += rewardPerVerification;
                                totalPendingRewards += rewardPerVerification;
                            }
                        }
                    }
                }

                return; // Consensus found — stop scanning
            }
        }
    }
}
