"""PayBotClient — Python port of the TS SDK entry point.

**Status:** scaffold. The HTTP surface and configuration validation are complete
and match the TS SDK in `../../src/client.ts` 1:1 on endpoint paths, HTTP
methods, and body shapes. The EIP-3009 signing inside `pay()` (`_sign_payload`)
intentionally raises `NotImplementedError` in this scaffold PR so the type
surface and facilitator wire contract can be reviewed first. The signing
runtime port lands in PR-2.

Methods that don't touch on-chain signing (`register`, `balance`, `history`,
`set_limits`, `health`, `commission_*`, `create_api_key`, `list_api_keys`,
`revoke_api_key`) are fully implemented and call the same endpoints as TS.
Anyone using the SDK in mock mode (no `wallet_private_key`) gets the full
surface today.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode, urljoin

import httpx

from .crypto import generate_eip3009_nonce
from .errors import PayBotApiError, get_error_message
from .networks import EIP712_DOMAINS, EIP3009_TYPES, NETWORKS
from .types import (
    ApiKeyListItem,
    ApiKeyResult,
    BalanceResult,
    CommissionEntry,
    CommissionLedgerFilter,
    CommissionStatus,
    CommissionSummary,
    HealthResult,
    LimitsConfig,
    LoginResult,
    OperatorRef,
    PayBotConfig,
    PaymentRequest,
    PaymentResult,
    RegisterResult,
    SignupResult,
    TransactionHistoryItem,
    TrustLevel,
)


DEFAULT_FACILITATOR_URL = "https://api.paybotcore.com"
DEFAULT_OPERATOR_ID = "default-operator"


def _as_list(data: Any) -> list:
    """Safely return a list from a response that might be a bare list, a dict
    wrapping `items`/`entries`, or something else. Mirrors the dual-shape
    handling the TS SDK does implicitly via `as` casting."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("items", "entries"):
            value = data.get(key)
            if isinstance(value, list):
                return value
    return []


class PayBotClient:
    """PayBotClient — SDK entry point for bot developers.

    Usage (mock mode, no on-chain signing):

        client = PayBotClient(PayBotConfig(api_key="pb_test_...", bot_id="my-bot"))
        await client.register()

    Usage (real mode, EIP-3009 signing — runtime ships in PR-2):

        client = PayBotClient(PayBotConfig(
            api_key="pb_test_...",
            bot_id="my-bot",
            wallet_private_key="0x...",
        ))
    """

    def __init__(self, config: PayBotConfig) -> None:
        if not config.api_key or not isinstance(config.api_key, str):
            raise ValueError("PayBotClient: api_key is required and must be a non-empty string")
        if not config.bot_id or not isinstance(config.bot_id, str):
            raise ValueError("PayBotClient: bot_id is required and must be a non-empty string")
        if config.facilitator_url is not None:
            if not (config.facilitator_url.startswith("http://") or config.facilitator_url.startswith("https://")):
                raise ValueError(f"PayBotClient: facilitator_url is not a valid URL: {config.facilitator_url}")
        if config.wallet_private_key is not None and not config.wallet_private_key.startswith("0x"):
            raise ValueError("PayBotClient: wallet_private_key must start with 0x")

        self._api_key = config.api_key
        self._bot_id = config.bot_id
        self._facilitator_url = config.facilitator_url or DEFAULT_FACILITATOR_URL
        self._operator_id = config.operator_id or DEFAULT_OPERATOR_ID
        self._wallet_private_key = config.wallet_private_key
        self._max_retries = config.max_retries
        self._timeout_ms = config.timeout_ms

        # Shared httpx client — pooled across requests + retries. Closed when
        # the PayBotClient is GC'd or explicitly via `.close()`.
        self._http = httpx.AsyncClient(timeout=self._timeout_ms / 1000)

    async def close(self) -> None:
        """Explicitly close the underlying httpx client."""
        await self._http.aclose()

    # ── Shared request helper ────────────────────────────────────────────

    async def _request(
        self,
        path: str,
        method: str = "GET",
        body: Optional[Any] = None,
        query: Optional[Dict[str, str]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        url = urljoin(self._facilitator_url.rstrip("/") + "/", path.lstrip("/"))
        if query:
            url = f"{url}?{urlencode(query)}"

        headers: Dict[str, str] = {"X-API-Key": self._api_key}
        if extra_headers:
            headers.update(extra_headers)

        last_error: Optional[BaseException] = None
        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                await asyncio.sleep(0.1 * (2 ** (attempt - 1)))
            try:
                response = await self._http.request(
                    method=method,
                    url=url,
                    headers=headers,
                    json=body if body is not None else None,
                )
            except (httpx.HTTPError, asyncio.TimeoutError) as e:
                last_error = e
                continue

            # 4xx: client error, do not retry
            if 400 <= response.status_code < 500:
                err_data: Dict[str, Any] = {}
                try:
                    err_data = response.json()
                except Exception:
                    pass
                raise PayBotApiError(
                    err_data.get("error") or f"HTTP {response.status_code}",
                    err_data.get("code") or "HTTP_ERROR",
                    response.status_code,
                    err_data.get("details"),
                )

            # 5xx: retry
            if response.status_code >= 500:
                last_error = PayBotApiError(
                    f"HTTP {response.status_code}", "HTTP_ERROR", response.status_code
                )
                continue

            try:
                return response.json()
            except ValueError as e:
                raise PayBotApiError(
                    f"Invalid JSON in 2xx response from facilitator: {e}",
                    "INVALID_RESPONSE",
                    response.status_code,
                )

        if isinstance(last_error, PayBotApiError):
            raise last_error
        raise PayBotApiError(
            f"Network error: {get_error_message(last_error)}", "NETWORK_ERROR", 0
        )

    # ── Bot operations (endpoint paths verified against src/client.ts) ────

    async def register(self, trust_level: Optional[TrustLevel] = None) -> RegisterResult:
        """Register a new bot. POST /bots — matches client.ts:389."""
        body: Dict[str, Any] = {
            "botId": self._bot_id,
            "trustLevel": trust_level if trust_level is not None else 1,
        }
        data = await self._request("/bots", method="POST", body=body)
        return RegisterResult(
            success=bool(data.get("success", True)),
            bot_id=data["botId"],
            trust_level=data["trustLevel"],
        )

    async def balance(self) -> BalanceResult:
        """GET /balance?botId=... — matches client.ts:358."""
        data = await self._request("/balance", query={"botId": self._bot_id})
        return BalanceResult(
            bot_id=data["botId"],
            trust_level=data["trustLevel"],
            trust_level_name=data["trustLevelName"],
            daily_spent_usd=data["dailySpentUsd"],
            daily_limit_usd=data["dailyLimitUsd"],
            daily_remaining_usd=data["dailyRemainingUsd"],
            hourly_transactions=data["hourlyTransactions"],
            hourly_limit=data["hourlyLimit"],
        )

    async def history(self, limit: int = 50) -> List[TransactionHistoryItem]:
        """GET /history?botId=...&limit=... — matches client.ts:368."""
        data = await self._request(
            "/history",
            query={"botId": self._bot_id, "limit": str(limit)},
        )
        return [
            TransactionHistoryItem(
                event_id=item["eventId"],
                timestamp=item["timestamp"],
                event_type=item["eventType"],
                action=item["action"],
                details=item.get("details", {}),
            )
            for item in _as_list(data)
        ]

    async def set_limits(self, limits: LimitsConfig) -> None:
        """PUT /limits with {botId, ...limits} — matches client.ts:378."""
        body: Dict[str, Any] = {"botId": self._bot_id}
        if limits.max_transaction_usd is not None:
            body["maxTransactionUsd"] = limits.max_transaction_usd
        if limits.max_daily_spend_usd is not None:
            body["maxDailySpendUsd"] = limits.max_daily_spend_usd
        if limits.max_transactions_per_hour is not None:
            body["maxTransactionsPerHour"] = limits.max_transactions_per_hour
        if limits.allowed_recipients is not None:
            body["allowedRecipients"] = limits.allowed_recipients
        await self._request("/limits", method="PUT", body=body)

    async def health(self) -> HealthResult:
        """GET /health — matches client.ts:400."""
        data = await self._request("/health")
        return HealthResult(
            status=data.get("status", "unknown"),
            version=data.get("version", ""),
            uptime=data.get("uptime", 0),
            timestamp=data.get("timestamp", ""),
            extra={
                k: v
                for k, v in data.items()
                if k not in {"status", "version", "uptime", "timestamp"}
            },
        )

    # ── Payments (two-step verify→settle flow matches client.ts:182) ────

    async def pay(self, request: PaymentRequest) -> PaymentResult:
        """Execute a payment.

        In mock mode (no wallet_private_key): facilitator simulates success/failure.
        In real mode: signs EIP-3009 TransferWithAuthorization off-chain, posts
        the payload to `/verify` → receives a `settlementToken` → posts to
        `/settle` to finalize. Matches the two-step flow in client.ts:182.

        SCAFFOLD NOTE: the EIP-3009 signing path (`_sign_payload`) raises in the
        scaffold PR; the verify/settle wire is implemented but only exercised
        in mock mode until signing lands. PR-2 fills in the signing runtime.
        """
        network_id = request.network or "eip155:84532"
        network = NETWORKS.get(network_id)
        if network is None:
            return PaymentResult(
                success=False,
                gross_amount="0",
                net_amount="0",
                commission_amount="0",
                commission_rate=0,
                error=f"Unsupported network: {network_id}",
                error_code="UNSUPPORTED_NETWORK",
            )

        token_contract = request.token_contract or network.usdc_address
        amount_base_units = self._to_base_units(request.amount, 6)

        payload_string: Optional[str] = None
        if self._wallet_private_key is not None:
            try:
                payload_string = await self._sign_payload(
                    request=request,
                    amount_base_units=amount_base_units,
                    token_contract=token_contract,
                    network_id=network_id,
                )
            except NotImplementedError:
                return PaymentResult(
                    success=False,
                    gross_amount="0",
                    net_amount="0",
                    commission_amount="0",
                    commission_rate=0,
                    error="EIP-3009 signing not implemented in scaffold PR",
                    error_code="NOT_IMPLEMENTED_SCAFFOLD",
                )

        payload_body: Dict[str, Any] = {
            "x402Version": 1,
            "resource": request.resource,
            "accepted": True,
            "payload": payload_string,
        }

        requirements = {
            "scheme": "exact",
            "network": network_id,
            "asset": f"{network_id}/erc20:{token_contract}",
            "amount": amount_base_units,
            "payTo": request.pay_to,
            "maxTimeoutSeconds": 300,
        }

        # Step 1: /verify
        try:
            verify_data = await self._request(
                "/verify",
                method="POST",
                body={
                    "botId": self._bot_id,
                    "payload": payload_body,
                    "requirements": requirements,
                },
            )
        except PayBotApiError as e:
            return PaymentResult(
                success=False,
                gross_amount="0",
                net_amount="0",
                commission_amount="0",
                commission_rate=0,
                error=str(e),
                error_code=e.code,
                error_details=e.details,
            )

        settlement_token = verify_data.get("settlementToken")
        if not settlement_token:
            return PaymentResult(
                success=False,
                gross_amount="0",
                net_amount="0",
                commission_amount="0",
                commission_rate=0,
                error="Facilitator did not return a settlementToken",
                error_code="NO_SETTLEMENT_TOKEN",
            )

        # Step 2: /settle
        try:
            settle_data = await self._request(
                "/settle",
                method="POST",
                body={
                    "botId": self._bot_id,
                    "settlementToken": settlement_token,
                    "payload": payload_body,
                    "requirements": verify_data.get("modifiedRequirements", requirements),
                    "commission": verify_data.get("commission"),
                },
            )
        except PayBotApiError as e:
            return PaymentResult(
                success=False,
                gross_amount="0",
                net_amount="0",
                commission_amount="0",
                commission_rate=0,
                error=str(e),
                error_code=e.code,
                error_details=e.details,
            )

        return PaymentResult(
            success=bool(settle_data.get("success", False)),
            tx_hash=settle_data.get("txHash"),
            gross_amount=settle_data.get("grossAmount", "0"),
            net_amount=settle_data.get("netAmount", "0"),
            commission_amount=settle_data.get("commissionAmount", "0"),
            commission_rate=settle_data.get("commissionRate", 0),
            network=settle_data.get("network"),
            error=settle_data.get("error"),
            error_code=settle_data.get("errorCode"),
            error_details=settle_data.get("errorDetails"),
        )

    async def _sign_payload(
        self,
        request: PaymentRequest,
        amount_base_units: str,
        token_contract: str,
        network_id: str,
    ) -> str:
        """Sign an EIP-3009 TransferWithAuthorization for the given payment.

        SCAFFOLD: raises NotImplementedError. The runtime port lands in PR-2.

        Implementation note for PR-2: build the EIP-712 typed-data using
        `EIP712_DOMAINS[network_id]` + `EIP3009_TYPES`, sign with eth_account's
        `encode_typed_data` / `sign_message`, base64-encode the resulting
        signature blob the same way `client.ts:buildPaymentPayload` does.
        """
        raise NotImplementedError(
            "Phase 2 — EIP-3009 signing port (eth_account + EIP-712 typed-data)"
        )

    # ── Commission reporting ─────────────────────────────────────────────

    async def commission_summary(self) -> CommissionSummary:
        """GET /commission/summary — matches client.ts:426."""
        data = await self._request("/commission/summary")
        return CommissionSummary(
            total_earned=data["totalEarned"],
            pending=data["pending"],
            forwarded=data["forwarded"],
            deferred=data["deferred"],
            commission_rate=data["commissionRate"],
            entry_count=data["entryCount"],
        )

    async def commission_ledger(
        self, filters: Optional[CommissionLedgerFilter] = None
    ) -> List[CommissionEntry]:
        """GET /commission/ledger with filters — matches client.ts:434."""
        query: Dict[str, str] = {}
        if filters:
            if filters.status:
                query["status"] = filters.status
            if filters.start_date:
                query["startDate"] = filters.start_date
            if filters.end_date:
                query["endDate"] = filters.end_date
            if filters.limit:
                query["limit"] = str(filters.limit)
            if filters.offset:
                query["offset"] = str(filters.offset)
        data = await self._request("/commission/ledger", query=query or None)
        return [
            CommissionEntry(
                id=item["id"],
                tx_hash=item["txHash"],
                gross_amount=item["grossAmount"],
                net_amount=item["netAmount"],
                commission_amount=item["commissionAmount"],
                commission_rate=item["commissionRate"],
                status=item["status"],
                created_at=item["createdAt"],
                forwarded_at=item.get("forwardedAt"),
            )
            for item in _as_list(data)
        ]

    # ── API-key management (operator-scoped, requires Bearer access token) ────

    async def create_api_key(
        self, *, access_token: str, label: Optional[str] = None
    ) -> ApiKeyResult:
        """POST /api-keys — matches client.ts:580."""
        body: Dict[str, Any] = {
            "operatorId": self._operator_id,
            "permissions": "all",
        }
        if label is not None:
            body["label"] = label
        data = await self._request(
            "/api-keys",
            method="POST",
            body=body,
            extra_headers={"Authorization": f"Bearer {access_token}"},
        )
        return ApiKeyResult(
            id=data["id"],
            key=data["key"],
            key_prefix=data["keyPrefix"],
            operator_id=data["operatorId"],
            label=data.get("label"),
            permissions=data["permissions"],
            rate_limit=data["rateLimit"],
            created_at=data["createdAt"],
        )

    async def list_api_keys(self, access_token: str) -> List[ApiKeyListItem]:
        """GET /api-keys — matches client.ts:607."""
        data = await self._request(
            "/api-keys",
            extra_headers={"Authorization": f"Bearer {access_token}"},
        )
        return [
            ApiKeyListItem(
                id=item["id"],
                key_prefix=item["keyPrefix"],
                operator_id=item["operatorId"],
                label=item.get("label"),
                permissions=item["permissions"],
                rate_limit=item["rateLimit"],
                active=item["active"],
                created_at=item["createdAt"],
                last_used_at=item.get("lastUsedAt"),
            )
            for item in _as_list(data)
        ]

    async def revoke_api_key(
        self, key_id: str, access_token: str
    ) -> Dict[str, Any]:
        """DELETE /api-keys/{keyId} — matches client.ts:626."""
        data = await self._request(
            f"/api-keys/{key_id}",
            method="DELETE",
            extra_headers={"Authorization": f"Bearer {access_token}"},
        )
        return {
            "success": data.get("success", True),
            "key_id": data.get("keyId", key_id),
            "active": data.get("active", False),
        }

    # ── Internal helpers ─────────────────────────────────────────────────

    @staticmethod
    def _to_base_units(human_amount: str, decimals: int) -> str:
        """Convert a human-readable USDC amount (e.g. '0.05') to base units string."""
        if "." not in human_amount:
            whole, frac = human_amount, ""
        else:
            whole, frac = human_amount.split(".", 1)
        frac = (frac + "0" * decimals)[:decimals]
        result = (whole + frac).lstrip("0") or "0"
        return result
