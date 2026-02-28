// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";

/**
 * @title OARNGovernance
 * @notice Governance contract for OARN Network using GOV tokens
 * @dev Uses OpenZeppelin Governor with quadratic voting option
 *
 * Features:
 * - Create proposals for network changes
 * - Vote using GOV tokens (1 token = 1 vote)
 * - 4% quorum requirement
 * - 1 day voting delay, 1 week voting period
 */
contract OARNGovernance is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction
{
    // ============ Events ============

    event ProposalCreatedWithDescription(
        uint256 indexed proposalId,
        address indexed proposer,
        string title,
        string description
    );

    // ============ Storage ============

    // Proposal metadata (title, description)
    mapping(uint256 => string) public proposalTitles;
    mapping(uint256 => string) public proposalDescriptions;

    // Track all proposal IDs for enumeration
    uint256[] public allProposalIds;
    mapping(uint256 => bool) public proposalExists;

    // ============ Constructor ============

    constructor(IVotes _token)
        Governor("OARN Governance")
        GovernorSettings(
            7200,       // 1 day voting delay (7200 blocks @ 12s)
            50400,      // 1 week voting period (50400 blocks @ 12s)
            1000 ether  // 1000 GOV tokens to propose
        )
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(4) // 4% quorum
    {}

    // ============ Proposal Functions ============

    /**
     * @notice Create a proposal with title and description
     * @param targets Contract addresses to call
     * @param values ETH values to send
     * @param calldatas Function calls to execute
     * @param title Short title for the proposal
     * @param description Detailed description
     */
    function proposeWithMetadata(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory title,
        string memory description
    ) public returns (uint256) {
        // Create the proposal using standard propose
        uint256 proposalId = propose(targets, values, calldatas, description);

        // Store metadata
        proposalTitles[proposalId] = title;
        proposalDescriptions[proposalId] = description;

        // Track proposal
        if (!proposalExists[proposalId]) {
            allProposalIds.push(proposalId);
            proposalExists[proposalId] = true;
        }

        emit ProposalCreatedWithDescription(proposalId, msg.sender, title, description);

        return proposalId;
    }

    /**
     * @notice Get total number of proposals
     */
    function proposalCount() public view returns (uint256) {
        return allProposalIds.length;
    }

    /**
     * @notice Get proposal ID by index
     */
    function getProposalId(uint256 index) public view returns (uint256) {
        require(index < allProposalIds.length, "Index out of bounds");
        return allProposalIds[index];
    }

    /**
     * @notice Get proposal summary
     */
    function getProposalSummary(uint256 proposalId) public view returns (
        string memory title,
        string memory description,
        address proposer,
        uint256 startBlock,
        uint256 endBlock,
        uint8 status,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes
    ) {
        title = proposalTitles[proposalId];
        description = proposalDescriptions[proposalId];
        proposer = proposalProposer(proposalId);
        startBlock = proposalSnapshot(proposalId);
        endBlock = proposalDeadline(proposalId);
        status = uint8(state(proposalId));
        (againstVotes, forVotes, abstainVotes) = proposalVotes(proposalId);
    }

    // ============ Required Overrides ============

    function votingDelay()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    function votingPeriod()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    function quorum(uint256 blockNumber)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }
}
