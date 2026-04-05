// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @title ResultNFT
 * @notice IP-NFT minted to the task requester when consensus is reached on OARN.
 *
 * Each token encodes on-chain:
 *   - taskId, modelHash, resultHash (the winning consensus hash)
 *   - requester address, consensus node count, timestamp
 *   - optional WetLabOracle anchor (if physical validation was attached)
 *
 * Only the authorised minter (TaskRegistryV2) can call mintOnConsensus().
 * The owner can update the minter address (e.g. after a contract upgrade).
 */
contract ResultNFT is ERC721, Ownable {
    using Strings for uint256;
    using Strings for address;

    // ── State ──────────────────────────────────────────────────────────────────

    address public minter;

    uint256 private _nextTokenId;

    struct ResultMetadata {
        uint256 taskId;
        bytes32 modelHash;
        bytes32 resultHash;
        address requester;
        uint256 consensusNodes;
        uint256 timestamp;
        bool wetLabAnchored;
    }

    mapping(uint256 => ResultMetadata) public metadata;

    // ── Events ─────────────────────────────────────────────────────────────────

    event ResultNFTMinted(
        uint256 indexed tokenId,
        uint256 indexed taskId,
        address indexed requester,
        bytes32 resultHash
    );

    event MinterUpdated(address indexed oldMinter, address indexed newMinter);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _minter) ERC721("OARN Research Result", "OARN-RES") Ownable(msg.sender) {
        require(_minter != address(0), "Invalid minter");
        minter = _minter;
    }

    // ── Minting ────────────────────────────────────────────────────────────────

    /**
     * @notice Mint a Result NFT to the task requester.
     * @dev Called by TaskRegistryV2 after consensus is reached.
     */
    function mintOnConsensus(
        uint256 taskId,
        bytes32 modelHash,
        bytes32 resultHash,
        address requester,
        uint256 consensusNodes,
        bool wetLabAnchored
    ) external returns (uint256 tokenId) {
        require(msg.sender == minter, "Not authorised minter");
        require(requester != address(0), "Invalid requester");

        _nextTokenId++;
        tokenId = _nextTokenId;

        metadata[tokenId] = ResultMetadata({
            taskId: taskId,
            modelHash: modelHash,
            resultHash: resultHash,
            requester: requester,
            consensusNodes: consensusNodes,
            timestamp: block.timestamp,
            wetLabAnchored: wetLabAnchored
        });

        _mint(requester, tokenId);

        emit ResultNFTMinted(tokenId, taskId, requester, resultHash);
    }

    // ── Metadata ───────────────────────────────────────────────────────────────

    /**
     * @notice On-chain SVG + JSON metadata — no off-chain dependency.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        ResultMetadata memory m = metadata[tokenId];

        string memory tier = m.wetLabAnchored ? "WetLab Anchored" : "Computational";

        string memory svg = string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">',
            '<rect width="400" height="400" fill="#0f0f1a"/>',
            '<text x="20" y="40" font-family="monospace" font-size="14" fill="#6366f1">OARN Research Result</text>',
            '<text x="20" y="70" font-family="monospace" font-size="11" fill="#a5b4fc">Task #', m.taskId.toString(), '</text>',
            '<text x="20" y="95" font-family="monospace" font-size="9" fill="#64748b">Result: ', _bytes32ToHex(m.resultHash), '</text>',
            '<text x="20" y="115" font-family="monospace" font-size="9" fill="#64748b">Model:  ', _bytes32ToHex(m.modelHash), '</text>',
            '<text x="20" y="140" font-family="monospace" font-size="11" fill="#22d3ee">Nodes: ', m.consensusNodes.toString(), '</text>',
            '<text x="20" y="165" font-family="monospace" font-size="11" fill="#22c55e">Tier: ', tier, '</text>',
            '</svg>'
        ));

        string memory json = Base64.encode(bytes(string(abi.encodePacked(
            '{"name":"OARN Result #', tokenId.toString(), '",',
            '"description":"On-chain research result IP-NFT from the OARN decentralized AI compute network.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '",',
            '"attributes":[',
            '{"trait_type":"Task ID","value":', m.taskId.toString(), '},',
            '{"trait_type":"Consensus Nodes","value":', m.consensusNodes.toString(), '},',
            '{"trait_type":"Tier","value":"', tier, '"},',
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

    function _bytes32ToHex(bytes32 b) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory str = new bytes(10); // "0x" + first 4 bytes
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 4; i++) {
            str[2 + i * 2] = hexChars[uint8(b[i]) >> 4];
            str[3 + i * 2] = hexChars[uint8(b[i]) & 0x0f];
        }
        return string(str);
    }
}
