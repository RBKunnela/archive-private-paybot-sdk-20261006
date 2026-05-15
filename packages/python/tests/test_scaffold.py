"""Scaffold-level tests for the Python port.

Covers what the scaffold can claim:
- Type surface constructible
- Client __init__ validation
- Helper math (`_to_base_units`)
- Nonce shape
- Networks parity with `src/networks.ts`

End-to-end tests against the live facilitator land in PR-2.
"""
from __future__ import annotations

import pytest

from paybot_sdk import (
    NETWORKS,
    PayBotClient,
    PayBotConfig,
    PaymentRequest,
    PaymentResult,
)
from paybot_sdk.crypto import generate_eip3009_nonce


# ── Types are constructible ──────────────────────────────────────────────


def test_config_min_construction():
    cfg = PayBotConfig(api_key="pb_test_x", bot_id="my-bot")
    assert cfg.api_key == "pb_test_x"
    assert cfg.bot_id == "my-bot"
    assert cfg.facilitator_url is None  # default applied in client init
    assert cfg.max_retries == 1
    assert cfg.timeout_ms == 30_000


def test_payment_request_construction():
    req = PaymentRequest(resource="https://api.example.com/x", amount="0.05", pay_to="0xabc")
    assert req.amount == "0.05"
    assert req.network is None


# ── Client init validation ───────────────────────────────────────────────


def test_client_requires_api_key():
    with pytest.raises(ValueError, match="api_key"):
        PayBotClient(PayBotConfig(api_key="", bot_id="x"))


def test_client_requires_bot_id():
    with pytest.raises(ValueError, match="bot_id"):
        PayBotClient(PayBotConfig(api_key="pb_test", bot_id=""))


def test_client_rejects_invalid_facilitator_url():
    with pytest.raises(ValueError, match="facilitator_url"):
        PayBotClient(PayBotConfig(api_key="pb_test", bot_id="x", facilitator_url="not-a-url"))


def test_client_rejects_non_0x_private_key():
    with pytest.raises(ValueError, match="0x"):
        PayBotClient(
            PayBotConfig(api_key="pb_test", bot_id="x", wallet_private_key="abc")
        )


def test_client_accepts_https_facilitator_url():
    client = PayBotClient(
        PayBotConfig(api_key="pb_test", bot_id="x", facilitator_url="https://example.com")
    )
    assert client._facilitator_url == "https://example.com"


def test_client_applies_default_facilitator_url():
    client = PayBotClient(PayBotConfig(api_key="pb_test", bot_id="x"))
    assert client._facilitator_url == "https://api.paybotcore.com"


# ── _to_base_units corner cases ──────────────────────────────────────────


@pytest.mark.parametrize(
    ("human", "decimals", "expected"),
    [
        ("0", 6, "0"),
        ("0.0", 6, "0"),
        ("1", 6, "1000000"),
        ("0.05", 6, "50000"),
        ("0.000001", 6, "1"),
        ("123.456789", 6, "123456789"),
        ("0.1234567890", 6, "123456"),  # truncate beyond decimals
    ],
)
def test_to_base_units(human: str, decimals: int, expected: str):
    assert PayBotClient._to_base_units(human, decimals) == expected


# ── Nonce shape ──────────────────────────────────────────────────────────


def test_eip3009_nonce_shape():
    nonce = generate_eip3009_nonce()
    assert nonce.startswith("0x")
    assert len(nonce) == 66  # 0x + 64 hex chars = 32 bytes


def test_eip3009_nonce_is_unique():
    a = generate_eip3009_nonce()
    b = generate_eip3009_nonce()
    assert a != b


# ── Networks parity with src/networks.ts ─────────────────────────────────


def test_base_mainnet_present():
    n = NETWORKS["eip155:8453"]
    assert n.chain_id == 8453
    assert n.usdc_address == "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    assert not n.is_testnet


def test_base_sepolia_present():
    n = NETWORKS["eip155:84532"]
    assert n.chain_id == 84532
    assert n.usdc_address == "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    assert n.is_testnet


# ── pay() scaffold-guard returns sane error in real-mode ─────────────────


@pytest.mark.asyncio
async def test_pay_real_mode_returns_scaffold_error(monkeypatch):
    """Real-mode pay() must surface the scaffold gap as a structured error,
    not crash. PR-2 swaps `_sign_payload` for the real signing path."""
    client = PayBotClient(
        PayBotConfig(
            api_key="pb_test",
            bot_id="x",
            wallet_private_key="0x" + "1" * 64,
        )
    )
    result = await client.pay(
        PaymentRequest(resource="https://x.example/y", amount="0.01", pay_to="0xabc")
    )
    assert isinstance(result, PaymentResult)
    assert result.success is False
    assert result.error_code == "NOT_IMPLEMENTED_SCAFFOLD"
