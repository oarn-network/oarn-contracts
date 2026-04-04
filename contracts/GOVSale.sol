// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GOVSale
 * @notice Public genesis sale for OARN Governance tokens.
 *
 * Flow:
 * 1. Owner calls GOVToken.executeGenesisDistribution(earlyContributors, address(this))
 *    — funds 30M GOV (30% of supply) into this contract.
 * 2. Investors call buyGOV{value: ethAmount}() to exchange ETH for GOV.
 * 3. Owner withdraws ETH proceeds via withdrawETH().
 *
 * Price is expressed as GOV tokens (18-decimal units) per 1 ETH.
 * Example: price = 10_000 * 1e18 means 1 ETH → 10,000 GOV.
 *
 * Per-wallet cap prevents whales from draining the pool.
 */
contract GOVSale is Ownable, ReentrancyGuard {

    // ── State ──────────────────────────────────────────────────────────────────

    IERC20 public immutable govToken;

    /// @notice GOV tokens (18-decimal units) received per 1 ETH
    uint256 public price;

    /// @notice Maximum GOV tokens a single wallet may purchase
    uint256 public walletCap;

    /// @notice Whether the sale is currently accepting purchases
    bool public paused;

    /// @notice GOV already purchased per address
    mapping(address => uint256) public purchased;

    // ── Events ─────────────────────────────────────────────────────────────────

    event GOVPurchased(address indexed buyer, uint256 ethAmount, uint256 govAmount);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event WalletCapUpdated(uint256 oldCap, uint256 newCap);
    event Paused(bool isPaused);
    event ETHWithdrawn(address indexed to, uint256 amount);
    event GOVRecovered(address indexed to, uint256 amount);

    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @param _govToken  Address of the deployed GOVToken contract
     * @param _price     GOV tokens (18-dec units) per 1 ETH.
     *                   Default: 10_000 * 1e18  →  1 ETH = 10,000 GOV
     * @param _walletCap Maximum GOV per wallet (18-dec units).
     *                   Default: 50_000 * 1e18
     */
    constructor(
        address _govToken,
        uint256 _price,
        uint256 _walletCap
    ) Ownable(msg.sender) {
        require(_govToken != address(0), "Invalid GOV token");
        require(_price > 0, "Price must be > 0");
        require(_walletCap > 0, "Wallet cap must be > 0");

        govToken  = IERC20(_govToken);
        price     = _price;
        walletCap = _walletCap;
    }

    // ── Core ───────────────────────────────────────────────────────────────────

    /**
     * @notice Purchase GOV tokens by sending ETH.
     * @dev    GOV received = msg.value * price / 1e18
     */
    function buyGOV() external payable nonReentrant {
        require(!paused, "Sale is paused");
        require(msg.value > 0, "Send ETH to buy GOV");

        uint256 govAmount = (msg.value * price) / 1 ether;
        require(govAmount > 0, "ETH amount too small");

        uint256 alreadyBought = purchased[msg.sender];
        require(alreadyBought + govAmount <= walletCap, "Exceeds wallet cap");

        uint256 available = govToken.balanceOf(address(this));
        require(govAmount <= available, "Not enough GOV in pool");

        purchased[msg.sender] = alreadyBought + govAmount;

        require(govToken.transfer(msg.sender, govAmount), "GOV transfer failed");

        emit GOVPurchased(msg.sender, msg.value, govAmount);
    }

    // ── View ───────────────────────────────────────────────────────────────────

    /// @notice GOV tokens remaining in the sale pool
    function remainingGOV() external view returns (uint256) {
        return govToken.balanceOf(address(this));
    }

    /// @notice GOV tokens this wallet can still purchase
    function remainingCap(address buyer) external view returns (uint256) {
        uint256 spent = purchased[buyer];
        return spent >= walletCap ? 0 : walletCap - spent;
    }

    /// @notice Preview how much GOV a given ETH amount buys
    function quoteGOV(uint256 ethAmount) external view returns (uint256) {
        return (ethAmount * price) / 1 ether;
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    function setPrice(uint256 _price) external onlyOwner {
        require(_price > 0, "Price must be > 0");
        emit PriceUpdated(price, _price);
        price = _price;
    }

    function setWalletCap(uint256 _walletCap) external onlyOwner {
        require(_walletCap > 0, "Cap must be > 0");
        emit WalletCapUpdated(walletCap, _walletCap);
        walletCap = _walletCap;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    /// @notice Withdraw all ETH proceeds to owner
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        emit ETHWithdrawn(msg.sender, balance);
        (bool ok, ) = msg.sender.call{value: balance}("");
        require(ok, "ETH transfer failed");
    }

    /// @notice Recover unsold GOV tokens back to owner (e.g. after sale ends)
    function recoverGOV() external onlyOwner {
        uint256 balance = govToken.balanceOf(address(this));
        require(balance > 0, "No GOV to recover");
        emit GOVRecovered(msg.sender, balance);
        require(govToken.transfer(msg.sender, balance), "GOV transfer failed");
    }

    receive() external payable {
        revert("Use buyGOV()");
    }
}
