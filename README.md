# OARN Smart Contracts

Solidity smart contracts for the Open AI Research Network (OARN) deployed on Arbitrum.

## Contracts

| Contract | Description |
|----------|-------------|
| `OARNRegistry.sol` | Decentralized discovery registry - single entry point for all infrastructure |
| `TaskRegistry.sol` | Task submission, claiming, and result management |
| `COMPToken.sol` | Compute token (ERC-20) - earned by nodes for completing tasks |
| `GOVToken.sol` | Governance token (ERC-20 + Votes) - used for DAO voting |

## Architecture

```
                    ┌─────────────────┐
                    │  OARNRegistry   │ ◄── Entry point (via ENS: oarn-registry.eth)
                    │  (Immutable)    │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  TaskRegistry   │ │   COMPToken     │ │   GOVToken      │
│  (Upgradeable)  │ │   (Rewards)     │ │  (Governance)   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

## Setup

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env
# Edit .env with your private key and API keys

# Compile contracts
npm run compile

# Run tests
npm test

# Run with coverage
npm run coverage
```

## Deployment

### Local (Hardhat Network)

```bash
# Start local node
npx hardhat node

# Deploy (in another terminal)
npm run deploy:local
```

### Arbitrum Sepolia (Testnet)

```bash
# Ensure .env has PRIVATE_KEY and optionally ARBITRUM_SEPOLIA_RPC
npm run deploy:sepolia

# Verify contracts
npx hardhat verify --network arbitrumSepolia <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS>
```

### Arbitrum One (Mainnet)

```bash
# CAUTION: This deploys to mainnet with real funds
npm run deploy:mainnet
```

## Contract Addresses

After deployment, addresses are saved to `deployment-addresses.json`.

### Testnet (Arbitrum Sepolia)

| Contract | Address |
|----------|---------|
| OARNRegistry | `TBD` |
| TaskRegistry | `TBD` |
| COMPToken | `TBD` |
| GOVToken | `TBD` |

## Key Features

### Zero Hardcoded Values

Clients discover ALL infrastructure through OARNRegistry:

```solidity
// Get core contracts
(taskRegistry, tokenReward, validatorRegistry, governance, govToken) = registry.getCoreContracts();

// Get RPC providers (no hardcoded URLs!)
RPCProvider[] memory providers = registry.getActiveRPCProviders();

// Get bootstrap nodes (no hardcoded peer IDs!)
BootstrapNode[] memory nodes = registry.getActiveBootstrapNodes();
```

### Staking & Slashing

- RPC Providers: 5,000 GOV minimum stake
- Bootstrap Nodes: 1,000 GOV minimum stake
- 7-day unstaking cooldown
- Slashing for downtime/misbehavior

### Task Lifecycle

1. **Submit**: Requester deposits COMP and creates task
2. **Claim**: Nodes claim tasks they can process
3. **Execute**: Nodes run inference and upload results to IPFS
4. **Submit Result**: Nodes submit result hash on-chain
5. **Complete**: When required nodes submit, rewards distribute automatically

## Security

- OpenZeppelin contracts for access control and reentrancy protection
- Emergency pause functionality
- Timelock for admin operations
- OARNRegistry is non-upgradeable (immutable core addresses)

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npx hardhat test test/TaskRegistry.test.ts

# Run with gas reporting
REPORT_GAS=true npm test

# Generate coverage report
npm run coverage
```

## License

MIT License - see [LICENSE](./LICENSE)
