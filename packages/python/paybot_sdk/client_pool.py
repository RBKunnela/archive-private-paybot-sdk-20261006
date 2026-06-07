"""PayBotClientPool — Python port of ``src/client-pool.ts``.

Manage many bots from one operator process while sharing operator-/transport-level
config (API key, facilitator URL, timeout, retries, telemetry) and an optional
shared spend treasury. Each bot keeps its OWN signing context (its own
``wallet_private_key``) and never cross-signs another bot's payments.

The optional shared treasury tracks cumulative spend across ALL bots for the
current UTC day, in memory. Per-bot local counters are a convenience projection
only — they do NOT replace the facilitator's authoritative server-side limits.
"""
from __future__ import annotations

import asyncio
import datetime
import math
import warnings
from dataclasses import dataclass
from typing import Dict, List, Optional

from .client import PayBotClient
from .telemetry import TelemetryConfig
from .types import PaymentRequest, PaymentResult, PayBotConfig, TrustLevel


@dataclass
class PayBotClientPoolConfig:
    """Operator-/transport-level config shared by every bot in a pool.

    Per-bot identity (``bot_id``, ``wallet_private_key``, ``trust_level``) is
    intentionally NOT here — it is supplied per bot via :meth:`PayBotClientPool.add_bot`.

    :param api_key: PayBot API key shared by all bots.
    :param operator_id: Operator identifier shared by all bots.
    :param facilitator_url: PayBot facilitator URL.
    :param timeout_ms: Request timeout (ms), applied to every bot.
    :param max_retries: Max retries on network/5xx errors, applied to every bot.
    :param telemetry: Optional opt-in tracing shared by all bots.
    :param shared_daily_limit_usd: Optional shared spend envelope (USD). When set,
        the pool refuses any spend that would push the running daily total over it.
    """

    api_key: str
    operator_id: Optional[str] = None
    facilitator_url: Optional[str] = None
    timeout_ms: int = 30_000
    max_retries: int = 1
    telemetry: Optional[TelemetryConfig] = None
    shared_daily_limit_usd: Optional[float] = None


@dataclass
class PoolBotOptions:
    """Per-bot identity supplied when adding a bot to the pool.

    :param bot_id: Unique bot identifier within this pool.
    :param wallet_private_key: Bot wallet private key for EIP-3009 signing.
    :param trust_level: Initial trust level for this bot.
    """

    bot_id: str
    wallet_private_key: Optional[str] = None
    trust_level: Optional[TrustLevel] = None


@dataclass
class PoolBotStats:
    """Lightweight, local per-bot bookkeeping for the current UTC day.

    A convenience projection only — NOT a replacement for the facilitator's
    authoritative spend/rate limits.

    :param daily_spent_usd: Total USD this bot has spent today (UTC), per local accounting.
    :param daily_tx_count: Number of successful transactions this bot made today (UTC).
    """

    daily_spent_usd: float
    daily_tx_count: int


@dataclass
class _PoolEntry:
    """Internal per-bot record held by the pool."""

    client: PayBotClient
    daily_spent_usd: float = 0.0
    daily_tx_count: int = 0


def _utc_day_key() -> str:
    """Current UTC date as ``YYYY-MM-DD``, the day-rollover key."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


class PayBotClientPool:
    """Manage many bots from one operator process with a shared treasury.

    :param config: Shared operator-/transport-level config. At minimum ``api_key``
        is required.
    :raises ValueError: when ``api_key`` is missing/blank, or ``shared_daily_limit_usd``
        is provided but not a finite, non-negative number.

    :example:
        >>> pool = PayBotClientPool(PayBotClientPoolConfig(
        ...     api_key="pb_test_...", shared_daily_limit_usd=100))
        >>> pool.add_bot(PoolBotOptions(bot_id="bot-a", wallet_private_key="0x..."))
    """

    def __init__(self, config: PayBotClientPoolConfig) -> None:
        if not config.api_key or not isinstance(config.api_key, str):
            raise ValueError(
                "PayBotClientPool: api_key is required and must be a non-empty string"
            )
        if config.shared_daily_limit_usd is not None and (
            not isinstance(config.shared_daily_limit_usd, (int, float))
            or isinstance(config.shared_daily_limit_usd, bool)
            or not math.isfinite(config.shared_daily_limit_usd)
            or config.shared_daily_limit_usd < 0
        ):
            raise ValueError(
                "PayBotClientPool: shared_daily_limit_usd must be a finite, non-negative number"
            )
        self._config = config
        self._bots: Dict[str, _PoolEntry] = {}
        self._treasury_spent_usd = 0.0
        self._treasury_day = _utc_day_key()
        # Serializes treasury reserve/commit/refund so concurrent pay_as() calls
        # cannot each pass can_spend() and collectively overrun the shared limit
        # (CodeRabbit #4). The lock is held ONLY around in-memory accounting and
        # is released before any network I/O (client.pay()).
        self._treasury_lock = asyncio.Lock()

    def _rollover_if_needed(self) -> None:
        """Roll over the treasury + per-bot counters when the UTC day changes."""
        today = _utc_day_key()
        if today == self._treasury_day:
            return
        self._treasury_day = today
        self._treasury_spent_usd = 0.0
        for entry in self._bots.values():
            entry.daily_spent_usd = 0.0
            entry.daily_tx_count = 0

    def add_bot(self, opts: PoolBotOptions) -> PayBotClient:
        """Construct a :class:`PayBotClient` for a bot, store it by id, and return it.

        Each bot's ``wallet_private_key`` stays bound to its own client, so bots
        never cross-sign one another's payments.

        :param opts: The bot's identity.
        :returns: The newly constructed client for this bot.
        :raises ValueError: when ``bot_id`` is already present in the pool.
        """
        if opts.bot_id in self._bots:
            raise ValueError(f"PayBotClientPool: bot already added: {opts.bot_id}")
        client = PayBotClient(
            PayBotConfig(
                api_key=self._config.api_key,
                bot_id=opts.bot_id,
                operator_id=self._config.operator_id,
                facilitator_url=self._config.facilitator_url,
                timeout_ms=self._config.timeout_ms,
                max_retries=self._config.max_retries,
                telemetry=self._config.telemetry,
                wallet_private_key=opts.wallet_private_key,
            )
        )
        self._bots[opts.bot_id] = _PoolEntry(client=client)
        return client

    def get_bot(self, bot_id: str) -> PayBotClient:
        """Look up a bot's client.

        :raises ValueError: when ``bot_id`` is not in the pool.
        """
        entry = self._bots.get(bot_id)
        if entry is None:
            raise ValueError(f"PayBotClientPool: unknown bot: {bot_id}")
        return entry.client

    def remove_bot(self, bot_id: str) -> bool:
        """Remove a bot from the pool WITHOUT closing its HTTP client.

        Kept synchronous for backward compatibility, but it leaks the bot's
        ``httpx.AsyncClient`` connection pool (CodeRabbit #2): dropping the last
        reference does not close the transport. Prefer the async
        :meth:`aclose_bot`, which closes the client before removing it.

        :returns: ``True`` if a bot was removed, ``False`` if it was not present.
        """
        entry = self._bots.pop(bot_id, None)
        if entry is None:
            return False
        warnings.warn(
            "PayBotClientPool.remove_bot does not close the bot's HTTP client and "
            "leaks its connection pool; use 'await pool.aclose_bot(bot_id)' instead.",
            ResourceWarning,
            stacklevel=2,
        )
        return True

    async def aclose_bot(self, bot_id: str) -> bool:
        """Remove a bot AND close its underlying HTTP client.

        The leak-free counterpart to :meth:`remove_bot` (CodeRabbit #2).

        :param bot_id: The bot to remove and close.
        :returns: ``True`` if a bot was removed (and closed), ``False`` if it was
            not present.
        """
        entry = self._bots.pop(bot_id, None)
        if entry is None:
            return False
        await entry.client.aclose()
        return True

    async def aclose(self) -> None:
        """Close every bot's HTTP client and empty the pool.

        Idempotent. Call this when the pool is no longer needed so no bot's
        ``httpx.AsyncClient`` connection pool is leaked.
        """
        entries = list(self._bots.values())
        self._bots.clear()
        for entry in entries:
            await entry.client.aclose()

    def has_bot(self, bot_id: str) -> bool:
        """Whether a bot with this id is in the pool."""
        return bot_id in self._bots

    def bot_ids(self) -> List[str]:
        """All bot ids currently in the pool, in insertion order."""
        return list(self._bots.keys())

    @property
    def size(self) -> int:
        """Number of bots in the pool."""
        return len(self._bots)

    def record_spend(self, bot_id: str, amount_usd: float) -> None:
        """Record a successful spend against the shared treasury and the bot's
        local counters. Rolls counters over first if the UTC day changed.

        Negative/non-finite amounts are treated as 0 (a bad call never credits the
        treasury). An unknown ``bot_id`` updates the shared treasury but records no
        per-bot stat.

        :param bot_id: The spending bot's identifier.
        :param amount_usd: The amount spent, in USD.
        """
        self._rollover_if_needed()
        amount = amount_usd if (math.isfinite(amount_usd) and amount_usd > 0) else 0.0
        self._treasury_spent_usd += amount
        entry = self._bots.get(bot_id)
        if entry is not None:
            entry.daily_spent_usd += amount
            entry.daily_tx_count += 1

    def remaining_treasury_usd(self) -> Optional[float]:
        """Remaining shared-treasury budget for the current UTC day.

        :returns: The remaining USD (never below 0), or ``None`` when no shared
            limit is configured (unbounded treasury).
        """
        if self._config.shared_daily_limit_usd is None:
            return None
        self._rollover_if_needed()
        return max(0.0, self._config.shared_daily_limit_usd - self._treasury_spent_usd)

    def can_spend(self, amount_usd: float) -> bool:
        """Whether a spend of ``amount_usd`` fits within the remaining treasury.

        Always ``True`` when no shared limit is configured. A non-finite/negative
        amount is treated as 0 (always fits).
        """
        remaining = self.remaining_treasury_usd()
        if remaining is None:
            return True
        amount = amount_usd if (math.isfinite(amount_usd) and amount_usd > 0) else 0.0
        return amount <= remaining

    def bot_stats(self, bot_id: str) -> PoolBotStats:
        """Per-bot local spend/tx bookkeeping for the current UTC day.

        A convenience projection only. Rolls counters over if the UTC day changed.

        :raises ValueError: when ``bot_id`` is not in the pool.
        """
        self._rollover_if_needed()
        entry = self._bots.get(bot_id)
        if entry is None:
            raise ValueError(f"PayBotClientPool: unknown bot: {bot_id}")
        return PoolBotStats(
            daily_spent_usd=entry.daily_spent_usd, daily_tx_count=entry.daily_tx_count
        )

    async def pay_as(self, bot_id: str, request: PaymentRequest) -> PaymentResult:
        """Pay on behalf of a bot, gated by the shared treasury.

        Concurrency-safe (CodeRabbit #4): when a shared limit is configured, the
        spend is RESERVED against the treasury under an ``asyncio.Lock`` (with a
        re-check of the limit) BEFORE the network call. The lock is released
        before ``client.pay()`` so it never spans network I/O. On any failure —
        exception OR ``result.success=False`` — the reservation is refunded under
        the lock. This prevents N concurrent callers from each passing the limit
        check and collectively overrunning the budget.

        :param bot_id: The bot to pay as.
        :param request: The payment request.
        :returns: The bot's :class:`PaymentResult`, or a ``TREASURY_EXCEEDED`` /
            ``INVALID_AMOUNT`` failure.
        :raises ValueError: when ``bot_id`` is not in the pool.
        """
        client = self.get_bot(bot_id)

        # Reject nan/inf/unparseable/negative amounts BEFORE any treasury math
        # (CodeRabbit #3) — they must never be treated as zero-cost.
        amount_usd = _parse_amount_usd(request.amount)
        if amount_usd is None:
            return _pool_fail(
                "INVALID_AMOUNT", f"Invalid payment amount: {request.amount!r}"
            )

        bounded = self._config.shared_daily_limit_usd is not None

        # Reserve under lock (re-checks the limit atomically). The lock is held
        # only for in-memory accounting, never across the await on pay().
        if bounded:
            async with self._treasury_lock:
                self._rollover_if_needed()
                remaining = max(
                    0.0, self._config.shared_daily_limit_usd - self._treasury_spent_usd
                )
                if amount_usd > remaining:
                    return _pool_fail(
                        "TREASURY_EXCEEDED",
                        f"Shared treasury exceeded: remaining {remaining} USD, "
                        f"requested {request.amount} USD",
                    )
                self._treasury_spent_usd += amount_usd  # optimistic reservation

        try:
            result = await client.pay(request)
        except BaseException:
            # Refund the reservation under lock, then re-raise.
            if bounded:
                async with self._treasury_lock:
                    self._treasury_spent_usd = max(
                        0.0, self._treasury_spent_usd - amount_usd
                    )
            raise

        if result.success:
            # Reservation already debited the treasury; only record per-bot stats
            # (under lock, without double-counting the treasury).
            if bounded:
                async with self._treasury_lock:
                    self._record_bot_stat(bot_id, amount_usd)
            else:
                self.record_spend(bot_id, amount_usd)
        elif bounded:
            # Refund the reservation for a logical (success=False) failure.
            async with self._treasury_lock:
                self._treasury_spent_usd = max(0.0, self._treasury_spent_usd - amount_usd)
        return result

    def _record_bot_stat(self, bot_id: str, amount_usd: float) -> None:
        """Record a committed spend on a bot's local counters only (treasury was
        already debited by the reservation). Caller must hold ``_treasury_lock``."""
        entry = self._bots.get(bot_id)
        if entry is not None:
            entry.daily_spent_usd += amount_usd
            entry.daily_tx_count += 1


def _pool_fail(error_code: str, error: str) -> PaymentResult:
    """Build a zeroed failure :class:`PaymentResult` for pool-level rejections."""
    return PaymentResult(
        success=False,
        gross_amount="0",
        net_amount="0",
        commission_amount="0",
        commission_rate=0,
        error=error,
        error_code=error_code,
    )


def _parse_amount_usd(value: str) -> Optional[float]:
    """Parse a payment amount to a finite, non-negative float.

    Returns ``None`` for unparseable, non-finite (nan/inf), or negative values
    so callers can reject them explicitly instead of silently treating them as
    zero-cost (CodeRabbit #3).
    """
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed < 0:
        return None
    return parsed
