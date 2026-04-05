// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVeGOV {
    function veBalanceOf(address user) external view returns (uint256);
    function totalVeGOV() external view returns (uint256);
}

/**
 * @title ProtocolFee
 * @notice Collects protocol fees from TaskRegistryV2 and distributes them
 *         weekly to veGOV holders proportional to their veGOV balance.
 *
 * Flow:
 *   1. TaskRegistryV2 calls receiveFee{value: fee}(taskId) on every completed task.
 *   2. Fees accumulate per epoch (7 days).
 *   3. After an epoch closes, veGOV holders call claim(epoch) to withdraw their share.
 *
 * Share formula:
 *   userShare = epochFees[epoch] * veBalanceOf(user) / totalVeGOV (snapshot at epoch close)
 *
 * The owner can update the veGOV contract address (governance upgrade path).
 */
contract ProtocolFee is Ownable, ReentrancyGuard {

    // ── Constants ──────────────────────────────────────────────────────────────

    uint256 public constant EPOCH_DURATION = 7 days;

    // ── State ──────────────────────────────────────────────────────────────────

    IVeGOV public veGOV;

    uint256 public epochStart;          // timestamp of epoch 0 start
    uint256 public currentEpoch;        // incrementing epoch counter

    /// @notice ETH accumulated in the current (open) epoch
    uint256 public pendingFees;

    /// @notice ETH available for claiming per closed epoch
    mapping(uint256 => uint256) public epochFees;

    /// @notice Total veGOV supply snapshot at epoch close
    mapping(uint256 => uint256) public epochTotalVeGOV;

    /// @notice Tracks whether a user has claimed for a given epoch
    mapping(address => mapping(uint256 => bool)) public claimed;

    // ── Events ─────────────────────────────────────────────────────────────────

    event FeeReceived(uint256 indexed taskId, uint256 amount, uint256 epoch);
    event EpochClosed(uint256 indexed epoch, uint256 fees, uint256 totalVeGOV);
    event FeeClaimed(address indexed user, uint256 indexed epoch, uint256 amount);
    event VeGOVUpdated(address indexed oldVeGOV, address indexed newVeGOV);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _veGOV) Ownable(msg.sender) {
        require(_veGOV != address(0), "Invalid veGOV");
        veGOV = IVeGOV(_veGOV);
        epochStart = block.timestamp;
        currentEpoch = 0;
    }

    // ── Fee Collection ─────────────────────────────────────────────────────────

    /**
     * @notice Receive protocol fee from TaskRegistryV2.
     * @dev Anyone can call this (fees from external sources welcome),
     *      but intended caller is TaskRegistryV2.
     */
    function receiveFee(uint256 taskId) external payable {
        require(msg.value > 0, "No ETH sent");

        // Advance epoch if needed
        _maybeAdvanceEpoch();

        pendingFees += msg.value;

        emit FeeReceived(taskId, msg.value, currentEpoch);
    }

    // ── Epoch Management ───────────────────────────────────────────────────────

    /**
     * @notice Manually close the current epoch and start a new one.
     *         Normally called automatically by receiveFee, but can be
     *         triggered manually if no fees arrive for 7+ days.
     */
    function advanceEpoch() external {
        require(block.timestamp >= epochStart + (currentEpoch + 1) * EPOCH_DURATION, "Epoch not over");
        _closeEpoch();
    }

    function _maybeAdvanceEpoch() internal {
        uint256 elapsed = block.timestamp - epochStart;
        uint256 expectedEpoch = elapsed / EPOCH_DURATION;
        if (expectedEpoch > currentEpoch) {
            _closeEpoch();
        }
    }

    function _closeEpoch() internal {
        uint256 epoch = currentEpoch;
        uint256 fees  = pendingFees;
        uint256 total = veGOV.totalVeGOV();

        epochFees[epoch]       = fees;
        epochTotalVeGOV[epoch] = total;
        pendingFees            = 0;
        currentEpoch           = epoch + 1;

        emit EpochClosed(epoch, fees, total);
    }

    // ── Claiming ───────────────────────────────────────────────────────────────

    /**
     * @notice Claim fee share for a closed epoch.
     * @param epoch The epoch to claim (must be < currentEpoch)
     */
    function claim(uint256 epoch) external nonReentrant {
        require(epoch < currentEpoch, "Epoch not closed yet");
        require(!claimed[msg.sender][epoch], "Already claimed");

        uint256 total = epochTotalVeGOV[epoch];
        require(total > 0, "No veGOV in this epoch");

        uint256 userVe = veGOV.veBalanceOf(msg.sender);
        require(userVe > 0, "No veGOV balance");

        uint256 share = (epochFees[epoch] * userVe) / total;
        require(share > 0, "Share rounds to zero");

        claimed[msg.sender][epoch] = true;

        (bool ok, ) = msg.sender.call{value: share}("");
        require(ok, "ETH transfer failed");

        emit FeeClaimed(msg.sender, epoch, share);
    }

    /**
     * @notice Claim multiple epochs in one tx.
     */
    function claimBatch(uint256[] calldata epochs) external nonReentrant {
        uint256 totalShare = 0;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= currentEpoch) continue;
            if (claimed[msg.sender][epoch]) continue;

            uint256 total = epochTotalVeGOV[epoch];
            if (total == 0) continue;

            uint256 userVe = veGOV.veBalanceOf(msg.sender);
            if (userVe == 0) break;

            uint256 share = (epochFees[epoch] * userVe) / total;
            if (share == 0) continue;

            claimed[msg.sender][epoch] = true;
            totalShare += share;

            emit FeeClaimed(msg.sender, epoch, share);
        }

        require(totalShare > 0, "Nothing to claim");
        (bool ok, ) = msg.sender.call{value: totalShare}("");
        require(ok, "ETH transfer failed");
    }

    // ── View ───────────────────────────────────────────────────────────────────

    /// @notice Preview claimable ETH for a user in a closed epoch
    function previewClaim(address user, uint256 epoch) external view returns (uint256) {
        if (epoch >= currentEpoch) return 0;
        if (claimed[user][epoch]) return 0;
        uint256 total = epochTotalVeGOV[epoch];
        if (total == 0) return 0;
        uint256 userVe = veGOV.veBalanceOf(user);
        if (userVe == 0) return 0;
        return (epochFees[epoch] * userVe) / total;
    }

    /// @notice Current epoch number and seconds until it closes
    function epochInfo() external view returns (uint256 epoch, uint256 secondsLeft, uint256 feesAccrued) {
        uint256 elapsed = block.timestamp - epochStart;
        uint256 epochElapsed = elapsed % EPOCH_DURATION;
        return (currentEpoch, EPOCH_DURATION - epochElapsed, pendingFees);
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    function setVeGOV(address _veGOV) external onlyOwner {
        require(_veGOV != address(0), "Invalid veGOV");
        emit VeGOVUpdated(address(veGOV), _veGOV);
        veGOV = IVeGOV(_veGOV);
    }

    /// @notice Rescue ETH that can't be claimed (e.g. epoch with 0 veGOV)
    function rescueUnclaimed(uint256 epoch) external onlyOwner {
        require(epoch < currentEpoch, "Epoch not closed");
        require(epochTotalVeGOV[epoch] == 0, "veGOV holders exist - use claim()");
        uint256 amount = epochFees[epoch];
        require(amount > 0, "Nothing to rescue");
        epochFees[epoch] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
    }

    receive() external payable {
        _maybeAdvanceEpoch();
        pendingFees += msg.value;
    }
}
