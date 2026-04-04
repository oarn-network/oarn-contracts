// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title NodeReputation
 * @notice On-chain reputation storage for OARN compute nodes.
 * @dev Trusted updaters (TaskRegistryV2) call recordResult() and recordClaim()
 *      after each consensus round. Score and tier are computed from cumulative stats.
 *
 * Score formula (matches the off-chain dashboard hook):
 *   score = 40% × consensusMatchRate + 30% × submissionRate + 30% × volumeScore
 *   where volumeScore saturates at VOLUME_SATURATION completed tasks.
 *
 * Tiers: Platinum ≥90 | Gold ≥70 | Silver ≥45 | Bronze ≥20 | New
 *
 * #140 — Initial on-chain reputation storage.
 * Plugged into TaskRegistryV2 as a trusted updater to enable the #141 COMP multiplier.
 */
contract NodeReputation is Ownable {

    // ============ Structs ============

    struct ReputationData {
        uint64  tasksClaimed;      // tasks claimed from TaskRegistryV2
        uint64  tasksSubmitted;    // results submitted (matched + non-matched)
        uint64  consensusMatches;  // submissions that matched consensus
        uint64  _reserved;         // padding for alignment
        uint128 totalEarnedWei;    // cumulative wei earned (base + bonuses)
        uint64  lastUpdate;        // block.timestamp of last update
    }

    // ============ Constants ============

    /// Volume score saturates at this many consensus-matched tasks.
    uint256 public constant VOLUME_SATURATION = 50;

    // ============ State ============

    mapping(address => ReputationData) public reputation;
    /// Addresses authorised to call recordResult() and recordClaim().
    mapping(address => bool) public trustedUpdaters;

    // ============ Events ============

    event ReputationUpdated(address indexed node, uint256 score, string tier);
    event UpdaterSet(address indexed updater, bool trusted);

    // ============ Constructor ============

    constructor() Ownable(msg.sender) {}

    // ============ Admin ============

    /**
     * @notice Grant or revoke trusted-updater status (e.g. TaskRegistryV2 address).
     */
    function setTrustedUpdater(address updater, bool trusted) external onlyOwner {
        require(updater != address(0), "Invalid address");
        trustedUpdaters[updater] = trusted;
        emit UpdaterSet(updater, trusted);
    }

    // ============ Write (trusted updaters only) ============

    /**
     * @notice Record the outcome of a task result for a node.
     * @param node             The compute node address.
     * @param matchedConsensus True if the node's result matched consensus.
     * @param earnedWei        ETH earned this task (base + bonus, 0 if non-matching).
     */
    function recordResult(
        address node,
        bool    matchedConsensus,
        uint256 earnedWei
    ) external {
        require(trustedUpdaters[msg.sender], "Not a trusted updater");
        require(node != address(0), "Invalid node");

        ReputationData storage r = reputation[node];
        r.tasksSubmitted++;
        if (matchedConsensus) {
            r.consensusMatches++;
            // Safe cast: total ETH paid on Arbitrum will never exceed uint128 range
            r.totalEarnedWei += uint128(earnedWei);
        }
        r.lastUpdate = uint64(block.timestamp);

        (uint256 score, string memory tier) = _score(r);
        emit ReputationUpdated(node, score, tier);
    }

    /**
     * @notice Increment the tasksClaimed counter for a node.
     *         Called from TaskRegistryV2.claimTask().
     */
    function recordClaim(address node) external {
        require(trustedUpdaters[msg.sender], "Not a trusted updater");
        require(node != address(0), "Invalid node");
        reputation[node].tasksClaimed++;
        reputation[node].lastUpdate = uint64(block.timestamp);
    }

    // ============ View ============

    /**
     * @notice Get a node's computed reputation score (0–100) and tier string.
     */
    function getScore(address node) external view returns (uint256 score, string memory tier) {
        return _score(reputation[node]);
    }

    /**
     * @notice Get the raw reputation counters for a node.
     */
    function getReputation(address node) external view returns (
        uint64  tasksClaimed,
        uint64  tasksSubmitted,
        uint64  consensusMatches,
        uint128 totalEarnedWei,
        uint64  lastUpdate
    ) {
        ReputationData storage r = reputation[node];
        return (
            r.tasksClaimed,
            r.tasksSubmitted,
            r.consensusMatches,
            r.totalEarnedWei,
            r.lastUpdate
        );
    }

    // ============ Internal ============

    function _score(ReputationData storage r) internal view returns (uint256 score, string memory tier) {
        // All rates in basis points (0–10 000 = 0–100%)
        uint256 cRate = r.tasksSubmitted > 0
            ? (uint256(r.consensusMatches) * 10_000) / uint256(r.tasksSubmitted)
            : 0;

        uint256 sRate = r.tasksClaimed > 0
            ? (uint256(r.tasksSubmitted) * 10_000) / uint256(r.tasksClaimed)
            : 0;
        if (sRate > 10_000) sRate = 10_000; // cap at 100%

        uint256 vol = r.consensusMatches >= VOLUME_SATURATION
            ? 10_000
            : (uint256(r.consensusMatches) * 10_000) / VOLUME_SATURATION;

        // Weighted average: score is 0–100
        score = (40 * cRate + 30 * sRate + 30 * vol) / 10_000;

        if      (score >= 90) tier = "Platinum";
        else if (score >= 70) tier = "Gold";
        else if (score >= 45) tier = "Silver";
        else if (score >= 20) tier = "Bronze";
        else                  tier = "New";
    }
}
