"""Cryptographic helpers. Mirrors `src/crypto.ts`."""
from __future__ import annotations

import secrets


def generate_eip3009_nonce() -> str:
    """Generate a random bytes32 nonce for EIP-3009 (32 bytes hex-encoded, 0x-prefixed)."""
    return "0x" + secrets.token_hex(32)
