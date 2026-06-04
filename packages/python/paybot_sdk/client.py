"""PayBotClient — Python port of the TS SDK entry point.

The HTTP surface and configuration validation match the TS SDK in
`../../src/client.ts` 1:1 on endpoint paths, HTTP methods, and body shapes.
The EIP-3009 signing inside `pay()` (`_sign_payload`) is implemented using
`eth-account` (install the `signing` extra) and produces a payload blob
byte-for-byte compatible with the TS SDK's `buildPaymentPayload`.

All methods (`register`, `balance`, `history`, `set_limits`, `health`,
`commission_*`, `create_api_key`, `list_api_keys`, `revoke_api_key`, and the
real-mode signing `pay()`) call the same endpoints and use the same wire
contract as TS. Mock mode (no `wallet_private_key`) and real mode (EIP-3009
signing) are both fully supported.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections import OrderedDict
from typing import Any, Dict, Generic, List, Optional, TypeVar
from urllib.parse import urlencode, urljoin

import httpx

from .crypto import generate_eip3009_nonce
from .errors import PayBotApiError, get_error_message
from .networks import (
    EIP3009_TYPES,
    get_eip712_domain,
    get_token,
    resolve_token_address,
)
from .telemetry import TelemetryConfig, with_span
from .types import (
    ApiKeyListItem,
    ApiKeyResult,
    BalanceResult,
    CommissionEntry,
    CommissionLedgerFilter,
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

#: Per-instance idempotency cache capacity (client.ts:32).
IDEMPOTENCY_CACHE_CAP = 256

V = TypeVar("V")


class _LruCache(Generic[V]):
    """Minimal bounded LRU cache backed by an ``OrderedDict`` (client.ts:46).

    On a cache hit the key is moved to the most-recently-used position; on insert
    past capacity the least-recently-used entry is evicted. Used per-PayBotClient
    instance to dedupe idempotent calls. Not thread-safe (matches the TS Map: one
    async task per client).
    """

    def __init__(self, capacity: int) -> None:
        """:param capacity: Maximum entries before eviction kicks in."""
        self._capacity = capacity
        self._store: "OrderedDict[str, V]" = OrderedDict()

    def get(self, key: str) -> Optional[V]:
        """Look up a key, marking it most-recently-used on a hit."""
        if key not in self._store:
            return None
        self._store.move_to_end(key)
        return self._store[key]

    def set(self, key: str, value: V) -> None:
        """Insert/update a key, evicting the LRU entry if at capacity."""
        if key in self._store:
            self._store.move_to_end(key)
        elif len(self._store) >= self._capacity:
            self._store.popitem(last=False)
        self._store[key] = value

    @property
    def size(self) -> int:
        """Current number of cached entries (primarily for tests)."""
        return len(self._store)


def _safe_json(response: httpx.Response) -> Dict[str, Any]:
    """Parse a response body as a dict, returning ``{}`` on any decode failure."""
    try:
        data = response.json()
    except Exception:  # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}


def _raise_if_not_ok(
    response: httpx.Response,
    data: Dict[str, Any],
    default_message: str,
    default_code: str,
) -> None:
    """Raise a :class:`PayBotApiError` when ``response`` is not 2xx (auth helpers).

    Preserves the server-provided ``error``/``code``/``details`` when present,
    else falls back to the supplied defaults.
    """
    if 200 <= response.status_code < 300:
        return
    raise PayBotApiError(
        data.get("error") or default_message,
        data.get("code") or default_code,
        response.status_code,
        data.get("details"),
    )


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

    Usage (real mode, EIP-3009 signing — requires the `signing` extra):

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
        # Operator-supplied token address overrides (symbol -> caip2 -> address).
        # Lets the operator inject mainnet addresses that are intentionally absent
        # from the public open-core registry. Mirrors the TS client's
        # tokenAddressOverrides. See PayBotConfig.token_address_overrides.
        self._token_address_overrides = config.token_address_overrides
        self._max_retries = config.max_retries
        self._timeout_ms = config.timeout_ms
        # Opt-in telemetry; None means tracing is a complete no-op.
        self._telemetry: Optional[TelemetryConfig] = config.telemetry
        # Per-instance LRU caches; only success:True results are cached.
        self._pay_idempotency_cache: _LruCache[PaymentResult] = _LruCache(IDEMPOTENCY_CACHE_CAP)
        self._register_idempotency_cache: _LruCache[RegisterResult] = _LruCache(
            IDEMPOTENCY_CACHE_CAP
        )

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

    async def register(
        self,
        trust_level: Optional[TrustLevel] = None,
        idempotency_key: Optional[str] = None,
    ) -> RegisterResult:
        """Register a new bot. POST /bots — matches client.ts:575.

        When ``idempotency_key`` is set, a prior cached success is returned
        without a network round-trip and the ``X-Idempotency-Key`` header is sent.
        Only successful registrations are cached.
        """
        if idempotency_key is not None:
            cached = self._register_idempotency_cache.get(idempotency_key)
            if cached is not None:
                return cached

        body: Dict[str, Any] = {
            "botId": self._bot_id,
            "trustLevel": trust_level if trust_level is not None else 1,
        }
        extra_headers = (
            {"X-Idempotency-Key": idempotency_key} if idempotency_key is not None else None
        )
        data = await self._request(
            "/bots", method="POST", body=body, extra_headers=extra_headers
        )
        result = RegisterResult(
            success=bool(data.get("success", True)),
            bot_id=data["botId"],
            trust_level=data["trustLevel"],
        )
        # Only reached on success (_request throws on non-2xx).
        if idempotency_key is not None:
            self._register_idempotency_cache.set(idempotency_key, result)
        return result

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
        """Execute a payment (two-step verify→settle flow; client.ts:266).

        In mock mode (no wallet_private_key): facilitator simulates success/failure.
        In real mode: signs EIP-3009 TransferWithAuthorization off-chain, posts the
        payload to ``/verify`` → receives a ``settlementToken`` → posts to ``/settle``.

        Resolves the token via the registry (``request.token``, default ``USDC``);
        an unknown token short-circuits to ``UNSUPPORTED_TOKEN``. When
        ``request.idempotency_key`` is set, a prior cached success is returned
        without a network round-trip and the ``X-Idempotency-Key`` header is sent.
        The whole call is wrapped in telemetry spans (no-op when not configured).
        """
        network_id = request.network or "eip155:84532"
        idempotency_key = request.idempotency_key

        # Idempotency: return a prior cached success without a second round-trip.
        if idempotency_key is not None:
            cached = self._pay_idempotency_cache.get(idempotency_key)
            if cached is not None:
                return cached

        async def _do_pay(pay_span: Any) -> PaymentResult:
            try:
                symbol = request.token or "USDC"

                # Resolve the token from the registry. Unknown symbol → failure.
                token = get_token(symbol)
                if token is None:
                    if pay_span is not None:
                        pay_span.set_attribute("success", False)
                    return PaymentResult(
                        success=False,
                        gross_amount="0",
                        net_amount="0",
                        commission_amount="0",
                        commission_rate=0,
                        error=f"Unsupported token: {symbol}",
                        error_code="UNSUPPORTED_TOKEN",
                    )

                # Token contract precedence (mirrors the TS client):
                #   1. explicit request.token_contract
                #   2. operator-injected override (config.token_address_overrides)
                #   3. the public open-core registry (token.address_by_network)
                # If none resolves (e.g. EURC mainnet, which is operator-private and
                # intentionally absent from the public registry), fail loudly with
                # TOKEN_ADDRESS_NOT_CONFIGURED rather than signing against a wrong or
                # absent address.
                token_contract = request.token_contract or resolve_token_address(
                    symbol, network_id, self._token_address_overrides
                )
                if not token_contract:
                    if pay_span is not None:
                        pay_span.set_attribute("success", False)
                    return PaymentResult(
                        success=False,
                        gross_amount="0",
                        net_amount="0",
                        commission_amount="0",
                        commission_rate=0,
                        error=(
                            f"No contract address configured for token {symbol} on "
                            f"network {network_id}. Provide it via "
                            f"PayBotConfig.token_address_overrides[{symbol}][{network_id}]."
                        ),
                        error_code="TOKEN_ADDRESS_NOT_CONFIGURED",
                    )

                # Use the token's decimals (USDC/EURC use 6; DAI uses 18).
                amount_base_units = self._to_base_units(request.amount, token.decimals)

                idem_headers: Optional[Dict[str, str]] = (
                    {"X-Idempotency-Key": idempotency_key}
                    if idempotency_key is not None
                    else None
                )

                async def _sign(_span: Any) -> str:
                    # Mock mode: payer placeholder. Real mode: EIP-3009 sign.
                    if self._wallet_private_key is None:
                        return f"payer:{self._bot_id}"
                    return await self._sign_payload(
                        request=request,
                        amount_base_units=amount_base_units,
                        token_contract=token_contract,
                        network_id=network_id,
                        symbol=symbol,
                    )

                payload_string = await with_span(
                    self._telemetry, "x402.sign", {"network": network_id}, _sign
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

                # Step 1: /verify (challenge)
                try:
                    async def _verify(_span: Any) -> Any:
                        return await self._request(
                            "/verify",
                            method="POST",
                            body={
                                "botId": self._bot_id,
                                "payload": payload_body,
                                "requirements": requirements,
                            },
                            extra_headers=idem_headers,
                        )

                    verify_data = await with_span(
                        self._telemetry, "x402.challenge", {}, _verify
                    )
                except PayBotApiError as e:
                    if pay_span is not None:
                        pay_span.set_attribute("success", False)
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
                    if pay_span is not None:
                        pay_span.set_attribute("success", False)
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
                    async def _settle(_span: Any) -> Any:
                        return await self._request(
                            "/settle",
                            method="POST",
                            body={
                                "botId": self._bot_id,
                                "settlementToken": settlement_token,
                                "payload": payload_body,
                                "requirements": verify_data.get(
                                    "modifiedRequirements", requirements
                                ),
                                "commission": verify_data.get("commission"),
                            },
                        )

                    settle_data = await with_span(
                        self._telemetry, "x402.settle", {}, _settle
                    )
                except PayBotApiError as e:
                    if pay_span is not None:
                        pay_span.set_attribute("success", False)
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

                result = PaymentResult(
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

                if pay_span is not None:
                    pay_span.set_attribute("success", result.success)
                    if result.tx_hash:
                        pay_span.set_attribute("tx_hash", result.tx_hash)

                # Cache only successful results so a retry short-circuits.
                if idempotency_key is not None and result.success:
                    self._pay_idempotency_cache.set(idempotency_key, result)

                return result
            except Exception as error:  # noqa: BLE001 — pay() never throws (client.ts:456)
                # Mirrors the TS outer catch: ALL errors (including a leaked
                # PayBotApiError from signing) become a failure PaymentResult, so
                # the telemetry span stays OK (nothing escapes pay()).
                if pay_span is not None:
                    pay_span.set_attribute("success", False)
                return PaymentResult(
                    success=False,
                    gross_amount="0",
                    net_amount="0",
                    commission_amount="0",
                    commission_rate=0,
                    error=get_error_message(error),
                )

        return await with_span(
            self._telemetry,
            "client.pay",
            {
                "network": network_id,
                "amount": request.amount,
                "bot_id": self._bot_id,
            },
            _do_pay,
        )

    async def _sign_payload(
        self,
        request: PaymentRequest,
        amount_base_units: str,
        token_contract: str,
        network_id: str,
        symbol: str = "USDC",
    ) -> str:
        """Sign an EIP-3009 ``TransferWithAuthorization`` for the given payment.

        Builds EIP-712 typed-data from ``get_eip712_domain(network_id, symbol)`` +
        ``EIP3009_TYPES`` and signs it off-chain with the configured wallet
        private key. The returned string is the JSON ``payload`` blob the
        facilitator expects — byte-for-byte the same shape produced by the TS
        SDK's ``client.ts:buildPaymentPayload``.

        REGRESSION GUARANTEE: for ``symbol == 'USDC'`` the resolved domain is
        byte-identical to the legacy ``EIP712_DOMAINS[network_id]`` table, so
        existing USDC signatures are unchanged. EURC signs under its own domain.

        :param request: The originating :class:`PaymentRequest` (``pay_to`` is the
            EIP-3009 ``to`` recipient).
        :param amount_base_units: Amount in base units (decimal string).
        :param token_contract: The resolved token contract address to sign against.
            Passed through to the EIP-712 domain's ``verifyingContract`` so an
            operator-injected address (absent from the public registry, e.g. EURC
            mainnet) signs correctly.
        :param network_id: CAIP-2 network id, e.g. ``"eip155:84532"``.
        :param symbol: Token ticker to sign for (default ``"USDC"``).
        :returns: JSON string carrying the signed EIP-3009 authorization.
        :raises ValueError: if ``network_id``/``symbol`` has no registered EIP-712
            domain, or if no ``wallet_private_key`` is configured.

        :example:
            >>> # client configured with wallet_private_key
            >>> payload = await client._sign_payload(req, "50000", usdc, "eip155:84532")
            >>> json.loads(payload)["signature"].startswith("0x")
            True
        """
        if self._wallet_private_key is None:
            raise ValueError("_sign_payload requires a wallet_private_key")

        domain = get_eip712_domain(network_id, symbol, token_contract)
        if domain is None:
            raise ValueError(f"No EIP-712 domain for network: {network_id}")

        # Lazy import so the SDK is importable without the optional `signing`
        # extra installed; only `pay()` in real mode pulls eth-account in.
        from eth_account import Account

        account = Account.from_key(self._wallet_private_key)
        signer_address = account.address

        nonce = generate_eip3009_nonce()
        now_seconds = int(time.time())
        valid_after = 0
        valid_before = now_seconds + 3600  # 1 hour from now
        value = int(amount_base_units)

        message = {
            "from": signer_address,
            "to": request.pay_to,
            "value": value,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce,
        }

        # eth-account 0.13.x: `sign_typed_data(private_key, domain_data,
        # message_types, message_data)`. `.signature` is a HexBytes; `.hex()`
        # yields 130 hex chars WITHOUT a `0x` prefix on this version, so we
        # prefix explicitly to match viem's `0x`-prefixed 65-byte signature.
        signed = Account.sign_typed_data(
            self._wallet_private_key,
            domain,
            EIP3009_TYPES,
            message,
        )
        sig_hex = signed.signature.hex()
        signature = sig_hex if sig_hex.startswith("0x") else "0x" + sig_hex

        # Wire contract MUST match client.ts:buildPaymentPayload — a JSON string
        # with numeric fields stringified.
        return json.dumps(
            {
                "from": signer_address,
                "to": request.pay_to,
                "value": str(value),
                "validAfter": str(valid_after),
                "validBefore": str(valid_before),
                "nonce": nonce,
                "signature": signature,
            }
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

    # ── Auth: static methods (pre-client-creation; client.ts:670-792) ─────

    @staticmethod
    async def signup(
        email: str,
        password: str,
        *,
        facilitator_url: Optional[str] = None,
        bot_id: Optional[str] = None,
    ) -> SignupResult:
        """One-call signup: register → login → create API key → register bot (client.ts:670).

        Endpoint sequence: POST ``/auth/register`` → POST ``/auth/login`` → POST
        ``/api-keys`` (Bearer) → POST ``/bots`` (X-API-Key). Standalone — no client
        instance needed; uses a throwaway ``httpx.AsyncClient``.

        :returns: A :class:`SignupResult` with the operator id, API key, and bot id.
        :raises PayBotApiError: with a stage-specific code on any non-2xx response
            (``REGISTRATION_FAILED``, ``LOGIN_FAILED``, ``KEY_CREATION_FAILED``,
            ``BOT_REGISTRATION_FAILED``).
        """
        base_url = (facilitator_url or DEFAULT_FACILITATOR_URL).rstrip("/")
        resolved_bot_id = bot_id or "default"

        async with httpx.AsyncClient() as http:
            # 1. Register operator
            register_res = await http.post(
                f"{base_url}/auth/register", json={"email": email, "password": password}
            )
            register_data = _safe_json(register_res)
            _raise_if_not_ok(
                register_res, register_data, "Registration failed", "REGISTRATION_FAILED"
            )
            operator_id = register_data["operatorId"]

            # 2. Login to get JWT
            login_res = await http.post(
                f"{base_url}/auth/login", json={"email": email, "password": password}
            )
            login_data = _safe_json(login_res)
            _raise_if_not_ok(login_res, login_data, "Login failed", "LOGIN_FAILED")
            access_token = login_data["accessToken"]

            # 3. Create API key
            key_res = await http.post(
                f"{base_url}/api-keys",
                json={"operatorId": operator_id, "label": "default", "permissions": "all"},
                headers={"Authorization": f"Bearer {access_token}"},
            )
            key_data = _safe_json(key_res)
            _raise_if_not_ok(
                key_res, key_data, "API key creation failed", "KEY_CREATION_FAILED"
            )
            api_key = key_data["key"]

            # 4. Register default bot
            bot_res = await http.post(
                f"{base_url}/bots",
                json={"botId": resolved_bot_id, "trustLevel": 1},
                headers={"X-API-Key": api_key},
            )
            if bot_res.status_code < 200 or bot_res.status_code >= 300:
                bot_data = _safe_json(bot_res)
                _raise_if_not_ok(
                    bot_res, bot_data, "Bot registration failed", "BOT_REGISTRATION_FAILED"
                )

        return SignupResult(
            operator_id=operator_id,
            api_key=api_key,
            bot_id=resolved_bot_id,
            message=(
                "Save your API key — it is shown only once. "
                "Use it to create a PayBotClient."
            ),
        )

    @staticmethod
    async def login(
        email: str,
        password: str,
        *,
        facilitator_url: Optional[str] = None,
    ) -> LoginResult:
        """Login with email + password, returning JWT tokens (client.ts:759).

        :returns: A :class:`LoginResult` with access/refresh tokens + operator info.
        :raises PayBotApiError: code ``LOGIN_FAILED`` on a non-2xx response.
        """
        base_url = (facilitator_url or DEFAULT_FACILITATOR_URL).rstrip("/")
        async with httpx.AsyncClient() as http:
            res = await http.post(
                f"{base_url}/auth/login", json={"email": email, "password": password}
            )
            data = _safe_json(res)
            _raise_if_not_ok(res, data, "Login failed", "LOGIN_FAILED")

        operator = data["operator"]
        return LoginResult(
            access_token=data["accessToken"],
            refresh_token=data["refreshToken"],
            expires_in=data["expiresIn"],
            operator=OperatorRef(
                id=operator["id"],
                email=operator["email"],
                tier=operator["tier"],
                display_name=operator.get("displayName"),
            ),
        )

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
