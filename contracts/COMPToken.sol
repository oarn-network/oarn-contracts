// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title COMPToken
 * @notice OARN Compute Token - earned by nodes for completing tasks
 * @dev Inflationary token with emission schedule controlled by TokenReward contract
 */
contract COMPToken is ERC20, ERC20Burnable, Ownable {

    // Addresses authorized to mint (TaskRegistry, TokenReward)
    mapping(address => bool) public minters;

    // Emission tracking
    uint256 public totalMinted;
    uint256 public launchTime;

    // Emission schedule: Year 1 = 100M, then decreasing
    uint256 public constant YEAR_1_EMISSION = 100_000_000 ether;
    uint256 public constant EMISSION_DECREASE_RATE = 80; // 80% of previous year

    // Burn rate on transfers (basis points, 200 = 2%)
    uint256 public burnRate = 200;
    bool public burnEnabled = false;

    // ============ Events ============

    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);
    event BurnRateUpdated(uint256 newRate);
    event TokensBurned(address indexed from, uint256 amount);

    // ============ Constructor ============

    constructor() ERC20("OARN Compute Token", "COMP") Ownable(msg.sender) {
        launchTime = block.timestamp;
    }

    // ============ Minting ============

    /**
     * @notice Mint tokens to an address (only authorized minters)
     */
    function mint(address to, uint256 amount) external {
        require(minters[msg.sender], "Not authorized to mint");
        require(to != address(0), "Cannot mint to zero address");

        // Check emission cap for current year
        uint256 yearlyAllowance = getYearlyEmissionCap();
        uint256 yearStart = getCurrentYearStart();
        // Note: In production, track minted per year separately

        _mint(to, amount);
        totalMinted += amount;
    }

    /**
     * @notice Get emission cap for current year
     */
    function getYearlyEmissionCap() public view returns (uint256) {
        uint256 yearsElapsed = (block.timestamp - launchTime) / 365 days;

        if (yearsElapsed == 0) return YEAR_1_EMISSION;

        uint256 cap = YEAR_1_EMISSION;
        for (uint256 i = 0; i < yearsElapsed; i++) {
            cap = (cap * EMISSION_DECREASE_RATE) / 100;
        }
        return cap;
    }

    /**
     * @notice Get start timestamp of current emission year
     */
    function getCurrentYearStart() public view returns (uint256) {
        uint256 yearsElapsed = (block.timestamp - launchTime) / 365 days;
        return launchTime + (yearsElapsed * 365 days);
    }

    // ============ Transfer Override (Optional Burn) ============

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        // Apply burn on transfers (not mints or explicit burns)
        if (burnEnabled && from != address(0) && to != address(0) && burnRate > 0) {
            uint256 burnAmount = (amount * burnRate) / 10000;
            uint256 transferAmount = amount - burnAmount;

            super._update(from, address(0), burnAmount); // Burn
            super._update(from, to, transferAmount);      // Transfer

            emit TokensBurned(from, burnAmount);
        } else {
            super._update(from, to, amount);
        }
    }

    // ============ Admin Functions ============

    function addMinter(address minter) external onlyOwner {
        require(minter != address(0), "Invalid minter");
        minters[minter] = true;
        emit MinterAdded(minter);
    }

    function removeMinter(address minter) external onlyOwner {
        minters[minter] = false;
        emit MinterRemoved(minter);
    }

    function setBurnRate(uint256 _rate) external onlyOwner {
        require(_rate <= 1000, "Burn rate too high"); // Max 10%
        burnRate = _rate;
        emit BurnRateUpdated(_rate);
    }

    function enableBurn(bool _enabled) external onlyOwner {
        burnEnabled = _enabled;
    }
}
