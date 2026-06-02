"""AP2 (Google Agent Payments Protocol) -> x402 settlement adapter. Mirrors ``src/ap2.ts``.

AP2 sits ABOVE x402 as an orchestration layer: it issues Intent / Cart / Payment
**Mandates** as verifiable credentials (VCs), and the A2A x402 extension lets an
AP2 Payment Mandate authorize an x402 USDC/EURC settlement.

paybot is the **settlement layer**, NOT the mandate issuer. This module consumes
the minimal slice of the AP2 Payment Mandate needed to settle and translates it
into the x402 :class:`PaymentRequirements` the :class:`X402Handler` already knows
how to sign and submit.

TRUST BOUNDARY (read carefully):
    This adapter does **NOT** verify the AP2 verifiable-credential signature
    (``Ap2PaymentMandate.signature``). VC issuance and verification live in the
    mandate issuer's trust domain (the AP2 orchestrator / wallet). We treat the
    signature as opaque. A caller that needs cryptographic assurance the mandate
    is authentic MUST verify the VC out-of-band before handing it to
    :meth:`Ap2Adapter.settle`. :meth:`Ap2Adapter.validate_mandate` only checks
    structural completeness and expiry — it is NOT an authenticity check.

Dependencies: ./x402 (X402Handler), ./networks (token registry), ./errors.
Used by: bot developers integrating AP2-issued mandates with paybot settlement.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .errors import PayBotApiError
from .networks import get_token, get_token_address
from .types import PaymentIntent, PaymentPayload, PaymentRequirements, Receipt
from .x402 import X402Handler, _iso_from_ms

#: Default x402 settlement timeout (seconds) when the mandate has no expiry.
DEFAULT_MAX_TIMEOUT_SECONDS = 300

#: Default payment endpoint when ``Ap2SettleOptions.payment_endpoint`` is omitted.
DEFAULT_PAYMENT_ENDPOINT = "https://api.paybotcore.com/x402/settle"

#: Required string fields a mandate MUST carry to be settleable.
REQUIRED_MANDATE_FIELDS = ("mandate_id", "payer", "payee", "amount", "currency", "network")


@dataclass
class Ap2PaymentMandate:
    """The minimal AP2 Payment Mandate surface paybot consumes (ap2.ts:45-66).

    Fields we do not act on (e.g. ``cart_hash``, ``signature``) are carried
    through opaquely. The ``signature`` is NOT verified — see module trust boundary.

    :param mandate_id: Unique mandate identifier (the VC id, or a stable reference).
    :param payer: Payer account / wallet address.
    :param payee: Payee account / wallet address (settlement recipient).
    :param amount: Amount in base units (token's smallest unit; USDC/EURC use 6).
    :param currency: Token ticker symbol to settle in (e.g. ``'USDC'``).
    :param network: Settlement network as a CAIP-2 id (e.g. ``'eip155:8453'``).
    :param intent_id: Optional id of the upstream Intent Mandate this fulfills.
    :param expires_at: Optional ISO-8601 expiry; a past value invalidates the mandate.
    :param cart_hash: Optional hash of the associated AP2 Cart Mandate (opaque).
    :param signature: Opaque AP2 VC signature. NOT verified here.
    """

    mandate_id: str
    payer: str
    payee: str
    amount: str
    currency: str
    network: str
    intent_id: Optional[str] = None
    expires_at: Optional[str] = None
    cart_hash: Optional[str] = None
    signature: Optional[str] = None


@dataclass
class Ap2SettleOptions:
    """Settlement-time options for :meth:`Ap2Adapter.settle` (ap2.ts:225).

    :param payment_endpoint: Endpoint the signed x402 payload is POSTed to.
    :param auth_token: Optional bearer token forwarded to the payment endpoint.
    """

    payment_endpoint: Optional[str] = None
    auth_token: Optional[str] = None


def _derive_max_timeout_seconds(expires_at: Optional[str], now_ms: Optional[int] = None) -> int:
    """Derive ``max_timeout_seconds`` from an optional ISO-8601 ``expires_at`` (ap2.ts:82).

    Returns whole seconds from "now" until ``expires_at``. Falls back to
    :data:`DEFAULT_MAX_TIMEOUT_SECONDS` when absent, unparseable, or in the past.
    """
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    if not expires_at:
        return DEFAULT_MAX_TIMEOUT_SECONDS
    exp_ms = _parse_iso_ms(expires_at)
    if exp_ms is None:
        return DEFAULT_MAX_TIMEOUT_SECONDS
    seconds = (exp_ms - now_ms) // 1000
    return seconds if seconds > 0 else DEFAULT_MAX_TIMEOUT_SECONDS


def _parse_iso_ms(value: str) -> Optional[int]:
    """Parse an ISO-8601 string to epoch ms, or ``None`` if unparseable (TS ``Date.parse``)."""
    from datetime import datetime

    try:
        normalized = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def _missing_required_fields(mandate: Ap2PaymentMandate) -> List[str]:
    """Identify which required fields are missing/blank on a mandate (ap2.ts:113)."""
    missing: List[str] = []
    for f in REQUIRED_MANDATE_FIELDS:
        value = getattr(mandate, f, None)
        if not isinstance(value, str) or len(value) == 0:
            missing.append(f)
    return missing


def ap2_mandate_to_payment_requirements(mandate: Ap2PaymentMandate) -> PaymentRequirements:
    """Translate an AP2 Payment Mandate into x402 :class:`PaymentRequirements` (ap2.ts:147).

    Uses scheme ``'exact'``, ``pay_to = mandate.payee``, ``token = mandate.currency``,
    and a ``max_timeout_seconds`` derived from ``expires_at`` (else 300s default).
    Does NOT verify the AP2 VC signature (see module trust boundary).

    :raises PayBotApiError: ``INVALID_AP2_MANDATE`` (400) on a missing field,
        ``UNSUPPORTED_TOKEN`` (400) on unknown currency, ``UNSUPPORTED_NETWORK``
        (400) when the token is known but not deployed on ``network``.
    """
    missing = _missing_required_fields(mandate)
    if missing:
        raise PayBotApiError(
            f"AP2 mandate missing required field(s): {', '.join(missing)}",
            "INVALID_AP2_MANDATE",
            400,
            {"missing": missing},
        )

    currency = mandate.currency
    network = mandate.network

    if get_token(currency) is None:
        raise PayBotApiError(
            f"Unsupported token: {currency}",
            "UNSUPPORTED_TOKEN",
            400,
            {"currency": currency},
        )

    asset = get_token_address(currency, network)
    if not asset:
        raise PayBotApiError(
            f"Token {currency} is not available on network: {network}",
            "UNSUPPORTED_NETWORK",
            400,
            {"currency": currency, "network": network},
        )

    return PaymentRequirements(
        scheme="exact",
        network=network,
        asset=f"{network}/erc20:{asset}",
        amount=mandate.amount,
        pay_to=mandate.payee,
        max_timeout_seconds=_derive_max_timeout_seconds(mandate.expires_at),
        token=currency,
    )


def is_ap2_mandate(x: Any) -> bool:
    """Structural check for an :class:`Ap2PaymentMandate` (ap2.ts:210).

    Accepts either an :class:`Ap2PaymentMandate` instance or a plain ``dict`` with
    the required string fields present. Does NOT validate semantics (address
    format, expiry, VC signature). Mirrors the TS ``TypeGuard``.

    :param x: The value to test.
    :returns: ``True`` if ``x`` structurally matches an :class:`Ap2PaymentMandate`.
    """
    if isinstance(x, Ap2PaymentMandate):
        return len(_missing_required_fields(x)) == 0
    if not isinstance(x, dict):
        return False
    for f in REQUIRED_MANDATE_FIELDS:
        value = x.get(f)
        if not isinstance(value, str) or len(value) == 0:
            return False
    return True


class Ap2Adapter:
    """Adapter that settles AP2 Payment Mandates through the x402 rail (ap2.ts:247).

    Wraps an injected :class:`X402Handler`: builds x402 requirements from the
    mandate, synthesizes a minimal x402 :class:`PaymentPayload`, signs it, and
    submits it. The handler owns the wallet key and EIP-3009 signing; the adapter
    owns only the AP2 -> x402 translation.

    TRUST BOUNDARY: the adapter does NOT verify the AP2 VC signature.
    """

    def __init__(self, handler: X402Handler) -> None:
        """:param handler: The :class:`X402Handler` that holds the wallet key."""
        self._handler = handler

    def validate_mandate(
        self, mandate: Ap2PaymentMandate, now_ms: Optional[int] = None
    ) -> Dict[str, Any]:
        """Validate a mandate is structurally complete and not expired (ap2.ts:274).

        NOT an authenticity check — the AP2 VC signature is not verified here.
        Returns a result dict rather than raising so callers can branch cheaply.

        :param mandate: The mandate to validate.
        :param now_ms: Current epoch ms (injectable for deterministic tests).
        :returns: ``{"valid": True}`` when complete and unexpired; otherwise
            ``{"valid": False, "reason": <first failure>}``.
        """
        if now_ms is None:
            now_ms = int(time.time() * 1000)

        missing = _missing_required_fields(mandate)
        if missing:
            return {"valid": False, "reason": f"missing required field(s): {', '.join(missing)}"}

        if mandate.expires_at:
            exp_ms = _parse_iso_ms(mandate.expires_at)
            if exp_ms is None:
                return {"valid": False, "reason": "expiresAt is not a valid ISO-8601 date"}
            if exp_ms <= now_ms:
                return {"valid": False, "reason": "mandate expired"}

        return {"valid": True}

    async def settle(
        self, mandate: Ap2PaymentMandate, opts: Optional[Ap2SettleOptions] = None
    ) -> Receipt:
        """Settle an AP2 Payment Mandate over x402 (ap2.ts:323).

        Steps: validate -> translate to :class:`PaymentRequirements` -> wrap in a
        minimal x402 :class:`PaymentPayload` (protocol ``'x402'``) -> sign via the
        injected handler -> submit -> return the :class:`Receipt`.

        Does NOT verify the AP2 VC signature (see module trust boundary).

        :raises PayBotApiError: ``INVALID_AP2_MANDATE`` (400) when the mandate fails
            :meth:`validate_mandate`; ``UNSUPPORTED_TOKEN`` / ``UNSUPPORTED_NETWORK``
            bubbled from :func:`ap2_mandate_to_payment_requirements`.
        """
        if opts is None:
            opts = Ap2SettleOptions()

        validation = self.validate_mandate(mandate)
        if not validation["valid"]:
            raise PayBotApiError(
                f"Cannot settle AP2 mandate: {validation.get('reason')}",
                "INVALID_AP2_MANDATE",
                400,
                {"reason": validation.get("reason")},
            )

        requirements = ap2_mandate_to_payment_requirements(mandate)

        now_ms = int(time.time() * 1000)
        payment_intent = PaymentIntent(
            intent_id=mandate.intent_id or f"ap2_{mandate.mandate_id}",
            protocol="x402",
            requirements=requirements,
            version="2.0",
            created_at=_iso_from_ms(now_ms),
            expires_at=_iso_from_ms(now_ms + requirements.max_timeout_seconds * 1000),
        )
        payload = PaymentPayload(payment_intent=payment_intent, requirements=requirements)

        signed = await self._handler.sign_payment(payload)
        return await self._handler.submit_payment(
            signed,
            opts.payment_endpoint or DEFAULT_PAYMENT_ENDPOINT,
            opts.auth_token,
        )
