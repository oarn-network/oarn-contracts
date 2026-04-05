// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title VeGOV
 * @notice Vote-escrowed GOV — lock GOV tokens for 6, 12, or 24 months to
 *         receive non-transferable veGOV. Longer lock = more veGOV weight.
 *
 * Lock multipliers:
 *   6 months  → 1× veGOV (= locked amount)
 *   12 months → 2× veGOV
 *   24 months → 4× veGOV
 *
 * veGOV is:
 *   - Non-transferable (soulbound)
 *   - Used as governance weight (replaces raw GOV for protocol decisions)
 *   - Used to determine share of protocol fee distribution (ProtocolFee.sol)
 *
 * When a lock expires the user calls unlock() to reclaim their GOV.
 * Early unlock is not supported — this is intentional economic design.
 */
contract VeGOV is Ownable, ReentrancyGuard {

    // ── Constants ──────────────────────────────────────────────────────────────

    uint256 public constant LOCK_6M  = 180 days;
    uint256 public constant LOCK_12M = 365 days;
    uint256 public constant LOCK_24M = 730 days;

    uint256 public constant MULTIPLIER_6M  = 1;
    uint256 public constant MULTIPLIER_12M = 2;
    uint256 public constant MULTIPLIER_24M = 4;

    // ── State ──────────────────────────────────────────────────────────────────

    IERC20 public immutable govToken;

    struct Lock {
        uint256 amount;      // GOV locked
        uint256 veAmount;    // veGOV minted
        uint256 unlockAt;    // timestamp when GOV can be reclaimed
        bool    active;
    }

    /// @notice One active lock per address (can be extended or topped up)
    mapping(address => Lock) public locks;

    /// @notice Total veGOV outstanding
    uint256 public totalVeGOV;

    // ── Events ─────────────────────────────────────────────────────────────────

    event Locked(address indexed user, uint256 govAmount, uint256 veAmount, uint256 unlockAt);
    event Unlocked(address indexed user, uint256 govAmount, uint256 veAmount);
    event LockExtended(address indexed user, uint256 additionalGov, uint256 newVeAmount, uint256 newUnlockAt);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _govToken) Ownable(msg.sender) {
        require(_govToken != address(0), "Invalid GOV token");
        govToken = IERC20(_govToken);
    }

    // ── Lock ───────────────────────────────────────────────────────────────────

    /**
     * @notice Lock GOV for a fixed period and receive veGOV weight.
     * @param amount     Amount of GOV to lock (18-decimal units)
     * @param lockPeriod One of LOCK_6M, LOCK_12M, LOCK_24M
     */
    function lock(uint256 amount, uint256 lockPeriod) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(
            lockPeriod == LOCK_6M || lockPeriod == LOCK_12M || lockPeriod == LOCK_24M,
            "Invalid lock period (use 180, 365, or 730 days)"
        );
        require(!locks[msg.sender].active, "Already locked - use extend()");

        uint256 multiplier = _multiplier(lockPeriod);
        uint256 veAmount = amount * multiplier;
        uint256 unlockAt = block.timestamp + lockPeriod;

        locks[msg.sender] = Lock({
            amount: amount,
            veAmount: veAmount,
            unlockAt: unlockAt,
            active: true
        });

        totalVeGOV += veAmount;

        require(govToken.transferFrom(msg.sender, address(this), amount), "GOV transfer failed");

        emit Locked(msg.sender, amount, veAmount, unlockAt);
    }

    /**
     * @notice Add more GOV to an existing lock and/or extend the period.
     *         The new unlock time must be >= existing unlock time.
     * @param additionalAmount Extra GOV to add (0 = period extension only)
     * @param newLockPeriod    New lock period from now (must be >= remaining)
     */
    function extend(uint256 additionalAmount, uint256 newLockPeriod) external nonReentrant {
        Lock storage l = locks[msg.sender];
        require(l.active, "No active lock");
        require(
            newLockPeriod == LOCK_6M || newLockPeriod == LOCK_12M || newLockPeriod == LOCK_24M,
            "Invalid lock period"
        );
        uint256 newUnlockAt = block.timestamp + newLockPeriod;
        require(newUnlockAt >= l.unlockAt, "New unlock must be >= existing unlock");

        // Remove old veGOV
        totalVeGOV -= l.veAmount;

        uint256 newTotal = l.amount + additionalAmount;
        uint256 newMultiplier = _multiplier(newLockPeriod);
        uint256 newVeAmount = newTotal * newMultiplier;

        l.amount = newTotal;
        l.veAmount = newVeAmount;
        l.unlockAt = newUnlockAt;

        totalVeGOV += newVeAmount;

        if (additionalAmount > 0) {
            require(govToken.transferFrom(msg.sender, address(this), additionalAmount), "GOV transfer failed");
        }

        emit LockExtended(msg.sender, additionalAmount, newVeAmount, newUnlockAt);
    }

    /**
     * @notice Unlock GOV after lock period has expired.
     */
    function unlock() external nonReentrant {
        Lock storage l = locks[msg.sender];
        require(l.active, "No active lock");
        require(block.timestamp >= l.unlockAt, "Lock not yet expired");

        uint256 govAmount = l.amount;
        uint256 veAmount  = l.veAmount;

        totalVeGOV -= veAmount;

        l.active   = false;
        l.amount   = 0;
        l.veAmount = 0;
        l.unlockAt = 0;

        require(govToken.transfer(msg.sender, govAmount), "GOV transfer failed");

        emit Unlocked(msg.sender, govAmount, veAmount);
    }

    // ── View ───────────────────────────────────────────────────────────────────

    /// @notice veGOV balance of a user (0 if no active lock or expired)
    function veBalanceOf(address user) external view returns (uint256) {
        Lock storage l = locks[user];
        if (!l.active) return 0;
        return l.veAmount;
    }

    /// @notice Returns the user's lock details
    function lockOf(address user) external view returns (
        uint256 govLocked,
        uint256 veBalance,
        uint256 unlockAt,
        bool active
    ) {
        Lock storage l = locks[user];
        return (l.amount, l.veAmount, l.unlockAt, l.active);
    }

    /// @notice Time remaining on a user's lock (0 if expired or no lock)
    function timeRemaining(address user) external view returns (uint256) {
        Lock storage l = locks[user];
        if (!l.active || block.timestamp >= l.unlockAt) return 0;
        return l.unlockAt - block.timestamp;
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    function _multiplier(uint256 period) internal pure returns (uint256) {
        if (period == LOCK_24M) return MULTIPLIER_24M;
        if (period == LOCK_12M) return MULTIPLIER_12M;
        return MULTIPLIER_6M;
    }
}
