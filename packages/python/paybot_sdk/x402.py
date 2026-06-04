"""x402 v2 Protocol Handler. Mirrors ``src/x402-v2.ts``.

Full x402 v2 implementation with MPP (Machine Payments Protocol) dual-mode
compatibility: HTTP 402 Payment Required response handling, Payment-Intent header
negotiation, EIP-712 typed-data signing (via ``eth-account``), and receipt
verification.

The async methods keep ``async def`` for API parity with the TS SDK even though
``eth-account`` signing is synchronous inside — the real ``await`` points are the
HTTP calls in :meth:`X402Handler.submit_payment` / :meth:`verify_receipt`.

References:
- x402 Foundation Specification v2.0
- MPP (Stripe/Tempo) dual-mode protocol
- EIP-712 typed structured data / EIP-3009 TransferWithAuthorization
"""
from __future__ import annotations

import base64
import json
import time
from dataclasses import asdict
from typing import Any, Dict, List, Optional

import httpx

from .crypto import generate_eip3009_nonce
from .errors import PayBotApiError, get_error_message
from .networks import EIP3009_TYPES, get_eip712_domain, get_token, parse_caip2
from .types import (
    MerchantInfo,
    PaymentIntent,
    PaymentMetadata,
    PaymentPayload,
    PaymentProtocol,
    PaymentRequiredResponse,
    PaymentRequirements,
    PaymentResponseConfirmation,
    Receipt,
    SignedPayment,
)


def _now_ms() -> int:
    """Current epoch milliseconds (matches TS ``Date.now()``)."""
    return int(time.time() * 1000)


def _b64encode_json(obj: Any) -> str:
    """Base64 of a JSON-serialized object (TS ``Buffer.from(JSON.stringify(x)).toString('base64')``)."""
    return base64.b64encode(json.dumps(obj).encode("utf-8")).decode("ascii")


def _b64decode_json(value: str) -> Any:
    """Decode base64 → JSON (TS ``Buffer.from(b64,'base64').toString('utf-8')`` + ``JSON.parse``)."""
    return json.loads(base64.b64decode(value).decode("utf-8"))


def _requirements_from_dict(data: Dict[str, Any]) -> PaymentRequirements:
    """Build a :class:`PaymentRequirements` from a wire dict (camelCase keys).

    Tolerant of either camelCase (``payTo``, ``maxTimeoutSeconds``) wire fields or
    the snake_case dataclass fields, so round-tripping our own encoder and parsing
    a foreign server body both work.
    """
    return PaymentRequirements(
        scheme=data.get("scheme", "exact"),
        network=data.get("network", ""),
        asset=data.get("asset", ""),
        amount=data.get("amount", "0"),
        pay_to=data.get("payTo") or data.get("pay_to", ""),
        max_timeout_seconds=int(
            data.get("maxTimeoutSeconds")
            if data.get("maxTimeoutSeconds") is not None
            else data.get("max_timeout_seconds", 300)
        ),
        min_amount=data.get("minAmount") or data.get("min_amount"),
        max_amount=data.get("maxAmount") or data.get("max_amount"),
        token=data.get("token"),
    )


class X402Handler:
    """x402 v2 Handler — complete protocol implementation (x402-v2.ts:33)."""

    def __init__(self, wallet_private_key: Optional[str] = None) -> None:
        """Construct the handler (x402-v2.ts:36).

        :param wallet_private_key: Hex private key with ``0x`` prefix. When set,
            enables signing; ``None`` means :meth:`sign_payment` will raise
            ``MISSING_WALLET_KEY``.
        :raises ValueError: when the key is non-empty and does not start with ``0x``.
        """
        if wallet_private_key and not wallet_private_key.startswith("0x"):
            raise ValueError("X402Handler: wallet_private_key must start with 0x")
        self._wallet_private_key = wallet_private_key

    # ── parsing (sync) ────────────────────────────────────────────────────

    def on_402_response(self, response: PaymentRequiredResponse) -> PaymentPayload:
        """Parse an HTTP 402 Payment Required response (x402-v2.ts:47).

        Prefers the x402 v2 ``PAYMENT-REQUIRED`` header (base64 of requirements)
        when present; otherwise falls back to the legacy ``Payment-Intent``
        (``x402:v2:<base64>``) header. Both paths return a :class:`PaymentPayload`.

        :param response: The 402 response (status, headers, body).
        :returns: A parsed :class:`PaymentPayload`.
        :raises PayBotApiError: ``INVALID_HTTP_STATUS`` (non-402),
            ``MISSING_PAYMENT_INTENT_HEADER``, ``INVALID_PAYMENT_INTENT_FORMAT``,
            ``INVALID_PAYMENT_BODY``, or ``MISSING_PAYMENT_REQUIREMENTS``.
        """
        if response.status != 402:
            raise PayBotApiError(
                f"Expected HTTP 402 Payment Required, got {response.status}",
                "INVALID_HTTP_STATUS",
                response.status,
            )

        v2_header = self._read_header_ci(response.headers, "PAYMENT-REQUIRED")
        if v2_header:
            payment_intent = self._parse_payment_required_header(v2_header)
            requirements, merchant, meta = self._parse_payment_response_body(response.body)
            return PaymentPayload(
                payment_intent=payment_intent,
                requirements=requirements,
                merchant=merchant,
                meta=meta,
            )

        header = self._extract_payment_intent_header(response.headers)
        payment_intent = self._parse_payment_intent(header)
        requirements, merchant, meta = self._parse_payment_response_body(response.body)
        return PaymentPayload(
            payment_intent=payment_intent,
            requirements=requirements,
            merchant=merchant,
            meta=meta,
        )

    @staticmethod
    def _read_header_ci(headers: Dict[str, str], name: str) -> Optional[str]:
        """Read a header value case-insensitively (x402-v2.ts:96)."""
        target = name.lower()
        for key in headers:
            if key.lower() == target:
                return headers[key]
        return None

    def _intent_from_dict(self, data: Dict[str, Any]) -> PaymentIntent:
        """Build a :class:`PaymentIntent` from a decoded JSON dict (camelCase keys)."""
        reqs_raw = data.get("requirements") or {}
        requirements = (
            reqs_raw
            if isinstance(reqs_raw, PaymentRequirements)
            else _requirements_from_dict(reqs_raw)
        )
        merchant = data.get("merchant")
        meta = data.get("meta")
        return PaymentIntent(
            intent_id=data.get("intentId") or data.get("intent_id", ""),
            protocol=data.get("protocol", "x402"),
            requirements=requirements,
            version=data.get("version", "2.0"),
            created_at=data.get("createdAt") or data.get("created_at", ""),
            expires_at=data.get("expiresAt") or data.get("expires_at", ""),
            merchant=(
                MerchantInfo(
                    name=merchant.get("name", ""),
                    url=merchant.get("url", ""),
                    domain=merchant.get("domain"),
                )
                if isinstance(merchant, dict)
                else None
            ),
            meta=(
                PaymentMetadata(
                    description=meta.get("description"),
                    order_id=meta.get("orderId") or meta.get("order_id"),
                    custom=meta.get("custom"),
                )
                if isinstance(meta, dict)
                else None
            ),
        )

    def _parse_payment_required_header(self, header_value: str) -> PaymentIntent:
        """Parse an x402 v2 ``PAYMENT-REQUIRED`` header (x402-v2.ts:120).

        The value is the bare base64 of JSON (no ``x402:v2:`` prefix). The decoded
        JSON may be a full PaymentIntent (has ``requirements``) or a bare
        PaymentRequirements, in which case a minimal envelope is synthesized.

        :raises PayBotApiError: ``INVALID_PAYMENT_INTENT_FORMAT`` (402) on bad base64/JSON.
        """
        try:
            parsed = _b64decode_json(header_value)
            if isinstance(parsed, dict) and isinstance(parsed.get("requirements"), dict):
                return self._intent_from_dict(parsed)

            # Treat the payload itself as bare PaymentRequirements.
            now_ms = _now_ms()
            return PaymentIntent(
                intent_id=f"intent_{now_ms}",
                protocol="x402",
                requirements=_requirements_from_dict(parsed if isinstance(parsed, dict) else {}),
                version="2.0",
                created_at=_iso_from_ms(now_ms),
                expires_at=_iso_from_ms(now_ms + 300_000),
            )
        except PayBotApiError:
            raise
        except Exception as error:  # noqa: BLE001
            raise PayBotApiError(
                f"Failed to parse PAYMENT-REQUIRED header: {get_error_message(error)}",
                "INVALID_PAYMENT_INTENT_FORMAT",
                402,
            )

    @staticmethod
    def _extract_payment_intent_header(headers: Dict[str, str]) -> str:
        """Extract the legacy ``Payment-Intent`` header (x402-v2.ts:153).

        :raises PayBotApiError: ``MISSING_PAYMENT_INTENT_HEADER`` (402) when absent.
        """
        header = headers.get("Payment-Intent") or headers.get("payment-intent")
        if not header:
            raise PayBotApiError(
                "Payment-Intent header missing from 402 response",
                "MISSING_PAYMENT_INTENT_HEADER",
                402,
            )
        return header

    def _parse_payment_intent(self, header_value: str) -> PaymentIntent:
        """Parse a legacy ``x402:v2:<base64>`` Payment-Intent header (x402-v2.ts:170).

        :raises PayBotApiError: ``INVALID_PAYMENT_INTENT_FORMAT`` (402) on bad format.
        """
        try:
            parts = header_value.split(":")
            if len(parts) < 3 or parts[0] != "x402" or parts[1] != "v2":
                raise ValueError("Invalid Payment-Intent header format")
            payload = ":".join(parts[2:])
            parsed = _b64decode_json(payload)
            return self._intent_from_dict(parsed)
        except PayBotApiError:
            raise
        except Exception as error:  # noqa: BLE001
            raise PayBotApiError(
                f"Failed to parse Payment-Intent header: {get_error_message(error)}",
                "INVALID_PAYMENT_INTENT_FORMAT",
                402,
            )

    @staticmethod
    def _parse_payment_response_body(
        body: Any,
    ) -> tuple[PaymentRequirements, Optional[MerchantInfo], Optional[PaymentMetadata]]:
        """Parse the response body's requirements/merchant/meta (x402-v2.ts:194).

        :raises PayBotApiError: ``INVALID_PAYMENT_BODY`` (402) when body is not an
            object, ``MISSING_PAYMENT_REQUIREMENTS`` (402) when requirements absent.
        """
        if not body or not isinstance(body, dict):
            raise PayBotApiError(
                "Payment response body missing or invalid",
                "INVALID_PAYMENT_BODY",
                402,
            )
        reqs = body.get("requirements")
        if not reqs or not isinstance(reqs, dict):
            raise PayBotApiError(
                "Payment requirements missing from response body",
                "MISSING_PAYMENT_REQUIREMENTS",
                402,
            )
        merchant_raw = body.get("merchant")
        meta_raw = body.get("meta")
        merchant = (
            MerchantInfo(
                name=merchant_raw.get("name", ""),
                url=merchant_raw.get("url", ""),
                domain=merchant_raw.get("domain"),
            )
            if isinstance(merchant_raw, dict)
            else None
        )
        meta = (
            PaymentMetadata(
                description=meta_raw.get("description"),
                order_id=meta_raw.get("orderId") or meta_raw.get("order_id"),
                custom=meta_raw.get("custom"),
            )
            if isinstance(meta_raw, dict)
            else None
        )
        return _requirements_from_dict(reqs), merchant, meta

    # ── signing (async for API parity; eth-account is sync internally) ─────

    def _resolve_domain(self, requirements: PaymentRequirements) -> Dict[str, Any]:
        """Resolve the EIP-712 domain for a requirements' network/token (x402-v2.ts:265).

        :raises PayBotApiError: ``INVALID_CAIP2`` (400, bubbled from
            :func:`parse_caip2`), ``UNSUPPORTED_TOKEN`` (402), or
            ``UNSUPPORTED_NETWORK`` (402).
        """
        network = requirements.network or "eip155:8453"
        symbol = requirements.token or "USDC"

        parse_caip2(network)  # raises INVALID_CAIP2 on malformed network

        if get_token(symbol) is None:
            raise PayBotApiError(f"Unsupported token: {symbol}", "UNSUPPORTED_TOKEN", 402)

        domain = get_eip712_domain(network, symbol)
        if domain is None:
            raise PayBotApiError(
                f"No EIP-712 domain for network: {network}",
                "UNSUPPORTED_NETWORK",
                402,
            )
        return domain

    def _account(self) -> Any:
        """Derive the signing account from the wallet private key (lazy eth-account import)."""
        from eth_account import Account

        return Account.from_key(self._wallet_private_key)

    def _sign_typed(
        self, domain: Dict[str, Any], types: Dict[str, Any], message: Dict[str, Any]
    ) -> str:
        """Sign EIP-712 typed data with eth-account, returning a 0x-prefixed signature."""
        from eth_account import Account

        # eth-account synthesizes the EIP712Domain type from the domain dict and
        # infers primaryType from the single non-domain type.
        signed = Account.sign_typed_data(self._wallet_private_key, domain, types, message)
        sig_hex = signed.signature.hex()
        return sig_hex if sig_hex.startswith("0x") else "0x" + sig_hex

    def _sign_x402(self, account: Any, requirements: PaymentRequirements) -> Dict[str, Any]:
        """Sign an x402 native EIP-3009 ``TransferWithAuthorization`` (x402-v2.ts:295).

        :returns: ``{"signature", "signed_data"}`` where ``signed_data`` carries
            ``{from, to, value, validAfter, validBefore, nonce, signature}`` with
            numeric fields stringified.
        :raises PayBotApiError: ``UNSUPPORTED_NETWORK`` / ``UNSUPPORTED_TOKEN`` /
            ``INVALID_CAIP2`` from :meth:`_resolve_domain`.
        """
        domain = self._resolve_domain(requirements)
        nonce = generate_eip3009_nonce()
        now_seconds = int(time.time())
        valid_after = 0
        valid_before = now_seconds + 3600
        value = int(requirements.amount)

        message = {
            "from": account.address,
            "to": requirements.pay_to,
            "value": value,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce,
        }
        signature = self._sign_typed(domain, EIP3009_TYPES, message)
        signed_data = {
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
        self, account: Any, requirements: PaymentRequirements, intent_id: Optional[str]
    ) -> Dict[str, Any]:
        """Sign an MPP ``PaymentAuthorization`` (x402-v2.ts:357).

        The typed-data structure differs from x402's EIP-3009, so the resulting
        signature MUST differ from :meth:`_sign_x402` for the same inputs. The
        ``chainId: 1`` and ``"Machine Payments Protocol"``/``"1.0"`` literals are
        load-bearing — copied verbatim from the TS source.
        """
        domain = {
            "name": "Machine Payments Protocol",
            "version": "1.0",
            "chainId": 1,
            "verifyingContract": requirements.pay_to,
        }
        types = {
            "PaymentAuthorization": [
                {"name": "payer", "type": "address"},
                {"name": "recipient", "type": "address"},
                {"name": "amount", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
                {"name": "expires", "type": "uint256"},
                {"name": "paymentIntent", "type": "string"},
            ],
        }
        nonce = generate_eip3009_nonce()
        now_seconds = int(time.time())
        message = {
            "payer": account.address,
            "recipient": requirements.pay_to,
            "amount": int(requirements.amount),
            "nonce": nonce,
            "expires": now_seconds + 3600,
            "paymentIntent": intent_id or "unknown",
        }
        signature = self._sign_typed(domain, types, message)
        signed_data = {
            "payer": account.address,
            "recipient": requirements.pay_to,
            "amount": requirements.amount,
            "nonce": nonce,
            "expires": str(now_seconds),
            "paymentIntent": intent_id,
            "signature": signature,
        }
        return {"signature": signature, "signed_data": signed_data}

    async def sign_upto(self, account: Any, requirements: PaymentRequirements) -> Dict[str, Any]:
        """Sign an x402 v2 ``upto`` (metered/usage-billing) authorization (x402-v2.ts:439).

        Signs an EIP-3009 authorization for the MAXIMUM amount
        (``max_amount`` when present, else ``amount``), authorizing capture UP TO
        that max. The returned ``signed_data`` carries ``scheme='upto'`` + a
        ``maxAmount`` marker.

        :raises PayBotApiError: ``INVALID_CAIP2`` (400) / ``UNSUPPORTED_NETWORK`` (402).
        """
        domain = self._resolve_domain(requirements)
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
        signature = self._sign_typed(domain, EIP3009_TYPES, message)
        signed_data = {
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
        """Validate a captured amount does not exceed the authorized max (x402-v2.ts:505).

        :returns: The captured amount as a normalized base-unit string when valid.
        :raises PayBotApiError: ``UPTO_OVERCHARGE`` (402) when ``captured >
            authorized_max``; ``INVALID_AMOUNT`` (400) for non-integer strings.
        """
        max_v = X402Handler._parse_base_unit_amount(authorized_max, "authorizedMax")
        cap = X402Handler._parse_base_unit_amount(captured, "captured")
        if cap > max_v:
            raise PayBotApiError(
                f"upto capture {captured} exceeds authorized max {authorized_max}",
                "UPTO_OVERCHARGE",
                402,
                {"authorizedMax": authorized_max, "captured": captured},
            )
        return str(cap)

    @staticmethod
    def _parse_base_unit_amount(value: str, label: str) -> int:
        """Parse a non-negative integer decimal string into an int (x402-v2.ts:530).

        :raises PayBotApiError: ``INVALID_AMOUNT`` (400) when not a non-negative integer.
        """
        import re

        if not isinstance(value, str) or not re.fullmatch(r"\d+", value):
            raise PayBotApiError(
                f"Invalid {label}: expected a non-negative integer string, got '{value}'",
                "INVALID_AMOUNT",
                400,
                {label: value},
            )
        return int(value)

    async def sign_payment(self, payload: PaymentPayload) -> SignedPayment:
        """Sign a payment payload, dispatching on protocol/scheme (x402-v2.ts:578).

        Dispatch:
        - ``scheme == 'upto'`` → :meth:`sign_upto` (early return).
        - ``protocol == 'x402'`` → :meth:`_sign_x402`.
        - ``protocol == 'mpp'`` → :meth:`_sign_mpp`.
        - ``protocol == 'dual'`` → BOTH; ``signed_data = {"x402": ..., "mpp": ...}``,
          top-level ``signature`` = the x402 signature (primary).

        :raises PayBotApiError: ``MISSING_WALLET_KEY`` (402) without a key;
            ``UNSUPPORTED_PROTOCOL`` (402) on a bad protocol; signing-domain errors
            bubbled from the helpers.
        """
        if not self._wallet_private_key:
            raise PayBotApiError(
                "Wallet private key required for signing payments",
                "MISSING_WALLET_KEY",
                402,
            )

        account = self._account()
        requirements = payload.payment_intent.requirements
        protocol: PaymentProtocol = payload.payment_intent.protocol

        if requirements.scheme == "upto":
            r = await self.sign_upto(account, requirements)
            return SignedPayment(
                protocol=protocol,
                signed_data=r["signed_data"],
                signature=r["signature"],
                timestamp=_now_ms(),
            )

        if protocol == "x402":
            r = self._sign_x402(account, requirements)
            signature = r["signature"]
            signed_data = r["signed_data"]
        elif protocol == "mpp":
            r = self._sign_mpp(account, requirements, payload.payment_intent.intent_id)
            signature = r["signature"]
            signed_data = r["signed_data"]
        elif protocol == "dual":
            x = self._sign_x402(account, requirements)
            m = self._sign_mpp(account, requirements, payload.payment_intent.intent_id)
            signature = x["signature"]  # primary = x402
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

    # ── submission (async, network) ───────────────────────────────────────

    async def submit_payment(
        self,
        signed: SignedPayment,
        payment_endpoint: str,
        auth_token: Optional[str] = None,
    ) -> Receipt:
        """Submit a signed payment to the payment endpoint (x402-v2.ts:661).

        Sends both ``Payment-Intent-Authorization`` (``x402:v2:<base64>``) and the
        bare-base64 ``PAYMENT-SIGNATURE`` header so v1 and v2 facilitators each read
        the form they expect. Body = ``{"protocol": ..., **signed_data}``.

        :raises PayBotApiError: ``PAYMENT_SUBMISSION_FAILED`` (server non-2xx) or
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
            err_data: Dict[str, Any] = {}
            try:
                err_data = response.json()
            except Exception:  # noqa: BLE001
                err_data = {}
            raise PayBotApiError(
                err_data.get("error") or f"HTTP {response.status_code}",
                err_data.get("code") or "PAYMENT_SUBMISSION_FAILED",
                response.status_code,
                err_data.get("details"),
            )

        receipt = response.json()
        return Receipt(
            receipt_id=receipt.get("receiptId", ""),
            transaction_id=receipt.get("transactionId"),
            status=receipt.get("status", "pending"),
            confirmed_at=receipt.get("confirmedAt"),
            amount=receipt.get("amount", ""),
            network=receipt.get("network", ""),
            block_number=receipt.get("blockNumber"),
            gas_used=receipt.get("gasUsed"),
        )

    async def verify_receipt(self, receipt: Receipt, verification_endpoint: str) -> bool:
        """Verify a payment receipt with the merchant (x402-v2.ts:831).

        Returns ``True`` only when the endpoint responds 2xx with
        ``{"verified": true}``; any non-2xx or transport error returns ``False``.
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
        except httpx.HTTPError:
            return False
        if response.status_code < 200 or response.status_code >= 300:
            return False
        try:
            data = response.json()
        except Exception:  # noqa: BLE001
            return False
        return data.get("verified") is True

    # ── header encode / parse ─────────────────────────────────────────────

    def _encode_signed_payment(self, signed: SignedPayment) -> str:
        """Encode for the legacy ``Payment-Intent-Authorization`` header (x402-v2.ts:728)."""
        payload = {
            "protocol": signed.protocol,
            "signedData": signed.signed_data,
            "signature": signed.signature,
            "timestamp": signed.timestamp,
        }
        return f"x402:v2:{_b64encode_json(payload)}"

    @staticmethod
    def encode_payment_signature_header(signed: SignedPayment) -> str:
        """Encode for the x402 v2 ``PAYMENT-SIGNATURE`` header (bare base64) (x402-v2.ts:749)."""
        payload = {
            "protocol": signed.protocol,
            "signedData": signed.signed_data,
            "signature": signed.signature,
            "timestamp": signed.timestamp,
        }
        return _b64encode_json(payload)

    @staticmethod
    def parse_payment_response_header(header_value: str) -> PaymentResponseConfirmation:
        """Parse an x402 v2 ``PAYMENT-RESPONSE`` header (x402-v2.ts:778).

        :raises PayBotApiError: ``INVALID_PAYMENT_RESPONSE`` (502) when not valid
            base64 JSON or missing a ``receiptId``.
        """
        try:
            parsed = _b64decode_json(header_value)
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
        """Create a ``x402:v2:<base64>`` Payment-Intent header for merchants (x402-v2.ts:859)."""
        return f"x402:v2:{_b64encode_json(_intent_to_wire(intent))}"

    @staticmethod
    def negotiate_payment_intent(
        requirements: PaymentRequirements,
        supported_protocols: Optional[List[PaymentProtocol]] = None,
    ) -> PaymentIntent:
        """Negotiate a payment intent (defaults to dual-mode) (x402-v2.ts:869)."""
        import random

        now_ms = _now_ms()
        rand = "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=9))
        return PaymentIntent(
            intent_id=f"intent_{now_ms}_{rand}",
            protocol="dual",
            requirements=requirements,
            version="2.0",
            created_at=_iso_from_ms(now_ms),
            expires_at=_iso_from_ms(now_ms + 300_000),
        )


def _iso_from_ms(ms: int) -> str:
    """ISO-8601 UTC string from epoch ms (matches TS ``new Date(ms).toISOString()``)."""
    from datetime import datetime, timezone

    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    # Millisecond precision + trailing Z, like JS toISOString().
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _intent_to_wire(intent: PaymentIntent) -> Dict[str, Any]:
    """Serialize a :class:`PaymentIntent` to a camelCase wire dict."""
    reqs = intent.requirements
    wire_reqs: Dict[str, Any] = {
        "scheme": reqs.scheme,
        "network": reqs.network,
        "asset": reqs.asset,
        "amount": reqs.amount,
        "payTo": reqs.pay_to,
        "maxTimeoutSeconds": reqs.max_timeout_seconds,
    }
    if reqs.min_amount is not None:
        wire_reqs["minAmount"] = reqs.min_amount
    if reqs.max_amount is not None:
        wire_reqs["maxAmount"] = reqs.max_amount
    if reqs.token is not None:
        wire_reqs["token"] = reqs.token

    wire: Dict[str, Any] = {
        "intentId": intent.intent_id,
        "protocol": intent.protocol,
        "requirements": wire_reqs,
        "version": intent.version,
        "createdAt": intent.created_at,
        "expiresAt": intent.expires_at,
    }
    if intent.merchant is not None:
        wire["merchant"] = {k: v for k, v in asdict(intent.merchant).items() if v is not None}
    if intent.meta is not None:
        meta = asdict(intent.meta)
        wire_meta = {}
        if meta.get("description") is not None:
            wire_meta["description"] = meta["description"]
        if meta.get("order_id") is not None:
            wire_meta["orderId"] = meta["order_id"]
        if meta.get("custom") is not None:
            wire_meta["custom"] = meta["custom"]
        wire["meta"] = wire_meta
    return wire
