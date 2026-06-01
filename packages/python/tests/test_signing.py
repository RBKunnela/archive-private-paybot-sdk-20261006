"""Tests for EIP-3009 TransferWithAuthorization signing in `PayBotClient._sign_payload`.

Covers, per Quality Foundation (>=3 per function — happy / error / edge):
- happy path: signed blob has the exact TS wire shape + a 0x-prefixed 65-byte sig
- recovery round-trip: the signer address recovers from the typed-data + signature
- error: unsupported network raises ValueError
- error: missing wallet key raises ValueError
- edge: deterministic structure given a fixed nonce (only `nonce`/`signature` vary
  between two calls with the same inputs)
"""
from __future__ import annotations

import json

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from paybot_sdk import PayBotClient, PayBotConfig
from paybot_sdk.networks import EIP3009_TYPES, EIP712_DOMAINS
from paybot_sdk.types import PaymentRequest

# Well-known throwaway test key (NOT a real wallet — deterministic across runs).
TEST_PRIVATE_KEY = "0x" + "1" * 64
TEST_ADDRESS = Account.from_key(TEST_PRIVATE_KEY).address
PAY_TO = "0x000000000000000000000000000000000000dEaD"
NETWORK = "eip155:84532"


def _make_client(private_key: str | None = TEST_PRIVATE_KEY) -> PayBotClient:
    return PayBotClient(
        PayBotConfig(api_key="pb_test", bot_id="bot-1", wallet_private_key=private_key)
    )


def _request() -> PaymentRequest:
    return PaymentRequest(resource="https://x.example/y", amount="0.05", pay_to=PAY_TO)


# ── happy path ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sign_payload_produces_ts_wire_shape():
    client = _make_client()
    raw = await client._sign_payload(
        request=_request(),
        amount_base_units="50000",
        token_contract=EIP712_DOMAINS[NETWORK]["verifyingContract"],
        network_id=NETWORK,
    )
    blob = json.loads(raw)
    # Same keys + stringified numeric fields as client.ts:buildPaymentPayload.
    assert set(blob.keys()) == {
        "from", "to", "value", "validAfter", "validBefore", "nonce", "signature",
    }
    assert blob["from"] == TEST_ADDRESS
    assert blob["to"] == PAY_TO
    assert blob["value"] == "50000"  # string, not int
    assert blob["validAfter"] == "0"
    assert int(blob["validBefore"]) > 0
    assert blob["nonce"].startswith("0x") and len(blob["nonce"]) == 66
    # 0x + 130 hex chars = 65-byte signature, matching viem's output.
    assert blob["signature"].startswith("0x")
    assert len(blob["signature"]) == 132
    await client.close()


# ── recovery round-trip (address recovers from signature) ─────────────────


@pytest.mark.asyncio
async def test_sign_payload_signature_recovers_signer():
    client = _make_client()
    raw = await client._sign_payload(
        request=_request(),
        amount_base_units="50000",
        token_contract=EIP712_DOMAINS[NETWORK]["verifyingContract"],
        network_id=NETWORK,
    )
    blob = json.loads(raw)
    message = {
        "from": blob["from"],
        "to": blob["to"],
        "value": int(blob["value"]),
        "validAfter": int(blob["validAfter"]),
        "validBefore": int(blob["validBefore"]),
        "nonce": blob["nonce"],
    }
    encoded = encode_typed_data(EIP712_DOMAINS[NETWORK], EIP3009_TYPES, message)
    recovered = Account.recover_message(encoded, signature=blob["signature"])
    assert recovered.lower() == TEST_ADDRESS.lower()
    await client.close()


# ── error: unsupported network ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sign_payload_unsupported_network_raises():
    client = _make_client()
    with pytest.raises(ValueError, match="No EIP-712 domain"):
        await client._sign_payload(
            request=_request(),
            amount_base_units="50000",
            token_contract="0xabc",
            network_id="eip155:1",  # no registered domain
        )
    await client.close()


# ── error: missing wallet key ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sign_payload_without_wallet_key_raises():
    client = _make_client(private_key=None)
    with pytest.raises(ValueError, match="wallet_private_key"):
        await client._sign_payload(
            request=_request(),
            amount_base_units="50000",
            token_contract=EIP712_DOMAINS[NETWORK]["verifyingContract"],
            network_id=NETWORK,
        )
    await client.close()


# ── edge: structure deterministic given a fixed nonce ─────────────────────


@pytest.mark.asyncio
async def test_sign_payload_deterministic_structure_given_nonce(monkeypatch):
    """With nonce + clock pinned, two signings of the same inputs are byte
    identical — proving signing is a pure function of (message, key)."""
    fixed_nonce = "0x" + "ab" * 32
    monkeypatch.setattr("paybot_sdk.client.generate_eip3009_nonce", lambda: fixed_nonce)
    monkeypatch.setattr("paybot_sdk.client.time.time", lambda: 1_700_000_000)

    client = _make_client()
    args = dict(
        request=_request(),
        amount_base_units="50000",
        token_contract=EIP712_DOMAINS[NETWORK]["verifyingContract"],
        network_id=NETWORK,
    )
    first = json.loads(await client._sign_payload(**args))
    second = json.loads(await client._sign_payload(**args))

    assert first == second  # fully deterministic
    assert first["nonce"] == fixed_nonce
    assert first["validBefore"] == str(1_700_000_000 + 3600)
    await client.close()
