// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @title ReproducibilitySBT
 * @notice Soulbound Token awarded to each node that contributed a consensus-matching
 *         result on OARN. Non-transferable — permanently attached to the node address.
 *
 * Tiers:
 *   1 — Standard    : N-node computational consensus reached
 *   2 — WetLab Anchored : Computational consensus + WetLabOracle physical validation
 *
 * Only the authorised minter (TaskRegistryV2) can call mintToNode().
 * Citable in research papers as proof of reproducibility.
 */
contract ReproducibilitySBT is ERC721, Ownable {
    using Strings for uint256;

    // ── Enums ──────────────────────────────────────────────────────────────────

    enum Tier { Standard, WetLabAnchored }

    // ── State ──────────────────────────────────────────────────────────────────

    address public minter;

    uint256 private _nextTokenId;

    struct SBTMetadata {
        uint256 taskId;
        bytes32 resultHash;
        address node;
        Tier tier;
        uint256 timestamp;
    }

    mapping(uint256 => SBTMetadata) public metadata;

    /// @notice All SBT token IDs earned by a node address
    mapping(address => uint256[]) public nodeTokens;

    // ── Events ─────────────────────────────────────────────────────────────────

    event SBTMinted(
        uint256 indexed tokenId,
        uint256 indexed taskId,
        address indexed node,
        Tier tier
    );

    event MinterUpdated(address indexed oldMinter, address indexed newMinter);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _minter) ERC721("OARN Reproducibility", "OARN-REP") Ownable(msg.sender) {
        require(_minter != address(0), "Invalid minter");
        minter = _minter;
    }

    // ── Soulbound: block all transfers ─────────────────────────────────────────

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        // Allow minting (from == address(0)) but block all transfers and burns
        require(from == address(0), "SBT: non-transferable");
        return super._update(to, tokenId, auth);
    }

    // ── Minting ────────────────────────────────────────────────────────────────

    /**
     * @notice Mint a Reproducibility SBT to a consensus-matching node.
     * @dev Called by TaskRegistryV2 for each node that matched consensus.
     * @param taskId    The completed task
     * @param resultHash The consensus-winning result hash
     * @param node      The node address to award the SBT to
     * @param wetLabAnchored  Whether WetLabOracle also validated the result
     */
    function mintToNode(
        uint256 taskId,
        bytes32 resultHash,
        address node,
        bool wetLabAnchored
    ) external returns (uint256 tokenId) {
        require(msg.sender == minter, "Not authorised minter");
        require(node != address(0), "Invalid node");

        _nextTokenId++;
        tokenId = _nextTokenId;

        Tier tier = wetLabAnchored ? Tier.WetLabAnchored : Tier.Standard;

        metadata[tokenId] = SBTMetadata({
            taskId: taskId,
            resultHash: resultHash,
            node: node,
            tier: tier,
            timestamp: block.timestamp
        });

        nodeTokens[node].push(tokenId);

        _mint(node, tokenId);

        emit SBTMinted(tokenId, taskId, node, tier);
    }

    // ── View ───────────────────────────────────────────────────────────────────

    /// @notice Total SBTs earned by a node
    function balanceOfNode(address node) external view returns (uint256) {
        return nodeTokens[node].length;
    }

    /// @notice All token IDs earned by a node
    function tokensOfNode(address node) external view returns (uint256[] memory) {
        return nodeTokens[node];
    }

    // ── Metadata ───────────────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        SBTMetadata memory m = metadata[tokenId];

        string memory tierLabel = m.tier == Tier.WetLabAnchored ? "WetLab Anchored" : "Standard";
        string memory tierColor = m.tier == Tier.WetLabAnchored ? "#22d3ee" : "#6366f1";

        string memory svg = string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">',
            '<rect width="400" height="400" fill="#0f0f1a"/>',
            '<text x="20" y="40" font-family="monospace" font-size="14" fill="', tierColor, '">OARN Reproducibility SBT</text>',
            '<text x="20" y="70" font-family="monospace" font-size="11" fill="#a5b4fc">Task #', m.taskId.toString(), '</text>',
            '<text x="20" y="95" font-family="monospace" font-size="9" fill="#64748b">Result: 0x', _shortHex(m.resultHash), '</text>',
            '<text x="20" y="120" font-family="monospace" font-size="11" fill="', tierColor, '">Tier: ', tierLabel, '</text>',
            '<text x="20" y="145" font-family="monospace" font-size="9" fill="#64748b">Soulbound - non-transferable</text>',
            '</svg>'
        ));

        string memory json = Base64.encode(bytes(string(abi.encodePacked(
            '{"name":"OARN Reproducibility #', tokenId.toString(), '",',
            '"description":"Soulbound proof of reproducibility contribution on the OARN network. Non-transferable.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '",',
            '"attributes":[',
            '{"trait_type":"Task ID","value":', m.taskId.toString(), '},',
            '{"trait_type":"Tier","value":"', tierLabel, '"},',
            '{"trait_type":"Transferable","value":"No"},',
            '{"trait_type":"Timestamp","value":', m.timestamp.toString(), '}',
            ']}'
        ))));

        return string(abi.encodePacked("data:application/json;base64,", json));
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    function setMinter(address _minter) external onlyOwner {
        require(_minter != address(0), "Invalid minter");
        emit MinterUpdated(minter, _minter);
        minter = _minter;
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    function _shortHex(bytes32 b) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory str = new bytes(8);
        for (uint256 i = 0; i < 4; i++) {
            str[i * 2]     = hexChars[uint8(b[i]) >> 4];
            str[i * 2 + 1] = hexChars[uint8(b[i]) & 0x0f];
        }
        return string(str);
    }
}
