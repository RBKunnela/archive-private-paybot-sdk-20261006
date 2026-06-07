"""Network + token configuration for the paybot-sdk Python port.

Mirrors ``src/networks.ts`` on the configuration values (chain ids, USDC
addresses, RPC URLs, EIP-712 domains, EIP-3009 types) and the multi-token
registry helpers (:data:`TOKENS`, :func:`get_token`, :func:`resolve_token_address`,
:func:`get_eip712_domain`, CAIP-2 helpers).

OPEN-CORE BOUNDARY: this public module ships only token addresses safe to
distribute (testnet deployments + the well-known USDC mainnet address). Mainnet
addresses for regulated tokens (e.g. EURC mainnet) are NOT hardcoded here — they
are resolved at runtime from the operator layer via
``PayBotConfig.token_address_overrides`` and :func:`resolve_token_address`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional

from .errors import PayBotApiError, PayBotUnsupportedSigningMethodError


@dataclass(frozen=True)
class NetworkConfig:
    """Configuration for a supported blockchain network."""

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
    # New L2 mainnets — restored to match src/networks.ts (the parity target)
    # and the main-released test_tokens_caip2.py. Native USDC (Circle).
    "eip155:10": NetworkConfig(
        name="Optimism",
        chain_id=10,
        caip2="eip155:10",
        rpc_url="https://mainnet.optimism.io",
        usdc_address="0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        explorer_url="https://optimistic.etherscan.io",
        is_testnet=False,
    ),
    "eip155:42161": NetworkConfig(
        name="Arbitrum One",
        chain_id=42161,
        caip2="eip155:42161",
        rpc_url="https://arb1.arbitrum.io/rpc",
        usdc_address="0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        explorer_url="https://arbiscan.io",
        is_testnet=False,
    ),
    "eip155:137": NetworkConfig(
        name="Polygon PoS",
        chain_id=137,
        caip2="eip155:137",
        rpc_url="https://polygon-rpc.com",
        usdc_address="0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        explorer_url="https://polygonscan.com",
        is_testnet=False,
    ),
}


# Legacy single-token view, kept exported for back-compat. The multi-token
# registry :data:`TOKENS` supersedes it for new code.
USDC_CONFIG = {
    "symbol": "USDC",
    "name": "USD Coin",
    "decimals": 6,
}


# Off-chain token signing method.
#   - ``'eip3009'`` — gasless ``TransferWithAuthorization``. Every token in the
#     TS-faithful registry (USDC/EURC/DAI) uses this.
#   - ``'eip2612'`` — ERC-2612 ``permit``. Not implemented by this SDK; a token
#     declaring it raises :class:`PayBotUnsupportedSigningMethodError`. No token
#     in the current registry uses it; the value + guard remain so a future
#     permit-only token cannot be silently signed as EIP-3009 (CodeRabbit #11).
SigningMethod = Literal["eip3009", "eip2612"]


@dataclass(frozen=True)
class TokenConfig:
    """Configuration for a single fungible token the SDK can pay with.

    The split between :attr:`name` and :attr:`eip712_name` is load-bearing for
    signing: ``name`` is the human-readable token name (e.g. ``"USD Coin"``),
    while ``eip712_name`` is the on-chain EIP-712 domain ``name`` the token's
    contract actually signs under (USDC contracts sign as the literal
    ``"USDC"``). When ``eip712_name`` is absent, :func:`get_eip712_domain` falls
    back to ``name``.

    :param symbol: Token ticker, used as the registry key (e.g. ``'USDC'``).
    :param decimals: Number of base-unit decimals.
    :param name: Human-readable token name.
    :param signing_method: Off-chain authorization method (see :data:`SigningMethod`).
    :param eip712_name: On-chain EIP-712 domain name (defaults to ``name``).
    :param eip712_version: EIP-712 domain ``version`` string (default ``'2'``).
    :param address_by_network: Map of CAIP-2 network id → ERC-20 contract address.
        Carries ONLY addresses safe to ship open-core. Operator-private mainnet
        addresses are injected at runtime, never hardcoded here.
    """

    symbol: str
    decimals: int
    name: str
    signing_method: SigningMethod
    eip712_name: Optional[str] = None
    eip712_version: str = "2"
    address_by_network: Dict[str, str] = field(default_factory=dict)


# Registry of supported tokens, keyed by ticker symbol. Byte-for-byte aligned
# with src/networks.ts TOKENS (the parity target) and the main-released registry:
#   - USDC native (Circle) on Base, Base Sepolia, Optimism, Arbitrum One, Polygon.
#   - EURC: public registry carries ONLY the Base Sepolia testnet deployment; the
#     mainnet address is operator-private (injected via token_address_overrides).
#   - DAI (MakerDAO/Sky) on Optimism, Arbitrum One, Polygon — crypto-collateralized,
#     not a regulated EU EMT, so public-safe to ship. DAI signs an EIP-712 domain
#     under the literal "Dai Stablecoin" (EIP-3009-style TransferWithAuthorization).
#   - PYUSD (Paxos) and RLUSD (Ripple) are NOT deployed on any network in this
#     registry, so they are intentionally absent (matching TS).
#
# NOTE (Phase-4 reconciliation): the parity branch had earlier added PYUSD/RLUSD
# and marked DAI as eip2612-rejected. That diverged from src/networks.ts, which
# has no signing_method concept and treats DAI as signable. Restored to the
# TS-faithful shape here. The signing_method field is retained (default eip3009)
# so the CodeRabbit #11 guard in get_eip712_domain still rejects any future
# non-eip3009 token; no token in this registry triggers it.
TOKENS: Dict[str, TokenConfig] = {
    "USDC": TokenConfig(
        symbol="USDC",
        decimals=6,
        name="USD Coin",
        signing_method="eip3009",
        # USDC contracts sign their EIP-712 domain as the literal "USDC".
        eip712_name="USDC",
        eip712_version="2",
        address_by_network={
            # Reuses NETWORKS[...].usdc_address — keep identical, do not diverge.
            "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "eip155:10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
            "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        },
    ),
    "EURC": TokenConfig(
        symbol="EURC",
        decimals=6,
        name="EURC",
        signing_method="eip3009",
        eip712_name="EURC",
        eip712_version="2",
        address_by_network={
            # Public open-core registry carries ONLY the Base Sepolia testnet
            # deployment. The EURC mainnet address is operator-private and must
            # be injected at runtime via token_address_overrides — it is
            # deliberately NOT hardcoded here.
            "eip155:84532": "0x808456652fdb597867f38412077A9182bf77359F",
        },
    ),
    "DAI": TokenConfig(
        symbol="DAI",
        decimals=18,
        name="Dai Stablecoin",
        # TS-faithful: DAI signs an EIP-712 TransferWithAuthorization under the
        # literal domain name "Dai Stablecoin" (not an eip2612-only token here).
        signing_method="eip3009",
        eip712_name="Dai Stablecoin",
        eip712_version="2",
        address_by_network={
            # MakerDAO/Sky canonical DAI deployments (bridged). Optimism +
            # Arbitrum share the canonical bridged-DAI address.
            "eip155:10": "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
            "eip155:42161": "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
            "eip155:137": "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
        },
    ),
}


def get_token(symbol: str) -> Optional[TokenConfig]:
    """Look up a token's full configuration by symbol.

    :param symbol: The token ticker (case-sensitive, e.g. ``'USDC'``).
    :returns: The :class:`TokenConfig`, or ``None`` when the symbol is unknown.

    :example:
        >>> get_token("USDC").decimals
        6
        >>> get_token("DOGE") is None
        True
    """
    return TOKENS.get(symbol)


def get_token_address(symbol: str, network: str) -> Optional[str]:
    """Resolve a token's ERC-20 contract address on a specific network from the
    public registry only.

    :param symbol: The token ticker (e.g. ``'USDC'``).
    :param network: The CAIP-2 network id (e.g. ``'eip155:8453'``).
    :returns: The contract address, or ``None`` when the token is unknown OR not
        deployed on that network in the public registry.

    :example:
        >>> get_token_address("EURC", "eip155:84532")  # testnet deployment
        '0x808456652fdb597867f38412077A9182bf77359F'
        >>> get_token_address("EURC", "eip155:8453") is None  # mainnet not public
        True
    """
    token = TOKENS.get(symbol)
    if token is None:
        return None
    return token.address_by_network.get(network)


def resolve_token_address(
    symbol: str,
    network: str,
    overrides: Optional[Dict[str, Dict[str, str]]] = None,
) -> Optional[str]:
    """Resolve a token's contract address with an optional operator override layer.

    Resolution precedence (first match wins):

    1. ``overrides[symbol][network]`` — operator-injected address (e.g. a mainnet
       deployment intentionally kept out of the public registry).
    2. The public :data:`TOKENS` registry (:func:`get_token_address`).

    The helper carries no token-specific or regulatory data, only the
    symbol→network→address lookup.

    :param symbol: The token ticker (e.g. ``'USDC'``, ``'EURC'``).
    :param network: The CAIP-2 network id (e.g. ``'eip155:8453'``).
    :param overrides: Optional operator-supplied ``symbol → network → address`` map.
    :returns: The resolved address, or ``None`` when neither the override map nor
        the public registry has an entry.

    :example:
        >>> resolve_token_address("EURC", "eip155:8453") is None
        True
        >>> resolve_token_address(
        ...     "EURC", "eip155:8453", {"EURC": {"eip155:8453": "0xabc"}}
        ... )
        '0xabc'
    """
    if overrides is not None:
        override = overrides.get(symbol, {}).get(network)
        if override:
            return override
    return get_token_address(symbol, network)


def get_supported_tokens() -> List[str]:
    """List the ticker symbols of all tokens in the registry.

    :returns: A list of supported token symbols (e.g. ``['USDC', 'EURC', ...]``).
    """
    return list(TOKENS.keys())


# EIP-712 domain templates per network (legacy single-token USDC view). The
# verifying contract is the USDC contract on that network. Kept for back-compat
# and as the regression anchor for :func:`get_eip712_domain` (USDC).
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
    # New L2 mainnets (USDC) — TS-faithful regression anchors.
    "eip155:10": {
        "name": "USDC",
        "version": "2",
        "chainId": 10,
        "verifyingContract": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    },
    "eip155:42161": {
        "name": "USDC",
        "version": "2",
        "chainId": 42161,
        "verifyingContract": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    "eip155:137": {
        "name": "USDC",
        "version": "2",
        "chainId": 137,
        "verifyingContract": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    },
}


def get_eip712_domain(
    network: str,
    symbol: str = "USDC",
    verifying_contract_override: Optional[str] = None,
) -> Optional[Dict]:
    """Build the EIP-712 domain for signing an EIP-3009
    ``TransferWithAuthorization`` for a given token on a given network.

    The domain is token-specific: USDC signs as ``name: 'USDC'`` at the USDC
    contract address; EURC signs as ``name: 'EURC'`` at the EURC address. This is
    the multi-token generalization of :data:`EIP712_DOMAINS`.

    REGRESSION GUARANTEE: for ``symbol == 'USDC'`` this returns a domain
    byte-identical to ``EIP712_DOMAINS[network]`` (same ``name``, ``version``,
    ``chainId``, ``verifyingContract``), so existing USDC signatures are unchanged.

    :param network: The CAIP-2 network id (e.g. ``'eip155:8453'``).
    :param symbol: The token ticker (default ``'USDC'``).
    :param verifying_contract_override: Optional contract address to sign against,
        used when the operator layer supplies an address at runtime (e.g. EURC
        mainnet). When omitted, the public-registry address is used.
    :returns: The EIP-712 domain dict, or ``None`` when the token is unknown, the
        network is unsupported, OR no contract address can be resolved.

    :example:
        >>> get_eip712_domain("eip155:8453", "USDC") == EIP712_DOMAINS["eip155:8453"]
        True
        >>> get_eip712_domain("eip155:8453", "DOGE") is None
        True
    """
    token = TOKENS.get(symbol)
    if token is None:
        return None
    # This domain is only meaningful for EIP-3009 TransferWithAuthorization.
    # A token that authorizes via EIP-2612 permit MUST NOT be silently signed as
    # EIP-3009 — that produces a structurally valid but semantically wrong
    # signature the chain will reject (CodeRabbit #11).
    # PayBotUnsupportedSigningMethodError was defined but never raised (dead
    # code); enforce it here so both client._sign_payload and the x402 handler
    # reject unsupported methods loudly.
    if token.signing_method != "eip3009":
        raise PayBotUnsupportedSigningMethodError(
            f"Token {symbol} uses unsupported signing method "
            f"'{token.signing_method}'; only 'eip3009' is implemented",
            details={"symbol": symbol, "signingMethod": token.signing_method},
        )
    verifying_contract = (
        verifying_contract_override
        if verifying_contract_override
        else token.address_by_network.get(network)
    )
    network_config = NETWORKS.get(network)
    if not verifying_contract or network_config is None:
        return None
    return {
        "name": token.eip712_name or token.name,
        "version": token.eip712_version,
        "chainId": network_config.chain_id,
        "verifyingContract": verifying_contract,
    }


def get_network(caip2: str) -> Optional[NetworkConfig]:
    """Get network config by CAIP-2 identifier.

    :param caip2: The CAIP-2 network id.
    :returns: The :class:`NetworkConfig`, or ``None`` when unsupported.
    """
    return NETWORKS.get(caip2)


def get_supported_networks() -> List[str]:
    """Get all supported network CAIP-2 identifiers."""
    return list(NETWORKS.keys())


@dataclass(frozen=True)
class Caip2:
    """Parsed components of a CAIP-2 chain identifier.

    :param namespace: CAIP-2 namespace (e.g. ``'eip155'`` for EVM chains).
    :param reference: CAIP-2 reference (e.g. ``'8453'`` — the EVM chain id).
    """

    namespace: str
    reference: str


_CAIP2_RE = re.compile(r"^(eip155):(\d+)$")


def parse_caip2(id: str) -> Caip2:
    """Parse a CAIP-2 identifier of the form ``eip155:<chainId>``.

    Validates the x402-relevant ``eip155`` shape strictly: the namespace MUST be
    ``eip155`` and the reference MUST be a non-empty run of digits.

    :param id: The CAIP-2 string to parse (e.g. ``'eip155:8453'``).
    :returns: The parsed :class:`Caip2`.
    :raises PayBotApiError: code ``INVALID_CAIP2`` (HTTP 400) when ``id`` is not a
        well-formed ``eip155:<digits>`` identifier.

    :example:
        >>> parse_caip2("eip155:8453")
        Caip2(namespace='eip155', reference='8453')
    """
    if not isinstance(id, str) or len(id) == 0:
        raise PayBotApiError(
            f"Invalid CAIP-2 identifier: expected a non-empty string, got {type(id).__name__}",
            "INVALID_CAIP2",
            400,
        )
    match = _CAIP2_RE.match(id)
    if not match:
        raise PayBotApiError(
            f"Invalid CAIP-2 identifier: '{id}' is not a well-formed eip155:<chainId>",
            "INVALID_CAIP2",
            400,
            {"id": id},
        )
    return Caip2(namespace=match.group(1), reference=match.group(2))


def is_supported_caip2(id: str) -> bool:
    """Test whether a CAIP-2 identifier is well-formed AND maps to a supported
    network (present in :data:`NETWORKS`).

    Never raises — malformed input returns ``False``.

    :param id: The CAIP-2 string to check.
    :returns: ``True`` if ``id`` is a supported, well-formed CAIP-2 network id.
    """
    try:
        parse_caip2(id)
    except PayBotApiError:
        return False
    return id in NETWORKS


# EIP-3009 TransferWithAuthorization typed-data structure (mirrors EIP3009_TYPES).
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
