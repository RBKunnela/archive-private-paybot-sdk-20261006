"""PayBotClient — Python port of the TS SDK entry point.

**Status:** scaffold. The HTTP surface and configuration validation are complete;
the EIP-3009 signing inside `pay()` is the one piece marked `_sign_payload()`
that intentionally raises `NotImplementedError` in this scaffold PR so the type
surface + facilitator contract can be reviewed first. The runtime port comes
in the follow-up PR.

Methods that don't touch on-chain signing (`register`, `balance`, `history`,
`set_limits`, `health`, `commission_*`, `create_api_key`, `list_api_keys`,
`revoke_api_key`) are fully implemented in this scaffold — they just call the
facilitator's REST endpoints. Anyone using the SDK in mock mode (no
`wallet_private_key`) gets all of those today.

Mirrors the TS surface in `src/client.ts` 1:1 on method names and shapes.
"""
from __future__ import annotations

import asyncio
import json
import time
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


class PayBotClient:
    """PayBotClient — SDK entry point for bot developers.

    Usage (mock mode, no on-chain signing):

        client = PayBotClient(PayBotConfig(api_key="pb_test_...", bot_id="my-bot"))
        await client.register()

    Usage (real mode, EIP-3009 signing — runtime ships in follow-up PR):

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
            # cheap URL validation
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
        if body is not None:
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)

        last_error: Optional[BaseException] = None
        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                await asyncio.sleep(0.1 * (2 ** (attempt - 1)))
            try:
                async with httpx.AsyncClient(timeout=self._timeout_ms / 1000) as client:
                    response = await client.request(
                        method=method,
                        url=url,
                        headers=headers,
                        content=json.dumps(body) if body is not None else None,
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

            return response.json()

        if isinstance(last_error, PayBotApiError):
            raise last_error
        raise PayBotApiError(
            f"Network error: {get_error_message(last_error)}", "NETWORK_ERROR", 0
        )

    # ── Bot operations ───────────────────────────────────────────────────

    async def register(self, trust_level: Optional[TrustLevel] = None) -> RegisterResult:
        """Register the bot. Idempotent on (bot_id, api_key)."""
        body: Dict[str, Any] = {"botId": self._bot_id, "operatorId": self._operator_id}
        if trust_level is not None:
            body["trustLevel"] = trust_level
        data = await self._request("/api/bots/register", method="POST", body=body)
        return RegisterResult(
            success=bool(data.get("success", True)),
            bot_id=data["botId"],
            trust_level=data["trustLevel"],
        )

    async def balance(self) -> BalanceResult:
        data = await self._request(f"/api/bots/{self._bot_id}/balance")
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
        data = await self._request(
            f"/api/bots/{self._bot_id}/history",
            query={"limit": str(limit)},
        )
        return [
            TransactionHistoryItem(
                event_id=item["eventId"],
                timestamp=item["timestamp"],
                event_type=item["eventType"],
                action=item["action"],
                details=item.get("details", {}),
            )
            for item in data.get("items", data)  # support both wrapped and bare list shapes
        ]

    async def set_limits(self, limits: LimitsConfig) -> None:
        body: Dict[str, Any] = {}
        if limits.max_transaction_usd is not None:
            body["maxTransactionUsd"] = limits.max_transaction_usd
        if limits.max_daily_spend_usd is not None:
            body["maxDailySpendUsd"] = limits.max_daily_spend_usd
        if limits.max_transactions_per_hour is not None:
            body["maxTransactionsPerHour"] = limits.max_transactions_per_hour
        if limits.allowed_recipients is not None:
            body["allowedRecipients"] = limits.allowed_recipients
        await self._request(
            f"/api/bots/{self._bot_id}/limits", method="POST", body=body
        )

    async def health(self) -> HealthResult:
        data = await self._request("/api/health")
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

    # ── Payments ─────────────────────────────────────────────────────────

    async def pay(self, request: PaymentRequest) -> PaymentResult:
        """Execute a payment.

        In mock mode (no wallet_private_key): facilitator simulates success/failure.
        In real mode: signs EIP-3009 TransferWithAuthorization off-chain, posts to
        the facilitator for verify+settle.

        SCAFFOLD NOTE: the EIP-3009 signing path (`_sign_payload`) raises in the
        scaffold PR; the mock path is fully wired. Real signing ships in PR-2.
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
                # Scaffold guard — real signing ships in PR-2.
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
            "resource": request.resource,
            "accepted": True,
            "payload": payload_string,
            "x402Version": 1,
            "scheme": "exact",
            "network": network_id,
            "asset": f"{network_id}/erc20:{token_contract}",
            "amount": amount_base_units,
            "payTo": request.pay_to,
            "maxTimeoutSeconds": 300,
        }

        try:
            data = await self._request(
                "/api/payments/execute",
                method="POST",
                body={"botId": self._bot_id, "payload": payload_body},
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
            success=bool(data.get("success", False)),
            tx_hash=data.get("txHash"),
            gross_amount=data.get("grossAmount", "0"),
            net_amount=data.get("netAmount", "0"),
            commission_amount=data.get("commissionAmount", "0"),
            commission_rate=data.get("commissionRate", 0),
            network=data.get("network"),
            error=data.get("error"),
            error_code=data.get("errorCode"),
            error_details=data.get("errorDetails"),
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
        signature blob the same way `client.ts` does.
        """
        raise NotImplementedError(
            "Phase 2 — EIP-3009 signing port (eth_account + EIP-712 typed-data)"
        )

    # ── Commission reporting ─────────────────────────────────────────────

    async def commission_summary(self) -> CommissionSummary:
        data = await self._request(f"/api/bots/{self._bot_id}/commission/summary")
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
        data = await self._request(
            f"/api/bots/{self._bot_id}/commission/ledger", query=query or None
        )
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
            for item in data.get("entries", data)
        ]

    # ── API-key management (operator-scoped, requires Bearer access token) ────

    async def create_api_key(
        self, *, access_token: str, label: Optional[str] = None
    ) -> ApiKeyResult:
        body: Dict[str, Any] = {}
        if label is not None:
            body["label"] = label
        data = await self._request(
            "/api/auth/api-keys",
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
        data = await self._request(
            "/api/auth/api-keys",
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
            for item in data.get("items", data)
        ]

    async def revoke_api_key(
        self, key_id: str, access_token: str
    ) -> Dict[str, Any]:
        data = await self._request(
            f"/api/auth/api-keys/{key_id}/revoke",
            method="POST",
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
        # Avoid float arithmetic; do string-based conversion.
        if "." not in human_amount:
            whole, frac = human_amount, ""
        else:
            whole, frac = human_amount.split(".", 1)
        frac = (frac + "0" * decimals)[:decimals]
        result = (whole + frac).lstrip("0") or "0"
        return result
