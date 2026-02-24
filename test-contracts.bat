@echo off
set PATH=C:\Program Files\nodejs;%PATH%
cd /d C:\Users\flori\Documents\oarn-network\oarn-contracts
echo Testing OARN Contracts on Arbitrum Sepolia...
node scripts/test-contracts.js
