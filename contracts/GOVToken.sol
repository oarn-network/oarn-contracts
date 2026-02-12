// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";

/**
 * @title GOVToken
 * @notice OARN Governance Token - fixed supply, used for voting
 * @dev Implements ERC20Votes for on-chain governance
 *
 * Distribution:
 * - 40% to early compute contributors (airdrop)
 * - 30% to public genesis sale
 * - 20% to DAO treasury (vesting)
 * - 10% to core contributors (4-year vesting)
 */
contract GOVToken is ERC20, ERC20Permit, ERC20Votes, Ownable {

    // Fixed total supply
    uint256 public constant TOTAL_SUPPLY = 100_000_000 ether; // 100M tokens

    // Distribution addresses
    address public immutable treasuryAddress;
    address public immutable teamVestingAddress;

    // Minting completed flag
    bool public mintingComplete;

    // ============ Events ============

    event GenesisDistribution(
        address indexed earlyContributors,
        address indexed publicSale,
        address indexed treasury,
        address teamVesting
    );

    // ============ Constructor ============

    constructor(
        address _treasury,
        address _teamVesting
    ) ERC20("OARN Governance Token", "GOV") ERC20Permit("OARN Governance Token") Ownable(msg.sender) {
        require(_treasury != address(0), "Invalid treasury");
        require(_teamVesting != address(0), "Invalid team vesting");

        treasuryAddress = _treasury;
        teamVestingAddress = _teamVesting;
    }

    // ============ Genesis Distribution ============

    /**
     * @notice Execute genesis token distribution (one-time only)
     * @param earlyContributors Address for early contributor airdrop (40%)
     * @param publicSale Address for public sale allocation (30%)
     */
    function executeGenesisDistribution(
        address earlyContributors,
        address publicSale
    ) external onlyOwner {
        require(!mintingComplete, "Minting already complete");
        require(earlyContributors != address(0), "Invalid early contributors address");
        require(publicSale != address(0), "Invalid public sale address");

        mintingComplete = true;

        // 40% to early compute contributors
        _mint(earlyContributors, (TOTAL_SUPPLY * 40) / 100);

        // 30% to public genesis sale
        _mint(publicSale, (TOTAL_SUPPLY * 30) / 100);

        // 20% to DAO treasury (vesting contract)
        _mint(treasuryAddress, (TOTAL_SUPPLY * 20) / 100);

        // 10% to core contributors (vesting contract)
        _mint(teamVestingAddress, (TOTAL_SUPPLY * 10) / 100);

        emit GenesisDistribution(earlyContributors, publicSale, treasuryAddress, teamVestingAddress);
    }

    // ============ ERC20Votes Overrides ============

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20, ERC20Votes) {
        super._update(from, to, amount);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    // ============ View Functions ============

    /**
     * @notice Get voting power with quadratic scaling
     * @dev Returns sqrt(balance) for quadratic voting
     */
    function getQuadraticVotingPower(address account) external view returns (uint256) {
        uint256 balance = balanceOf(account);
        return sqrt(balance);
    }

    /**
     * @notice Babylonian square root
     */
    function sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;

        uint256 z = (x + 1) / 2;
        uint256 y = x;

        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }

        return y;
    }
}
