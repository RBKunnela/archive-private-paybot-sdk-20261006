"""Network configurations for paybot-sdk Python port.

Mirrors `src/networks.ts` byte-for-byte on the configuration values
(chain ids, USDC addresses, RPC URLs, EIP-712 domains, EIP-3009 types).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict


@dataclass(frozen=True)
class NetworkConfig:
    name: str
    chain_id: int
    caip2: str
    rpc_url: str
    usdc_address: str
    explorer_url: str
    is_testnet: bool


NETWORKS: Dict[str, NetworkConfig] = {
    "eip155:8453": NetworkConfig(
        name="Base Mainnet",
        chain_id=8453,
        caip2="eip155:8453",
        rpc_url="https://mainnet.base.org",
        usdc_address="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        explorer_url="https://basescan.org",
        is_testnet=False,
    ),
    "eip155:84532": NetworkConfig(
        name="Base Sepolia",
        chain_id=84532,
        caip2="eip155:84532",
        rpc_url="https://sepolia.base.org",
        usdc_address="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        explorer_url="https://sepolia.basescan.org",
        is_testnet=True,
    ),
}


USDC_CONFIG = {
    "name": "USDC",
    "version": "2",
    "decimals": 6,
}


# EIP-712 domain templates per network. The verifying contract is the
# USDC contract on that network (matches `EIP712_DOMAINS` in networks.ts).
EIP712_DOMAINS: Dict[str, Dict] = {
    "eip155:8453": {
        "name": "USDC",
        "version": "2",
        "chainId": 8453,
        "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    "eip155:84532": {
        "name": "USDC",
        "version": "2",
        "chainId": 84532,
        "verifyingContract": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
}


# EIP-3009 TransferWithAuthorization typed-data structure.
EIP3009_TYPES = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ],
}
