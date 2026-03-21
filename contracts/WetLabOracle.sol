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
 * 1. Owner certifies trusted labs via certifyLab()
 * 2. Owner deposits GOV reward pool via depositRewardPool()
 * 3. Labs call submitResult() after running physical experiments
 * 4. Once enough labs agree on the same resultHash, ConsensusReached is emitted
 *    and rewards are credited to each confirming lab's pendingRewards balance
 * 5. Labs call claimReward() to pull their GOV tokens
 */
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

    // ============ State Variables ============

    address public immutable govToken;
    address public immutable oarnRegistry;
    uint256 public rewardPerVerification;       // GOV tokens (18 decimals)
    uint256 public requiredLabConfirmations;    // default 2

    mapping(address => bool)                          public certifiedLabs;
    mapping(uint256 => mapping(address => LabResult)) public labResults;       // taskId → lab → result
    mapping(uint256 => address[])                     public taskLabSubmitters; // taskId → ordered submitters
    mapping(uint256 => ExperimentConsensus)           public consensus;
    mapping(address => uint256)                       public pendingRewards;    // lab → claimable GOV

    // ============ Events ============

    event LabCertified(address indexed lab);
    event LabDecertified(address indexed lab);
    event ResultSubmitted(uint256 indexed taskId, address indexed lab, bytes32 resultHash);
    event ConsensusReached(uint256 indexed taskId, bytes32 resultHash, uint256 labCount);
    event RewardClaimed(address indexed lab, uint256 amount);
    event RewardPoolDeposited(uint256 amount);
    event RewardPerVerificationUpdated(uint256 newReward);
    event RequiredConfirmationsUpdated(uint256 newRequired);

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

    // ============ Lab Management ============

    /**
     * @notice Certify a lab address to submit results.
     */
    function certifyLab(address lab) external onlyOwner {
        require(lab != address(0), "Invalid lab address");
        require(!certifiedLabs[lab], "Already certified");
        certifiedLabs[lab] = true;
        emit LabCertified(lab);
    }

    /**
     * @notice Remove certification from a lab.
     */
    function decertifyLab(address lab) external onlyOwner {
        require(certifiedLabs[lab], "Not certified");
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
        require(certifiedLabs[msg.sender], "Not a certified lab");
        require(labResults[taskId][msg.sender].submittedAt == 0, "Already submitted for this task");
        require(parametersHash != bytes32(0), "Invalid parameters hash");
        require(bytes(metric).length > 0, "Metric cannot be empty");

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

    // ============ Internal ============

    /**
     * @notice Check whether the latest submission tips any result hash over the
     *         confirmation threshold. O(n²) over lab submissions — acceptable for
     *         the small number of certified labs expected in practice.
     */
    function _checkConsensus(uint256 taskId) internal {
        if (consensus[taskId].reached) return;

        address[] storage submitters = taskLabSubmitters[taskId];
        uint256 n = submitters.length;

        if (n < requiredLabConfirmations) return;

        // Count occurrences of each resultHash
        for (uint256 i = 0; i < n; i++) {
            bytes32 candidateHash = labResults[taskId][submitters[i]].resultHash;
            uint256 count = 0;
            address[] memory confirming = new address[](n);

            for (uint256 j = 0; j < n; j++) {
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

                // Credit rewards (Checks-Effects before any external calls)
                if (rewardPerVerification > 0) {
                    for (uint256 k = 0; k < count; k++) {
                        address lab = confirmingLabs[k];
                        if (!labResults[taskId][lab].rewarded) {
                            labResults[taskId][lab].rewarded = true;
                            pendingRewards[lab] += rewardPerVerification;
                        }
                    }
                }

                return; // Consensus found — stop scanning
            }
        }
    }

    // ============ Admin ============

    /**
     * @notice Update the GOV reward credited per verified result.
     */
    function setRewardPerVerification(uint256 newReward) external onlyOwner {
        rewardPerVerification = newReward;
        emit RewardPerVerificationUpdated(newReward);
    }

    /**
     * @notice Update the number of matching lab submissions required for consensus.
     */
    function setRequiredConfirmations(uint256 newRequired) external onlyOwner {
        require(newRequired >= 2, "Need at least 2 confirmations");
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
}
