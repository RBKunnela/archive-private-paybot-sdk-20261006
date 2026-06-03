"""Network configurations for paybot-sdk Python port.

Mirrors `src/networks.ts` byte-for-byte on the configuration values
(chain ids, USDC addresses, RPC URLs, EIP-712 domains, EIP-3009 types).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .errors import PayBotApiError


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
    "eip155:10": NetworkConfig(
        name="Optimism",
        chain_id=10,
        caip2="eip155:10",
        rpc_url="https://mainnet.optimism.io",
        # Native USDC on OP Mainnet (Circle).
        # Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
        usdc_address="0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        explorer_url="https://optimistic.etherscan.io",
        is_testnet=False,
    ),
    "eip155:42161": NetworkConfig(
        name="Arbitrum One",
        chain_id=42161,
        caip2="eip155:42161",
        rpc_url="https://arb1.arbitrum.io/rpc",
        # Native USDC on Arbitrum One (Circle).
        # Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
        usdc_address="0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        explorer_url="https://arbiscan.io",
        is_testnet=False,
    ),
    "eip155:137": NetworkConfig(
        name="Polygon PoS",
        chain_id=137,
        caip2="eip155:137",
        rpc_url="https://polygon-rpc.com",
        # Native USDC on Polygon PoS (Circle).
        # Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
        usdc_address="0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        explorer_url="https://polygonscan.com",
        is_testnet=False,
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


# ── Multi-token registry (mirrors src/networks.ts:51-300) ─────────────────────


@dataclass(frozen=True)
class TokenConfig:
    """Configuration for a single fungible token the SDK can pay with.

    The split between :attr:`name` and :attr:`eip712_name` is deliberate and
    load-bearing for signing:

    - ``name`` is the **human-readable** token name (e.g. ``"USD Coin"``).
    - ``eip712_name`` is the **on-chain EIP-712 domain name** the token's
      contract uses in its ``DOMAIN_SEPARATOR`` (e.g. USDC contracts sign as the
      literal ``"USDC"``, NOT ``"USD Coin"``). This string is hashed into the
      signature, so it MUST match the deployed contract byte-for-byte.

    When ``eip712_name`` is omitted, :func:`get_eip712_domain` falls back to
    ``name``. Mirrors ``src/networks.ts`` ``TokenConfig``.

    ``address_by_network`` carries only the addresses that are safe to ship
    open-core (e.g. testnet deployments). Mainnet addresses for regulated tokens
    are resolved at runtime from the operator layer via
    ``PayBotConfig.token_address_overrides`` (mirrors the TS
    ``PayBotConfig.tokenAddressOverrides``) — never hardcoded here.

    :param symbol: Token ticker symbol, the registry key (e.g. ``'USDC'``).
    :param decimals: Number of base-unit decimals (USDC/EURC use 6; DAI uses 18).
    :param name: Human-readable token name (not necessarily the EIP-712 name).
    :param address_by_network: Map of CAIP-2 network id -> ERC-20 contract address.
    :param eip712_name: On-chain EIP-712 domain ``name`` (defaults to ``name``).
    """

    symbol: str
    decimals: int
    name: str
    address_by_network: Dict[str, str] = field(default_factory=dict)
    eip712_name: Optional[str] = None


#: Registry of supported tokens, keyed by ticker symbol. Addresses are byte-for-byte
#: identical to ``src/networks.ts`` TOKENS. Every address is the OFFICIAL issuer
#: deployment for that (token, network) pair, cited inline. Unverifiable pairs are
#: deliberately omitted (a wrong contract address routes real funds to the wrong
#: contract).
#:
#: This public open-core registry carries only addresses that are safe to ship
#: open-core. Mainnet addresses for regulated tokens (e.g. EURC mainnet) are
#: operator-private — injected at runtime via ``PayBotConfig.token_address_overrides``
#: and resolved through :func:`resolve_token_address`, never hardcoded here.
#:
#: Coverage notes (T2.1/T2.2 expansion):
#:   - USDC native (Circle) on Base, Base Sepolia, Optimism, Arbitrum One, Polygon.
#:   - EURC: public registry carries ONLY the Base Sepolia testnet deployment. The
#:     EURC mainnet address is operator-private (injected via overrides).
#:   - DAI (MakerDAO/Sky) on Optimism, Arbitrum One, Polygon. Crypto-collateralized,
#:     not a regulated EU EMT, so it is public-safe to ship in the open-core registry.
#:   - PYUSD (Paxos: Ethereum+Solana) and RLUSD (Ripple: Ethereum+XRPL) are not
#:     deployed on any network in this registry, so they are intentionally absent.
TOKENS: Dict[str, TokenConfig] = {
    "USDC": TokenConfig(
        symbol="USDC",
        decimals=6,
        name="USD Coin",
        eip712_name="USDC",
        address_by_network={
            # All native USDC (Circle).
            # Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
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
        eip712_name="EURC",
        address_by_network={
            # Public open-core registry carries ONLY the Base Sepolia testnet
            # deployment. The EURC mainnet address is operator-private and must be
            # injected at runtime via PayBotConfig.token_address_overrides — it is
            # deliberately NOT hardcoded here.
            # Source: https://developers.circle.com/stablecoins/eurc-contract-addresses
            "eip155:84532": "0x808456652fdb597867f38412077A9182bf77359F",
        },
    ),
    "DAI": TokenConfig(
        symbol="DAI",
        decimals=18,
        name="Dai Stablecoin",
        eip712_name="Dai Stablecoin",
        address_by_network={
            # MakerDAO/Sky canonical DAI deployments (bridged).
            # Source: https://docs.makerdao.com/ + chain-native bridge deployments.
            # Optimism + Arbitrum share the canonical bridged-DAI address.
            "eip155:10": "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
            "eip155:42161": "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
            "eip155:137": "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
        },
    ),
}


def get_token(symbol: str) -> Optional[TokenConfig]:
    """Look up a token's full configuration by symbol (networks.ts:130).

    :param symbol: Token ticker (e.g. ``'USDC'``, ``'EURC'``). Case-sensitive.
    :returns: The :class:`TokenConfig`, or ``None`` when the symbol is unknown.
    """
    return TOKENS.get(symbol)


def get_token_address(symbol: str, network: str) -> Optional[str]:
    """Resolve a token's ERC-20 contract address on a specific network.

    Mirrors ``getTokenAddress`` in ``src/networks.ts``.

    :param symbol: Token ticker (e.g. ``'USDC'``).
    :param network: The CAIP-2 network id (e.g. ``'eip155:8453'``).
    :returns: The contract address, or ``None`` when the token is unknown OR the
        token is not deployed on that network.
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

    Mirrors ``resolveTokenAddress`` in ``src/networks.ts``. Resolution precedence
    (first match wins):

    1. ``overrides[symbol][network]`` — operator-injected address (e.g. a mainnet
       deployment intentionally kept out of the public registry).
    2. The public :data:`TOKENS` registry (:func:`get_token_address`).

    The helper is deliberately generic — it carries no token-specific or
    regulatory data, only the symbol -> network -> address lookup.

    :param symbol: Token ticker (e.g. ``'USDC'``, ``'EURC'``).
    :param network: The CAIP-2 network id (e.g. ``'eip155:8453'``).
    :param overrides: Optional operator-supplied ``symbol -> network -> address`` map.
    :returns: The resolved contract address, or ``None`` when neither the override
        map nor the public registry has an entry.

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
    """List the ticker symbols of all tokens in the registry (networks.ts:159).

    :returns: An array of supported token symbols (e.g. ``['USDC', 'EURC']``).
    """
    return list(TOKENS.keys())


def get_eip712_domain(
    network: str,
    symbol: str = "USDC",
    verifying_contract_override: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Build the token-specific EIP-712 domain for EIP-3009 signing.

    Mirrors ``getEip712Domain`` in ``src/networks.ts``. The domain is
    token-specific: USDC signs as ``name='USDC'`` at the USDC contract address;
    EURC signs as ``name='EURC'`` at the EURC contract address.

    REGRESSION GUARANTEE: for ``symbol == 'USDC'`` this returns a domain
    byte-identical to ``EIP712_DOMAINS[network]`` (same ``name``, ``version``,
    ``chainId``, ``verifyingContract``), so existing USDC signatures are unchanged.

    Returns camelCase keys (``chainId``/``verifyingContract``) because
    ``eth-account`` consumes the EIP-712 domain dict directly.

    :param network: The CAIP-2 network id (e.g. ``'eip155:8453'``).
    :param symbol: The token ticker (default ``'USDC'``).
    :param verifying_contract_override: Optional contract address to sign against,
        used when the address is supplied at runtime by the operator layer (i.e. the
        token has no public-registry entry for ``network``, such as EURC mainnet).
        When omitted, the address comes from the public :data:`TOKENS` registry.
    :returns: The EIP-712 domain dict, or ``None`` when the token is unknown, the
        network is unsupported, OR no contract address can be resolved (neither an
        override nor a public-registry entry).

    :example:
        >>> get_eip712_domain("eip155:8453", "USDC")["name"]
        'USDC'
        >>> get_eip712_domain("eip155:8453", "DOGE") is None
        True
    """
    token = TOKENS.get(symbol)
    if token is None:
        return None
    verifying_contract = verifying_contract_override or token.address_by_network.get(network)
    network_config = NETWORKS.get(network)
    if not verifying_contract or network_config is None:
        return None
    return {
        "name": token.eip712_name or token.name,
        "version": "2",
        "chainId": network_config.chain_id,
        "verifyingContract": verifying_contract,
    }


def get_network(caip2: str) -> Optional[NetworkConfig]:
    """Get network config by CAIP-2 identifier (networks.ts:212)."""
    return NETWORKS.get(caip2)


def get_supported_networks() -> List[str]:
    """Get all supported network CAIP-2 identifiers (networks.ts:219)."""
    return list(NETWORKS.keys())


@dataclass(frozen=True)
class Caip2:
    """Parsed components of a CAIP-2 chain identifier (networks.ts:228).

    :param namespace: CAIP-2 namespace (e.g. ``eip155`` for EVM chains).
    :param reference: CAIP-2 reference (e.g. ``8453`` — the EVM chain id).
    """

    namespace: str
    reference: str


def parse_caip2(id_: str) -> Caip2:
    """Parse a CAIP-2 identifier of the form ``eip155:<chainId>`` (networks.ts:254).

    Validates the x402-relevant ``eip155`` shape strictly: the namespace MUST be
    ``eip155`` and the reference MUST be a non-empty run of digits.

    :param id_: The CAIP-2 string to parse (e.g. ``'eip155:8453'``).
    :returns: The parsed :class:`Caip2`.
    :raises PayBotApiError: code ``INVALID_CAIP2`` (HTTP 400) when ``id_`` is not
        a well-formed ``eip155:<digits>`` identifier.

    :example:
        >>> parse_caip2("eip155:8453")
        Caip2(namespace='eip155', reference='8453')
    """
    import re

    if not isinstance(id_, str) or len(id_) == 0:
        raise PayBotApiError(
            f"Invalid CAIP-2 identifier: expected a non-empty string, got {type(id_).__name__}",
            "INVALID_CAIP2",
            400,
        )

    match = re.fullmatch(r"(eip155):(\d+)", id_)
    if not match:
        raise PayBotApiError(
            f"Invalid CAIP-2 identifier: '{id_}' is not a well-formed eip155:<chainId>",
            "INVALID_CAIP2",
            400,
            {"id": id_},
        )

    return Caip2(namespace=match.group(1), reference=match.group(2))


def is_supported_caip2(id_: str) -> bool:
    """Test whether a CAIP-2 id is well-formed AND supported (networks.ts:293).

    Never raises — malformed input returns ``False``. Use :func:`parse_caip2`
    when you want a hard error on malformed input.

    :param id_: The CAIP-2 string to check.
    :returns: ``True`` if ``id_`` is a supported, well-formed CAIP-2 network id.
    """
    try:
        parse_caip2(id_)
    except PayBotApiError:
        return False
    return id_ in NETWORKS
