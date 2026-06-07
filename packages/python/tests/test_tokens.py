"""Tests for the multi-token registry + EIP-712 domain resolution.

Mirrors tests/tokens.test.ts. The EURC mainnet address is operator-private and
intentionally absent from the public registry (boundary cases below).
"""
from __future__ import annotations

import json

import pytest
import respx
from httpx import Response

from paybot_sdk import PayBotClient, PayBotConfig, PaymentRequest
from paybot_sdk.errors import PayBotUnsupportedSigningMethodError
from paybot_sdk.networks import (
    EIP712_DOMAINS,
    NETWORKS,
    USDC_CONFIG,
    TokenConfig,
    get_eip712_domain,
    get_supported_tokens,
    get_token,
    get_token_address,
    resolve_token_address,
)

EURC_BASE_SEPOLIA = "0x808456652fdb597867f38412077A9182bf77359F"
# Stand-in for an operator-injected EURC mainnet address. The literal Circle EURC
# mainnet address must NEVER appear in this public repo (open-core boundary).
EURC_MAINNET_OVERRIDE = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01"
USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"


# ── registry ──────────────────────────────────────────────────────────────


def test_registry_includes_usdc_and_eurc():
    tokens = get_supported_tokens()
    assert "USDC" in tokens
    assert "EURC" in tokens


def test_usdc_config_back_compat():
    assert USDC_CONFIG["symbol"] == "USDC"
    assert USDC_CONFIG["decimals"] == 6


def test_get_token_happy_usdc_eurc():
    usdc = get_token("USDC")
    assert usdc.symbol == "USDC" and usdc.decimals == 6 and usdc.name == "USD Coin"
    assert usdc.signing_method == "eip3009"
    eurc = get_token("EURC")
    assert eurc.symbol == "EURC" and eurc.signing_method == "eip3009"


def test_get_token_unknown_returns_none():
    assert get_token("DOGE") is None
    assert get_token("") is None


def test_registry_carries_signing_method_and_version():
    # Phase-4 reconciliation: the registry is TS-faithful (src/networks.ts) =
    # USDC/EURC/DAI only, no PYUSD/RLUSD, and DAI is signable (eip3009) under its
    # own "Dai Stablecoin" domain — TS has no eip2612 rejection concept. The
    # signing_method + eip712_version fields are retained for the #11 guard.
    assert get_token("PYUSD") is None
    assert get_token("RLUSD") is None
    assert get_token("USDC").signing_method == "eip3009"
    assert get_token("EURC").signing_method == "eip3009"
    assert get_token("DAI").signing_method == "eip3009"
    assert get_token("DAI").decimals == 18
    assert get_token("DAI").eip712_name == "Dai Stablecoin"
    assert get_token("USDC").eip712_version == "2"


# ── get_token_address ─────────────────────────────────────────────────────


def test_get_token_address_usdc_per_network():
    assert get_token_address("USDC", "eip155:8453") == USDC_BASE_MAINNET
    assert get_token_address("USDC", "eip155:84532") == USDC_BASE_SEPOLIA
    # Must not diverge from the network config's usdc_address.
    assert get_token_address("USDC", "eip155:8453") == NETWORKS["eip155:8453"].usdc_address


def test_get_token_address_eurc_testnet():
    assert get_token_address("EURC", "eip155:84532") == EURC_BASE_SEPOLIA


def test_get_token_address_eurc_mainnet_absent():
    # boundary: EURC mainnet is operator-private and intentionally absent.
    assert get_token_address("EURC", "eip155:8453") is None


def test_get_token_address_unknown_and_unsupported_network():
    assert get_token_address("DOGE", "eip155:8453") is None
    assert get_token_address("USDC", "eip155:1") is None


# ── resolve_token_address (operator override layer) ──────────────────────


def test_resolve_falls_back_to_public_registry():
    assert resolve_token_address("USDC", "eip155:8453") == USDC_BASE_MAINNET
    assert resolve_token_address("EURC", "eip155:84532") == EURC_BASE_SEPOLIA


def test_resolve_eurc_mainnet_none_without_override():
    assert resolve_token_address("EURC", "eip155:8453") is None


def test_resolve_eurc_mainnet_via_override():
    overrides = {"EURC": {"eip155:8453": EURC_MAINNET_OVERRIDE}}
    assert resolve_token_address("EURC", "eip155:8453", overrides) == EURC_MAINNET_OVERRIDE


def test_resolve_override_precedence_and_isolation():
    overrides = {"USDC": {"eip155:8453": EURC_MAINNET_OVERRIDE}}
    assert resolve_token_address("USDC", "eip155:8453", overrides) == EURC_MAINNET_OVERRIDE
    # Unrelated overrides don't affect other tokens/networks.
    overrides2 = {"EURC": {"eip155:8453": EURC_MAINNET_OVERRIDE}}
    assert resolve_token_address("USDC", "eip155:8453", overrides2) == USDC_BASE_MAINNET
    assert resolve_token_address("EURC", "eip155:84532", overrides2) == EURC_BASE_SEPOLIA


# ── get_eip712_domain ─────────────────────────────────────────────────────


def test_eip712_usdc_regression_byte_identical():
    domain = get_eip712_domain("eip155:8453", "USDC")
    assert domain == EIP712_DOMAINS["eip155:8453"]
    assert domain == {
        "name": "USDC",
        "version": "2",
        "chainId": 8453,
        "verifyingContract": USDC_BASE_MAINNET,
    }
    assert get_eip712_domain("eip155:84532", "USDC") == EIP712_DOMAINS["eip155:84532"]


def test_eip712_defaults_to_usdc():
    assert get_eip712_domain("eip155:8453") == EIP712_DOMAINS["eip155:8453"]


def test_eip712_eurc_distinct_from_usdc():
    usdc = get_eip712_domain("eip155:84532", "USDC")
    eurc = get_eip712_domain("eip155:84532", "EURC")
    assert eurc["name"] == "EURC"
    assert eurc["verifyingContract"] == EURC_BASE_SEPOLIA
    assert eurc["chainId"] == 84532
    assert eurc["name"] != usdc["name"]
    assert eurc["verifyingContract"] != usdc["verifyingContract"]


def test_eip712_eurc_mainnet_none_without_override():
    assert get_eip712_domain("eip155:8453", "EURC") is None


def test_eip712_eurc_mainnet_from_override():
    eurc = get_eip712_domain("eip155:8453", "EURC", EURC_MAINNET_OVERRIDE)
    assert eurc["name"] == "EURC"
    assert eurc["verifyingContract"] == EURC_MAINNET_OVERRIDE
    assert eurc["chainId"] == 8453


def test_eip712_unknown_token_and_unsupported_network():
    assert get_eip712_domain("eip155:8453", "DOGE") is None
    assert get_eip712_domain("eip155:1", "USDC") is None
    assert get_eip712_domain("eip155:1", "EURC") is None


def test_eip712_non_eip3009_token_raises_unsupported_signing_method(monkeypatch):
    # CodeRabbit #11: get_eip712_domain builds an EIP-3009 domain, so a token
    # whose signing_method is NOT eip3009 must be rejected (the previously-dead
    # PayBotUnsupportedSigningMethodError) rather than silently signed as
    # EIP-3009. The TS-faithful registry has no eip2612 token, so we inject a
    # synthetic one to exercise the guard; the check precedes address resolution.
    import paybot_sdk.networks as net

    fake = TokenConfig(
        symbol="FAKE",
        decimals=18,
        name="Permit Token",
        signing_method="eip2612",
        eip712_name="Permit Token",
        eip712_version="1",
        address_by_network={"eip155:8453": "0x000000000000000000000000000000000000fAkE"},
    )
    monkeypatch.setitem(net.TOKENS, "FAKE", fake)
    with pytest.raises(PayBotUnsupportedSigningMethodError) as exc:
        get_eip712_domain("eip155:8453", "FAKE")
    assert exc.value.code == "UNSUPPORTED_SIGNING_METHOD"
    assert exc.value.details.get("signingMethod") == "eip2612"


# ── pay({token}) integration ─────────────────────────────────────────────


def _client(**overrides) -> PayBotClient:
    cfg = dict(api_key="pb_test_key", bot_id="token-bot", facilitator_url="https://api.test.com")
    cfg.update(overrides)
    return PayBotClient(PayBotConfig(**cfg))


@pytest.mark.asyncio
async def test_pay_eurc_mainnet_without_override_fails_no_network():
    client = _client()
    with respx.mock:
        verify = respx.post("https://api.test.com/verify")
        result = await client.pay(
            PaymentRequest(
                resource="https://example.com",
                amount="0.05",
                pay_to="0x0000000000000000000000000000000000000001",
                network="eip155:8453",
                token="EURC",
            )
        )
    assert result.success is False
    assert result.error_code == "TOKEN_ADDRESS_NOT_CONFIGURED"
    assert "token_address_overrides" in result.error
    assert not verify.called  # no network round-trip
    await client.close()


@pytest.mark.asyncio
async def test_pay_eurc_mainnet_via_override():
    client = _client(
        bot_id="token-bot-override",
        token_address_overrides={"EURC": {"eip155:8453": EURC_MAINNET_OVERRIDE}},
    )
    with respx.mock:
        verify = respx.post("https://api.test.com/verify").mock(
            return_value=Response(200, json={"settlementToken": "st_eurc"})
        )
        respx.post("https://api.test.com/settle").mock(
            return_value=Response(200, json={"success": True, "txHash": "0xeurc"})
        )
        result = await client.pay(
            PaymentRequest(
                resource="https://example.com",
                amount="0.05",
                pay_to="0x0000000000000000000000000000000000000001",
                network="eip155:8453",
                token="EURC",
            )
        )
    assert result.success is True
    body = json.loads(verify.calls.last.request.content)
    assert body["requirements"]["asset"] == f"eip155:8453/erc20:{EURC_MAINNET_OVERRIDE}"
    assert body["requirements"]["amount"] == "50000"
    await client.close()


@pytest.mark.asyncio
async def test_pay_eurc_testnet_from_public_registry():
    client = _client()
    with respx.mock:
        verify = respx.post("https://api.test.com/verify").mock(
            return_value=Response(200, json={"settlementToken": "st_eurc_t"})
        )
        respx.post("https://api.test.com/settle").mock(
            return_value=Response(200, json={"success": True, "txHash": "0xeurct"})
        )
        result = await client.pay(
            PaymentRequest(
                resource="https://example.com",
                amount="0.05",
                pay_to="0x0000000000000000000000000000000000000001",
                network="eip155:84532",
                token="EURC",
            )
        )
    assert result.success is True
    body = json.loads(verify.calls.last.request.content)
    assert body["requirements"]["asset"] == f"eip155:84532/erc20:{EURC_BASE_SEPOLIA}"
    await client.close()


@pytest.mark.asyncio
async def test_pay_signs_against_eurc_domain():
    client = _client(
        bot_id="sign-eurc",
        wallet_private_key="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        max_retries=0,
    )
    with respx.mock:
        verify = respx.post("https://api.test.com/verify").mock(
            return_value=Response(200, json={"settlementToken": "st_s"})
        )
        respx.post("https://api.test.com/settle").mock(
            return_value=Response(200, json={"success": True, "txHash": "0xt"})
        )
        result = await client.pay(
            PaymentRequest(
                resource="https://example.com",
                amount="0.01",
                pay_to="0x0000000000000000000000000000000000000001",
                network="eip155:84532",
                token="EURC",
            )
        )
    assert result.success is True
    body = json.loads(verify.calls.last.request.content)
    signed = json.loads(body["payload"]["payload"])
    assert signed["signature"].startswith("0x")
    assert signed["value"] == "10000"
    assert body["requirements"]["asset"] == f"eip155:84532/erc20:{EURC_BASE_SEPOLIA}"
    await client.close()


@pytest.mark.asyncio
async def test_pay_unknown_token_fails_no_network():
    client = _client()
    with respx.mock:
        verify = respx.post("https://api.test.com/verify")
        result = await client.pay(
            PaymentRequest(
                resource="https://example.com",
                amount="0.05",
                pay_to="0x0000000000000000000000000000000000000001",
                network="eip155:8453",
                token="DOGE",
            )
        )
    assert result.success is False
    assert result.error_code == "UNSUPPORTED_TOKEN"
    assert "DOGE" in result.error
    assert not verify.called
    await client.close()


@pytest.mark.asyncio
async def test_pay_defaults_to_usdc():
    client = _client()
    with respx.mock:
        verify = respx.post("https://api.test.com/verify").mock(
            return_value=Response(200, json={"settlementToken": "st_d"})
        )
        respx.post("https://api.test.com/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        await client.pay(
            PaymentRequest(
                resource="https://example.com",
                amount="1.00",
                pay_to="0x0000000000000000000000000000000000000001",
                network="eip155:8453",
            )
        )
    body = json.loads(verify.calls.last.request.content)
    assert body["requirements"]["asset"] == f"eip155:8453/erc20:{USDC_BASE_MAINNET}"
    await client.close()


@pytest.mark.asyncio
async def test_pay_explicit_token_contract_overrides_resolved():
    client = _client()
    with respx.mock:
        verify = respx.post("https://api.test.com/verify").mock(
            return_value=Response(200, json={"settlementToken": "st_o"})
        )
        respx.post("https://api.test.com/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        await client.pay(
            PaymentRequest(
                resource="https://example.com",
                amount="1.00",
                pay_to="0x0000000000000000000000000000000000000001",
                network="eip155:8453",
                token="EURC",
                token_contract="0xOverride",
            )
        )
    body = json.loads(verify.calls.last.request.content)
    assert body["requirements"]["asset"] == "eip155:8453/erc20:0xOverride"
    await client.close()


def test_unsupported_signing_method_error_constructible():
    e = PayBotUnsupportedSigningMethodError("RLUSD uses eip2612 permit")
    assert e.code == "UNSUPPORTED_SIGNING_METHOD"
    assert e.status_code == 400
