"""Tests for the multi-token registry + CAIP-2 helpers. Mirrors parts of
``tests/tokens.test.ts`` and ``tests/networks.test.ts``.

Critical regression lock: ``get_eip712_domain(network, 'USDC')`` MUST be
byte-identical to the legacy ``EIP712_DOMAINS[network]`` so existing USDC
signatures are unchanged.
"""
from __future__ import annotations

import pytest

from paybot_sdk import (
    EIP712_DOMAINS,
    TOKENS,
    TokenConfig,
    get_eip712_domain,
    get_supported_tokens,
    get_token,
    get_token_address,
    is_supported_caip2,
    parse_caip2,
    resolve_token_address,
)
from paybot_sdk.errors import PayBotApiError
from paybot_sdk.networks import (
    Caip2,
    get_network,
    get_supported_networks,
)

# EURC Base Sepolia testnet deployment — the ONLY EURC address shipped in the
# public open-core registry. The EURC mainnet address is operator-private and
# intentionally absent from paybot_sdk/ (resolved at runtime via
# token_address_overrides).
EURC_BASE_SEPOLIA = "0x808456652fdb597867f38412077A9182bf77359F"
# Stand-in for the operator-injected EURC mainnet address. The literal Circle EURC
# mainnet address must NEVER appear in this public repo.
EURC_MAINNET_OVERRIDE = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01"


# ── TOKENS registry ────────────────────────────────────────────────────────


def test_tokens_has_usdc_eurc_dai():
    assert set(TOKENS.keys()) == {"USDC", "EURC", "DAI"}


def test_pyusd_rlusd_not_registered():
    # Not deployed on any network in this registry — must be absent, not guessed.
    assert "PYUSD" not in TOKENS
    assert "RLUSD" not in TOKENS


def test_usdc_addresses_match_networks_ts():
    usdc = TOKENS["USDC"]
    assert usdc.address_by_network["eip155:8453"] == "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    assert usdc.address_by_network["eip155:84532"] == "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    # T2.1 — native USDC on the new L2 mainnets.
    assert usdc.address_by_network["eip155:10"] == "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"
    assert usdc.address_by_network["eip155:42161"] == "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
    assert usdc.address_by_network["eip155:137"] == "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
    assert usdc.decimals == 6
    assert usdc.eip712_name == "USDC"
    # Premium EU-compliance metadata must NOT exist on the public token config.
    assert not hasattr(usdc, "mica_compliant")


def test_eurc_addresses_match_networks_ts():
    eurc = TOKENS["EURC"]
    # Public registry carries ONLY the Base Sepolia testnet deployment.
    assert eurc.address_by_network["eip155:84532"] == EURC_BASE_SEPOLIA
    # EURC mainnet is operator-private (premium) — intentionally absent.
    assert "eip155:8453" not in eurc.address_by_network
    # EURC is NOT deployed on the new L2s.
    assert "eip155:10" not in eurc.address_by_network
    assert "eip155:42161" not in eurc.address_by_network
    assert "eip155:137" not in eurc.address_by_network
    assert eurc.decimals == 6
    assert eurc.eip712_name == "EURC"
    assert not hasattr(eurc, "mica_compliant")


def test_dai_addresses_match_networks_ts():
    dai = TOKENS["DAI"]
    assert dai.address_by_network["eip155:10"] == "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"
    assert dai.address_by_network["eip155:42161"] == "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"
    assert dai.address_by_network["eip155:137"] == "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"
    # DAI not registered on Base / Base Sepolia.
    assert "eip155:8453" not in dai.address_by_network
    assert "eip155:84532" not in dai.address_by_network
    assert dai.decimals == 18
    assert dai.eip712_name == "Dai Stablecoin"
    # Premium EU-compliance metadata must NOT exist on the public token config.
    assert not hasattr(dai, "mica_compliant")


# ── get_token ──────────────────────────────────────────────────────────────


def test_get_token_known():
    t = get_token("USDC")
    assert isinstance(t, TokenConfig)
    assert t.symbol == "USDC"


def test_get_token_unknown_returns_none():
    assert get_token("DOGE") is None


def test_get_token_case_sensitive():
    assert get_token("usdc") is None


# ── get_token_address ──────────────────────────────────────────────────────


def test_get_token_address_known():
    assert get_token_address("EURC", "eip155:84532") == EURC_BASE_SEPOLIA


def test_get_token_address_eurc_mainnet_not_in_public_registry():
    # EURC mainnet is operator-private (premium) and intentionally absent.
    assert get_token_address("EURC", "eip155:8453") is None


@pytest.mark.parametrize(
    ("network", "expected"),
    [
        ("eip155:10", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
        ("eip155:42161", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
        ("eip155:137", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
    ],
)
def test_get_token_address_usdc_new_l2s(network, expected):
    assert get_token_address("USDC", network) == expected
    # Must equal the network config's usdc_address (no divergence).
    assert get_token_address("USDC", network) == get_network(network).usdc_address


@pytest.mark.parametrize(
    ("network", "expected"),
    [
        ("eip155:10", "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"),
        ("eip155:42161", "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"),
        ("eip155:137", "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"),
    ],
)
def test_get_token_address_dai_deployed(network, expected):
    assert get_token_address("DAI", network) == expected


def test_get_token_address_eurc_not_on_new_l2s():
    for network in ("eip155:10", "eip155:42161", "eip155:137"):
        assert get_token_address("EURC", network) is None


def test_get_token_address_dai_not_on_base():
    assert get_token_address("DAI", "eip155:8453") is None
    assert get_token_address("DAI", "eip155:84532") is None


def test_get_token_address_unknown_token():
    assert get_token_address("DOGE", "eip155:8453") is None


def test_get_token_address_token_not_on_network():
    assert get_token_address("USDC", "eip155:1") is None


# ── resolve_token_address (operator override layer) ────────────────────────


def test_resolve_token_address_falls_back_to_public_registry():
    assert (
        resolve_token_address("USDC", "eip155:8453")
        == "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    )
    assert resolve_token_address("EURC", "eip155:84532") == EURC_BASE_SEPOLIA


def test_resolve_token_address_eurc_mainnet_none_without_override():
    assert resolve_token_address("EURC", "eip155:8453") is None


def test_resolve_token_address_injected_eurc_mainnet():
    overrides = {"EURC": {"eip155:8453": EURC_MAINNET_OVERRIDE}}
    assert resolve_token_address("EURC", "eip155:8453", overrides) == EURC_MAINNET_OVERRIDE


def test_resolve_token_address_override_precedence():
    overrides = {"USDC": {"eip155:8453": EURC_MAINNET_OVERRIDE}}
    assert resolve_token_address("USDC", "eip155:8453", overrides) == EURC_MAINNET_OVERRIDE


def test_resolve_token_address_unrelated_overrides_do_not_leak():
    overrides = {"EURC": {"eip155:8453": EURC_MAINNET_OVERRIDE}}
    assert (
        resolve_token_address("USDC", "eip155:8453", overrides)
        == "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    )
    assert resolve_token_address("EURC", "eip155:84532", overrides) == EURC_BASE_SEPOLIA


# ── get_supported_tokens ───────────────────────────────────────────────────


def test_get_supported_tokens():
    assert get_supported_tokens() == ["USDC", "EURC", "DAI"]


# ── get_eip712_domain — REGRESSION LOCK ────────────────────────────────────


@pytest.mark.parametrize(
    "network",
    ["eip155:8453", "eip155:84532", "eip155:10", "eip155:42161", "eip155:137"],
)
def test_get_eip712_domain_usdc_matches_legacy_table(network):
    """Byte-identical to EIP712_DOMAINS[network] for USDC — the regression lock."""
    assert get_eip712_domain(network, "USDC") == EIP712_DOMAINS[network]


def test_get_eip712_domain_usdc_default_symbol():
    assert get_eip712_domain("eip155:8453") == EIP712_DOMAINS["eip155:8453"]


def test_get_eip712_domain_eurc_uses_own_domain_testnet():
    d = get_eip712_domain("eip155:84532", "EURC")
    assert d == {
        "name": "EURC",
        "version": "2",
        "chainId": 84532,
        "verifyingContract": EURC_BASE_SEPOLIA,
    }


def test_get_eip712_domain_eurc_mainnet_none_without_override():
    # No public-registry mainnet address → no domain unless the operator injects one.
    assert get_eip712_domain("eip155:8453", "EURC") is None


def test_get_eip712_domain_eurc_mainnet_from_injected_override():
    d = get_eip712_domain("eip155:8453", "EURC", EURC_MAINNET_OVERRIDE)
    assert d == {
        "name": "EURC",
        "version": "2",
        "chainId": 8453,
        "verifyingContract": EURC_MAINNET_OVERRIDE,
    }


def test_get_eip712_domain_dai_uses_own_domain():
    d = get_eip712_domain("eip155:10", "DAI")
    assert d == {
        "name": "Dai Stablecoin",
        "version": "2",
        "chainId": 10,
        "verifyingContract": "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    }


def test_get_eip712_domain_dai_on_unregistered_network_none():
    # DAI is not registered on Base, even though Base is supported.
    assert get_eip712_domain("eip155:8453", "DAI") is None


def test_get_eip712_domain_unknown_token_none():
    assert get_eip712_domain("eip155:8453", "DOGE") is None


def test_get_eip712_domain_unknown_network_none():
    assert get_eip712_domain("eip155:1", "USDC") is None


# ── get_network / get_supported_networks ───────────────────────────────────


def test_get_network_known():
    n = get_network("eip155:8453")
    assert n is not None and n.chain_id == 8453


def test_get_network_unknown():
    assert get_network("eip155:1") is None


@pytest.mark.parametrize(
    ("caip2", "name", "chain_id"),
    [
        ("eip155:10", "Optimism", 10),
        ("eip155:42161", "Arbitrum One", 42161),
        ("eip155:137", "Polygon PoS", 137),
    ],
)
def test_get_network_new_l2_mainnets(caip2, name, chain_id):
    n = get_network(caip2)
    assert n is not None
    assert n.name == name
    assert n.chain_id == chain_id
    assert n.is_testnet is False


def test_get_supported_networks():
    assert set(get_supported_networks()) == {
        "eip155:8453",
        "eip155:84532",
        "eip155:10",
        "eip155:42161",
        "eip155:137",
    }


# ── parse_caip2 ────────────────────────────────────────────────────────────


def test_parse_caip2_valid():
    c = parse_caip2("eip155:8453")
    assert c == Caip2(namespace="eip155", reference="8453")


def test_parse_caip2_empty_raises():
    with pytest.raises(PayBotApiError) as ei:
        parse_caip2("")
    assert ei.value.code == "INVALID_CAIP2"
    assert ei.value.status_code == 400


def test_parse_caip2_wrong_namespace_raises():
    with pytest.raises(PayBotApiError) as ei:
        parse_caip2("solana:foo")
    assert ei.value.code == "INVALID_CAIP2"


def test_parse_caip2_non_digit_reference_raises():
    with pytest.raises(PayBotApiError):
        parse_caip2("eip155:abc")


def test_parse_caip2_extra_colon_raises():
    with pytest.raises(PayBotApiError):
        parse_caip2("eip155:8453:extra")


# ── is_supported_caip2 — never raises ──────────────────────────────────────


def test_is_supported_caip2_true():
    assert is_supported_caip2("eip155:8453") is True


def test_is_supported_caip2_wellformed_but_unsupported():
    assert is_supported_caip2("eip155:1") is False


def test_is_supported_caip2_malformed_returns_false():
    assert is_supported_caip2("not-a-caip2") is False
    assert is_supported_caip2("") is False
