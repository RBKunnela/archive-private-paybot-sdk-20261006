"""x402 v2 protocol handler — Python port of ``src/x402-v2.ts``.

Full x402 v2 implementation with MPP (Machine Payments Protocol) dual-mode
compatibility: HTTP 402 Payment Required handling, Payment-Intent / PAYMENT-REQUIRED
header negotiation, EIP-712 typed-data signing (EIP-3009 TransferWithAuthorization
and the MPP PaymentAuthorization), the x402 v2 ``upto`` metered-billing scheme,
PAYMENT-SIGNATURE / PAYMENT-RESPONSE header support, and receipt submit/verify.

Signing uses ``eth-account`` (matching ``_sign_payload`` in client.py) so the wire
format is byte-for-byte compatible with the TS SDK (viem) for cross-runtime parity.

Dependencies: ``httpx`` (submit/verify), ``eth-account`` (signing, ``signing`` extra).
"""
from __future__ import annotations

import base64
import json
import time
from typing import Any, Dict, Optional

import httpx

from .crypto import generate_eip3009_nonce
from .errors import PayBotApiError, get_error_message
from .networks import (
    EIP3009_TYPES,
    get_eip712_domain,
    get_token,
    parse_caip2,
)
from .types import (
    PaymentIntent,
    PaymentPayload,
    PaymentRequiredResponse,
    PaymentRequirements,
    PaymentResponseConfirmation,
    Receipt,
    SignedPayment,
)


# MPP PaymentAuthorization typed-data structure (distinct from EIP-3009).
_MPP_TYPES = {
    "PaymentAuthorization": [
        {"name": "payer", "type": "address"},
        {"name": "recipient", "type": "address"},
        {"name": "amount", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "expires", "type": "uint256"},
        {"name": "paymentIntent", "type": "string"},
    ],
}


def _now_ms() -> int:
    """Current epoch milliseconds (mirrors ``Date.now()``)."""
    return int(time.time() * 1000)


def _read_header_ci(headers: Dict[str, str], name: str) -> Optional[str]:
    """Read ``headers[name]`` case-insensitively. ``None`` when absent."""
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return None


def _b64encode_json(payload: Dict[str, Any]) -> str:
    """Base64 of a JSON object (compact, matching ``Buffer.from(JSON.stringify))``."""
    return base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


def _requirements_to_dict(req: PaymentRequirements) -> Dict[str, Any]:
    """Project a :class:`PaymentRequirements` to its camelCase wire dict."""
    out: Dict[str, Any] = {
        "scheme": req.scheme,
        "network": req.network,
        "asset": req.asset,
        "amount": req.amount,
        "payTo": req.pay_to,
        "maxTimeoutSeconds": req.max_timeout_seconds,
    }
    if req.min_amount is not None:
        out["minAmount"] = req.min_amount
    if req.max_amount is not None:
        out["maxAmount"] = req.max_amount
    if req.token is not None:
        out["token"] = req.token
    return out


def _requirements_from_dict(data: Dict[str, Any]) -> PaymentRequirements:
    """Build a :class:`PaymentRequirements` from a camelCase wire dict.

    Tolerant of ``payTo``/``pay_to`` and ``maxTimeoutSeconds``/``max_timeout_seconds``
    so it round-trips both TS-shaped and Python-shaped payloads.
    """
    pay_to = data.get("payTo") or data.get("pay_to") or ""
    max_timeout = data.get("maxTimeoutSeconds")
    if max_timeout is None:
        max_timeout = data.get("max_timeout_seconds", 300)
    return PaymentRequirements(
        scheme=data.get("scheme", "exact"),
        network=data.get("network", ""),
        asset=data.get("asset", ""),
        amount=str(data.get("amount", "0")),
        pay_to=pay_to,
        max_timeout_seconds=int(max_timeout),
        min_amount=data.get("minAmount") or data.get("min_amount"),
        max_amount=data.get("maxAmount") or data.get("max_amount"),
        token=data.get("token"),
    )


class X402Handler:
    """x402 v2 handler — complete protocol implementation.

    :param wallet_private_key: Optional hex (``0x``-prefixed) wallet key. Required
        only for signing (``sign_payment`` / ``sign_upto``); detection and parsing
        helpers work without it.
    :raises ValueError: when ``wallet_private_key`` is set but not ``0x``-prefixed.
    """

    def __init__(self, wallet_private_key: Optional[str] = None) -> None:
        if wallet_private_key and not wallet_private_key.startswith("0x"):
            raise ValueError("X402Handler: wallet_private_key must start with 0x")
        self._wallet_private_key = wallet_private_key

    # ── 402 response parsing ─────────────────────────────────────────────

    def on_402_response(self, response: PaymentRequiredResponse) -> PaymentPayload:
        """Parse an HTTP 402 Payment Required response into a :class:`PaymentPayload`.

        Prefers the x402 v2 ``PAYMENT-REQUIRED`` header (base64 of the
        requirements) when present, otherwise falls back to the legacy
        ``Payment-Intent`` (``x402:v2:<base64>``) header — purely additive.

        :param response: The 402 response (status, headers, body).
        :returns: The parsed :class:`PaymentPayload`.
        :raises PayBotApiError: ``INVALID_HTTP_STATUS`` when status is not 402;
            ``INVALID_PAYMENT_INTENT_FORMAT`` / ``MISSING_PAYMENT_INTENT_HEADER`` /
            ``INVALID_PAYMENT_BODY`` / ``MISSING_PAYMENT_REQUIREMENTS`` on bad input.
        """
        if response.status != 402:
            raise PayBotApiError(
                f"Expected HTTP 402 Payment Required, got {response.status}",
                "INVALID_HTTP_STATUS",
                response.status,
            )

        v2_header = _read_header_ci(response.headers, "PAYMENT-REQUIRED")
        if v2_header:
            payment_intent = self._parse_payment_required_header(v2_header)
            body = self._parse_payment_response_body(response.body)
            return PaymentPayload(
                payment_intent=payment_intent,
                requirements=body["requirements"],
                merchant=body.get("merchant"),
                meta=body.get("meta"),
            )

        header = self._extract_payment_intent_header(response.headers)
        payment_intent = self._parse_payment_intent(header)
        body = self._parse_payment_response_body(response.body)
        return PaymentPayload(
            payment_intent=payment_intent,
            requirements=body["requirements"],
            merchant=body.get("merchant"),
            meta=body.get("meta"),
        )

    def _parse_payment_required_header(self, header_value: str) -> PaymentIntent:
        """Parse an x402 v2 ``PAYMENT-REQUIRED`` header (base64 JSON, no prefix)."""
        try:
            decoded = base64.b64decode(header_value).decode("utf-8")
            parsed = json.loads(decoded)
        except Exception as error:  # noqa: BLE001
            raise PayBotApiError(
                f"Failed to parse PAYMENT-REQUIRED header: {get_error_message(error)}",
                "INVALID_PAYMENT_INTENT_FORMAT",
                402,
            )

        # Full PaymentIntent? (carries its own requirements) — use as-is.
        if isinstance(parsed, dict) and isinstance(parsed.get("requirements"), dict):
            return self._payment_intent_from_dict(parsed)

        # Otherwise treat the payload itself as bare requirements and synthesize
        # a minimal v2 PaymentIntent envelope around it.
        now_ms = _now_ms()
        return PaymentIntent(
            intent_id=f"intent_{now_ms}",
            protocol="x402",
            requirements=_requirements_from_dict(parsed if isinstance(parsed, dict) else {}),
            version="2.0",
            created_at=_iso(now_ms),
            expires_at=_iso(now_ms + 300_000),
        )

    @staticmethod
    def _extract_payment_intent_header(headers: Dict[str, str]) -> str:
        """Extract the legacy ``Payment-Intent`` header (raises if missing).

        Uses :func:`_read_header_ci` for full case-insensitivity instead of the
        previous two hardcoded casings, which missed e.g. ``PAYMENT-INTENT``
        (CodeRabbit #14).
        """
        header = _read_header_ci(headers, "Payment-Intent")
        if not header:
            raise PayBotApiError(
                "Payment-Intent header missing from 402 response",
                "MISSING_PAYMENT_INTENT_HEADER",
                402,
            )
        return header

    def _parse_payment_intent(self, header_value: str) -> PaymentIntent:
        """Parse a legacy ``Payment-Intent`` header (``x402:v2:<base64>``)."""
        try:
            parts = header_value.split(":")
            if len(parts) < 3 or parts[0] != "x402" or parts[1] != "v2":
                raise ValueError("Invalid Payment-Intent header format")
            payload = ":".join(parts[2:])
            decoded = base64.b64decode(payload).decode("utf-8")
            return self._payment_intent_from_dict(json.loads(decoded))
        except PayBotApiError:
            raise
        except Exception as error:  # noqa: BLE001
            raise PayBotApiError(
                f"Failed to parse Payment-Intent header: {get_error_message(error)}",
                "INVALID_PAYMENT_INTENT_FORMAT",
                402,
            )

    @staticmethod
    def _payment_intent_from_dict(data: Dict[str, Any]) -> PaymentIntent:
        """Build a :class:`PaymentIntent` from a decoded header dict."""
        now_ms = _now_ms()
        return PaymentIntent(
            intent_id=data.get("intentId") or data.get("intent_id") or f"intent_{now_ms}",
            protocol=data.get("protocol", "x402"),
            requirements=_requirements_from_dict(data.get("requirements", {})),
            version=data.get("version", "2.0"),
            created_at=data.get("createdAt") or data.get("created_at") or _iso(now_ms),
            expires_at=data.get("expiresAt") or data.get("expires_at") or _iso(now_ms + 300_000),
        )

    @staticmethod
    def _parse_payment_response_body(body: Any) -> Dict[str, Any]:
        """Parse the 402 response body; extract requirements + optional merchant/meta."""
        if not isinstance(body, dict):
            raise PayBotApiError(
                "Payment response body missing or invalid",
                "INVALID_PAYMENT_BODY",
                402,
            )
        reqs = body.get("requirements")
        if not isinstance(reqs, dict):
            raise PayBotApiError(
                "Payment requirements missing from response body",
                "MISSING_PAYMENT_REQUIREMENTS",
                402,
            )
        return {
            "requirements": _requirements_from_dict(reqs),
            "merchant": body.get("merchant"),
            "meta": body.get("meta"),
        }

    # ── Signing ──────────────────────────────────────────────────────────

    def _resolve_domain(self, requirements: PaymentRequirements) -> Dict[str, Any]:
        """Resolve the EIP-712 domain for a requirements' network + token.

        :raises PayBotApiError: ``INVALID_CAIP2`` (malformed network),
            ``UNSUPPORTED_TOKEN`` (unknown symbol), or ``UNSUPPORTED_NETWORK``
            (well-formed network with no registered domain).
        """
        network = requirements.network or "eip155:8453"
        symbol = requirements.token or "USDC"

        # Throws INVALID_CAIP2 for malformed network strings.
        parse_caip2(network)

        if get_token(symbol) is None:
            raise PayBotApiError(
                f"Unsupported token: {symbol}", "UNSUPPORTED_TOKEN", 402
            )

        domain = get_eip712_domain(network, symbol)
        if domain is None:
            raise PayBotApiError(
                f"No EIP-712 domain for network: {network}",
                "UNSUPPORTED_NETWORK",
                402,
            )
        return domain

    def _account(self):
        """Return the eth-account ``Account`` derived from the wallet key."""
        from eth_account import Account

        return Account.from_key(self._wallet_private_key)

    def _sign_x402(
        self, account: Any, requirements: PaymentRequirements
    ) -> Dict[str, Any]:
        """Sign an x402 native EIP-3009 ``TransferWithAuthorization``.

        :returns: ``{'signature': str, 'signed_data': dict}`` where ``signed_data``
            carries ``{from, to, value, validAfter, validBefore, nonce, signature}``.
        :raises PayBotApiError: ``UNSUPPORTED_NETWORK`` / ``UNSUPPORTED_TOKEN`` /
            ``INVALID_CAIP2`` from :meth:`_resolve_domain`.
        """
        from eth_account import Account

        domain = self._resolve_domain(requirements)
        nonce = generate_eip3009_nonce()
        now_seconds = int(time.time())
        valid_after = 0
        valid_before = now_seconds + 3600  # 1 hour from now
        value = int(requirements.amount)

        message = {
            "from": account.address,
            "to": requirements.pay_to,
            "value": value,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce,
        }
        signed = Account.sign_typed_data(
            self._wallet_private_key, domain, EIP3009_TYPES, message
        )
        signature = _hex_sig(signed.signature)

        signed_data: Dict[str, Any] = {
            "from": account.address,
            "to": requirements.pay_to,
            "value": requirements.amount,
            "validAfter": str(valid_after),
            "validBefore": str(valid_before),
            "nonce": nonce,
            "signature": signature,
        }
        return {"signature": signature, "signed_data": signed_data}

    def _sign_mpp(
        self,
        account: Any,
        requirements: PaymentRequirements,
        intent_id: Optional[str],
    ) -> Dict[str, Any]:
        """Sign an MPP (Stripe/Tempo) ``PaymentAuthorization``.

        The typed-data structure differs from x402's EIP-3009, so the resulting
        signature MUST differ from :meth:`_sign_x402` for the same inputs.

        :returns: ``{'signature': str, 'signed_data': dict}`` with MPP-shaped
            ``{payer, recipient, amount, nonce, expires, paymentIntent, signature}``.
        """
        from eth_account import Account

        domain = {
            "name": "Machine Payments Protocol",
            "version": "1.0",
            "chainId": 1,  # Ethereum mainnet
            "verifyingContract": requirements.pay_to,
        }
        nonce = generate_eip3009_nonce()
        now_seconds = int(time.time())
        # Single source of truth for the expiry: the value we sign MUST be the
        # value we put on the wire (see CodeRabbit #15). Previously the signed
        # message used ``now + 3600`` while ``signed_data`` serialized ``now``,
        # a 3600s + type divergence that made every MPP signature unverifiable.
        expires = now_seconds + 3600
        payment_intent = intent_id or "unknown"

        message = {
            "payer": account.address,
            "recipient": requirements.pay_to,
            "amount": int(requirements.amount),
            "nonce": nonce,
            "expires": expires,
            "paymentIntent": payment_intent,
        }
        signed = Account.sign_typed_data(
            self._wallet_private_key, domain, _MPP_TYPES, message
        )
        signature = _hex_sig(signed.signature)

        signed_data: Dict[str, Any] = {
            "payer": account.address,
            "recipient": requirements.pay_to,
            "amount": requirements.amount,
            "nonce": nonce,
            "expires": str(expires),
            "paymentIntent": payment_intent,
            "signature": signature,
        }
        return {"signature": signature, "signed_data": signed_data}

    def sign_upto(
        self, account: Any, requirements: PaymentRequirements
    ) -> Dict[str, Any]:
        """Sign an x402 v2 ``upto`` (metered / usage-billing) authorization.

        The payer signs an EIP-3009 ``TransferWithAuthorization`` for the MAXIMUM
        amount — ``requirements.max_amount`` when present, else
        ``requirements.amount`` — authorizing the merchant to capture UP TO that
        max. The signed ``value`` equals the authorized max (NOT the eventual
        capture). The returned ``signed_data`` carries ``scheme: 'upto'`` and a
        ``maxAmount`` marker.

        :param account: The eth-account ``Account`` to sign with.
        :param requirements: Payment requirements. ``max_amount`` (else ``amount``) is the cap.
        :returns: ``{'signature': str, 'signed_data': dict}``.
        :raises PayBotApiError: ``INVALID_CAIP2`` / ``UNSUPPORTED_NETWORK`` /
            ``UNSUPPORTED_TOKEN`` from :meth:`_resolve_domain`.

        :example:
            >>> r = handler.sign_upto(acct, reqs_upto)
            >>> r["signed_data"]["scheme"]
            'upto'
        """
        from eth_account import Account

        domain = self._resolve_domain(requirements)
        # `upto` authorizes the MAX, not the requested amount.
        authorized_max = requirements.max_amount or requirements.amount
        nonce = generate_eip3009_nonce()
        now_seconds = int(time.time())
        valid_after = 0
        valid_before = now_seconds + 3600
        value = int(authorized_max)

        message = {
            "from": account.address,
            "to": requirements.pay_to,
            "value": value,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce,
        }
        signed = Account.sign_typed_data(
            self._wallet_private_key, domain, EIP3009_TYPES, message
        )
        signature = _hex_sig(signed.signature)

        signed_data: Dict[str, Any] = {
            "from": account.address,
            "to": requirements.pay_to,
            "value": authorized_max,
            "scheme": "upto",
            "maxAmount": authorized_max,
            "validAfter": str(valid_after),
            "validBefore": str(valid_before),
            "nonce": nonce,
            "signature": signature,
        }
        return {"signature": signature, "signed_data": signed_data}

    @staticmethod
    def validate_upto_capture(authorized_max: str, captured: str) -> str:
        """Validate that a captured amount does not exceed the authorized max.

        Amounts are base-unit decimal strings; comparison uses ``int`` to avoid
        float rounding. A capture exactly equal to the max is allowed.

        :param authorized_max: The signed maximum (base-unit decimal string).
        :param captured: The amount the merchant wants to capture (base-unit string).
        :returns: The normalized captured amount string when valid.
        :raises PayBotApiError: ``UPTO_OVERCHARGE`` (402) when ``captured`` exceeds
            ``authorized_max``; ``INVALID_AMOUNT`` (400) when either value is not a
            non-negative integer string.

        :example:
            >>> X402Handler.validate_upto_capture("5000000", "3000000")
            '3000000'
        """
        max_v = X402Handler._parse_base_unit_amount(authorized_max, "authorizedMax")
        cap_v = X402Handler._parse_base_unit_amount(captured, "captured")
        if cap_v > max_v:
            raise PayBotApiError(
                f"upto capture {captured} exceeds authorized max {authorized_max}",
                "UPTO_OVERCHARGE",
                402,
                {"authorizedMax": authorized_max, "captured": captured},
            )
        return str(cap_v)

    @staticmethod
    def _parse_base_unit_amount(value: str, label: str) -> int:
        """Parse a non-negative integer base-unit amount string into an ``int``."""
        if not isinstance(value, str) or not value.isdigit():
            raise PayBotApiError(
                f"Invalid {label}: expected a non-negative integer string, got '{value}'",
                "INVALID_AMOUNT",
                400,
                {label: value},
            )
        return int(value)

    def sign_payment(self, payload: PaymentPayload) -> SignedPayment:
        """Sign a payment payload using EIP-712 typed data.

        Dispatches on scheme then protocol:

        - scheme ``'upto'`` → :meth:`sign_upto` (overrides protocol dispatch)
        - protocol ``'x402'`` → :meth:`_sign_x402` only
        - protocol ``'mpp'`` → :meth:`_sign_mpp` only
        - protocol ``'dual'`` → BOTH; ``signed_data = {'x402': ..., 'mpp': ...}``
          and the top-level ``signature`` mirrors the x402 signature (primary).

        :param payload: Parsed :class:`PaymentPayload` from an HTTP 402 response.
        :returns: A :class:`SignedPayment`.
        :raises PayBotApiError: ``MISSING_WALLET_KEY`` (no key configured),
            ``UNSUPPORTED_NETWORK`` (bubbled from signing), or ``UNSUPPORTED_PROTOCOL``.
        """
        if not self._wallet_private_key:
            raise PayBotApiError(
                "Wallet private key required for signing payments",
                "MISSING_WALLET_KEY",
                402,
            )

        account = self._account()
        requirements = payload.payment_intent.requirements
        protocol = payload.payment_intent.protocol

        if requirements.scheme == "upto":
            r = self.sign_upto(account, requirements)
            return SignedPayment(
                protocol=protocol,
                signed_data=r["signed_data"],
                signature=r["signature"],
                timestamp=_now_ms(),
            )

        if protocol == "x402":
            r = self._sign_x402(account, requirements)
            signature, signed_data = r["signature"], r["signed_data"]
        elif protocol == "mpp":
            r = self._sign_mpp(account, requirements, payload.payment_intent.intent_id)
            signature, signed_data = r["signature"], r["signed_data"]
        elif protocol == "dual":
            x = self._sign_x402(account, requirements)
            m = self._sign_mpp(account, requirements, payload.payment_intent.intent_id)
            signature = x["signature"]  # primary signature = x402
            signed_data = {"x402": x["signed_data"], "mpp": m["signed_data"]}
        else:
            raise PayBotApiError(
                f"Unsupported payment protocol: {protocol}",
                "UNSUPPORTED_PROTOCOL",
                402,
            )

        return SignedPayment(
            protocol=protocol,
            signed_data=signed_data,
            signature=signature,
            timestamp=_now_ms(),
        )

    # ── Submit / verify ──────────────────────────────────────────────────

    async def submit_payment(
        self,
        signed: SignedPayment,
        payment_endpoint: str,
        auth_token: Optional[str] = None,
    ) -> Receipt:
        """Submit a signed payment to the payment endpoint.

        Sends the legacy ``Payment-Intent-Authorization`` header (``x402:v2:<b64>``)
        and the x402 v2 ``PAYMENT-SIGNATURE`` header (bare base64) so both v1 and
        v2 facilitators can read the form they expect.

        :param signed: The signed payment.
        :param payment_endpoint: The facilitator/merchant settlement URL.
        :param auth_token: Optional bearer token.
        :returns: The settlement :class:`Receipt`.
        :raises PayBotApiError: ``PAYMENT_SUBMISSION_FAILED`` (non-2xx) or
            ``PAYMENT_SUBMISSION_ERROR`` (transport).
        """
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if auth_token:
            headers["Authorization"] = f"Bearer {auth_token}"
        headers["Payment-Intent-Authorization"] = self._encode_signed_payment(signed)
        headers["PAYMENT-SIGNATURE"] = self.encode_payment_signature_header(signed)

        body = {"protocol": signed.protocol, **signed.signed_data}
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(payment_endpoint, headers=headers, json=body)
        except httpx.HTTPError as error:
            raise PayBotApiError(
                f"Failed to submit payment: {get_error_message(error)}",
                "PAYMENT_SUBMISSION_ERROR",
                0,
            )

        if response.status_code < 200 or response.status_code >= 300:
            try:
                err = response.json()
            except Exception:  # noqa: BLE001
                err = {}
            raise PayBotApiError(
                err.get("error") or f"HTTP {response.status_code}",
                err.get("code") or "PAYMENT_SUBMISSION_FAILED",
                response.status_code,
                err.get("details"),
            )

        # A 2xx response can still carry a malformed/missing body. The non-2xx
        # branch already guards response.json(); the success branch must too, or
        # a bad body raises a bare ValueError/KeyError instead of a typed
        # PayBotApiError (CodeRabbit #16).
        try:
            receipt = response.json()
        except Exception as error:  # noqa: BLE001
            raise PayBotApiError(
                f"Invalid JSON in payment receipt: {get_error_message(error)}",
                "INVALID_RECEIPT",
                response.status_code,
            )
        if not isinstance(receipt, dict) or not receipt.get("receiptId"):
            raise PayBotApiError(
                "Payment receipt missing receiptId",
                "INVALID_RECEIPT",
                response.status_code,
            )
        return Receipt(
            receipt_id=receipt["receiptId"],
            transaction_id=receipt.get("transactionId"),
            status=receipt.get("status", "pending"),
            confirmed_at=receipt.get("confirmedAt"),
            amount=receipt.get("amount", "0"),
            network=receipt.get("network", ""),
            block_number=receipt.get("blockNumber"),
            gas_used=receipt.get("gasUsed"),
        )

    async def verify_receipt(self, receipt: Receipt, verification_endpoint: str) -> bool:
        """Verify a payment receipt with the merchant. Never raises — returns
        ``False`` on any transport error or non-2xx / unverified response.

        :param receipt: The receipt to verify.
        :param verification_endpoint: The merchant verification URL.
        :returns: ``True`` only when the endpoint responds 2xx with ``verified: true``.
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    verification_endpoint,
                    headers={"Content-Type": "application/json"},
                    json={
                        "receiptId": receipt.receipt_id,
                        "transactionId": receipt.transaction_id,
                    },
                )
            if response.status_code < 200 or response.status_code >= 300:
                return False
            data = response.json()
            return data.get("verified") is True
        except Exception:  # noqa: BLE001 - verification is best-effort
            return False

    # ── Header encoding helpers ──────────────────────────────────────────

    @staticmethod
    def _encode_signed_payment(signed: SignedPayment) -> str:
        """Encode for the legacy ``Payment-Intent-Authorization`` header."""
        payload = {
            "protocol": signed.protocol,
            "signedData": signed.signed_data,
            "signature": signed.signature,
            "timestamp": signed.timestamp,
        }
        return f"x402:v2:{_b64encode_json(payload)}"

    @staticmethod
    def encode_payment_signature_header(signed: SignedPayment) -> str:
        """Encode for the x402 v2 ``PAYMENT-SIGNATURE`` header (bare base64, no prefix)."""
        payload = {
            "protocol": signed.protocol,
            "signedData": signed.signed_data,
            "signature": signed.signature,
            "timestamp": signed.timestamp,
        }
        return _b64encode_json(payload)

    @staticmethod
    def parse_payment_response_header(header_value: str) -> PaymentResponseConfirmation:
        """Parse an x402 v2 ``PAYMENT-RESPONSE`` header into a settlement confirmation.

        The value is base64-encoded JSON. Tolerant of field-name variants
        (``receiptId``/``receipt_id``, ``transactionId``/``transaction_id``/``txHash``).

        :param header_value: The base64-encoded header value.
        :returns: A :class:`PaymentResponseConfirmation`.
        :raises PayBotApiError: ``INVALID_PAYMENT_RESPONSE`` (502) on bad base64 JSON
            or a missing ``receiptId``.
        """
        try:
            decoded = base64.b64decode(header_value).decode("utf-8")
            parsed = json.loads(decoded)
        except Exception as error:  # noqa: BLE001
            raise PayBotApiError(
                f"Failed to parse PAYMENT-RESPONSE header: {get_error_message(error)}",
                "INVALID_PAYMENT_RESPONSE",
                502,
            )

        if not isinstance(parsed, dict):
            raise PayBotApiError(
                "PAYMENT-RESPONSE header did not decode to an object",
                "INVALID_PAYMENT_RESPONSE",
                502,
            )

        receipt_id = parsed.get("receiptId") or parsed.get("receipt_id")
        if not isinstance(receipt_id, str) or len(receipt_id) == 0:
            raise PayBotApiError(
                "PAYMENT-RESPONSE header missing receiptId",
                "INVALID_PAYMENT_RESPONSE",
                502,
            )

        raw_status = parsed.get("status") or "pending"
        status = raw_status if raw_status in ("confirmed", "failed") else "pending"
        transaction_id = (
            parsed.get("transactionId")
            or parsed.get("transaction_id")
            or parsed.get("txHash")
        )
        return PaymentResponseConfirmation(
            receipt_id=receipt_id,
            status=status,
            transaction_id=transaction_id,
        )

    @staticmethod
    def create_payment_intent_header(intent: PaymentIntent) -> str:
        """Create a ``Payment-Intent`` header value (``x402:v2:<base64>``) for
        merchant endpoints (when acting as the payment receiver).
        """
        payload = {
            "intentId": intent.intent_id,
            "protocol": intent.protocol,
            "requirements": _requirements_to_dict(intent.requirements),
            "version": intent.version,
            "createdAt": intent.created_at,
            "expiresAt": intent.expires_at,
        }
        return f"x402:v2:{_b64encode_json(payload)}"

    @staticmethod
    def negotiate_payment_intent(
        requirements: PaymentRequirements,
        supported_protocols: Optional[list] = None,
    ) -> PaymentIntent:
        """Negotiate payment parameters with a merchant.

        Defaults to dual-mode for compatibility. ``supported_protocols`` is
        accepted for parity but not yet honored (mirrors the TS TODO).
        """
        now_ms = _now_ms()
        return PaymentIntent(
            intent_id=f"intent_{now_ms}",
            protocol="dual",
            requirements=requirements,
            version="2.0",
            created_at=_iso(now_ms),
            expires_at=_iso(now_ms + 300_000),
        )


def _iso(epoch_ms: int) -> str:
    """ISO-8601 UTC string (``...Z``) from epoch ms (mirrors ``toISOString()``)."""
    import datetime

    return (
        datetime.datetime.fromtimestamp(epoch_ms / 1000, tz=datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _hex_sig(signature: Any) -> str:
    """Normalize an eth-account signature to a ``0x``-prefixed hex string."""
    sig_hex = signature.hex()
    return sig_hex if sig_hex.startswith("0x") else "0x" + sig_hex
