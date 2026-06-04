"""PayBotClientPool — manage many bots from one operator process. Mirrors ``src/client-pool.ts``.

One operator running N bots should not pay the cost of N fully-independent
clients: the pool holds a single shared config (API key, facilitator URL,
timeout, retries, telemetry) and constructs one :class:`PayBotClient` per bot
that merges that shared config with the bot's own identity. Each bot keeps its
OWN signing context (its own ``wallet_private_key``) and never cross-signs.

The optional shared treasury tracks cumulative spend across ALL bots for the
current UTC day in memory. Per-bot counters (:meth:`PayBotClientPool.bot_stats`)
are a convenience projection only and do NOT replace the facilitator's
authoritative limits.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

from .client import PayBotClient
from .telemetry import TelemetryConfig
from .types import PayBotConfig, PaymentRequest, PaymentResult, TrustLevel


@dataclass
class PayBotClientPoolConfig:
    """Operator-/transport-level config shared by every bot in a pool (client-pool.ts:22-47).

    Per-bot identity (``bot_id``, ``wallet_private_key``, ``trust_level``) is NOT
    here — it is supplied per bot via :meth:`PayBotClientPool.add_bot`.

    :param api_key: PayBot API key shared by all bots in this pool.
    :param operator_id: Operator identifier shared by all bots.
    :param facilitator_url: PayBot facilitator URL.
    :param timeout_ms: Request timeout in ms, applied to every bot.
    :param max_retries: Max retries on network errors / 5xx, applied to every bot.
    :param telemetry: Optional, opt-in OpenTelemetry tracing shared by all bots.
    :param shared_daily_limit_usd: Optional shared spend envelope. When set, the
        pool tracks cumulative spend across ALL bots for the current UTC day and
        refuses any spend that would push the running total over this limit.
    """

    api_key: str
    operator_id: Optional[str] = None
    facilitator_url: Optional[str] = None
    timeout_ms: Optional[int] = None
    max_retries: Optional[int] = None
    telemetry: Optional[TelemetryConfig] = None
    shared_daily_limit_usd: Optional[float] = None


@dataclass
class PoolBotOptions:
    """Per-bot identity supplied when adding a bot to the pool (client-pool.ts:50-57).

    :param bot_id: Unique bot identifier within this pool.
    :param wallet_private_key: Bot wallet private key for EIP-3009 signing.
    :param trust_level: Initial trust level for this bot.
    """

    bot_id: str
    wallet_private_key: Optional[str] = None
    trust_level: Optional[TrustLevel] = None


@dataclass
class PoolBotStats:
    """Lightweight per-bot bookkeeping for the current UTC day (client-pool.ts:67-72).

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
    daily_spent_usd: float
    daily_tx_count: int


def _utc_day_key() -> str:
    """Current UTC date as ``YYYY-MM-DD`` (client-pool.ts:86). Module-level seam for tests."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _parse_amount_usd(s: str) -> float:
    """Lenient ``parseFloat``-equivalent for amount strings (PARITY-SPEC §1.8 note).

    JS ``parseFloat`` parses a leading numeric prefix (``'5abc'`` -> ``5.0``) and
    returns ``NaN`` for non-numeric (``'abc'`` -> ``NaN``). Python ``float()``
    would raise, so this prefix-parses and returns ``math.nan`` on failure to
    preserve the "non-numeric amount = zero-cost spend" treasury semantics.
    """
    if not isinstance(s, str):
        try:
            return float(s)
        except (TypeError, ValueError):
            return math.nan
    match = re.match(r"\s*([-+]?(?:\d+\.?\d*|\.\d+))", s)
    if not match:
        return math.nan
    try:
        return float(match.group(1))
    except ValueError:
        return math.nan


class PayBotClientPool:
    """Manage many bots from one operator process with a shared treasury (client-pool.ts:122)."""

    def __init__(self, config: PayBotClientPoolConfig) -> None:
        """:param config: Shared operator-/transport-level config.

        :raises ValueError: when ``api_key`` is missing/not a non-empty string, or
            ``shared_daily_limit_usd`` is provided but not finite/non-negative.
        """
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

    def _rollover_if_needed(self) -> None:
        """Roll over the treasury + per-bot counters when the UTC day changes (client-pool.ts:156)."""
        today = _utc_day_key()
        if today == self._treasury_day:
            return
        self._treasury_day = today
        self._treasury_spent_usd = 0.0
        for entry in self._bots.values():
            entry.daily_spent_usd = 0.0
            entry.daily_tx_count = 0

    def add_bot(self, opts: PoolBotOptions) -> PayBotClient:
        """Construct + store a :class:`PayBotClient` for a bot (client-pool.ts:181).

        :raises ValueError: when ``bot_id`` is already present in the pool.
        """
        if opts.bot_id in self._bots:
            raise ValueError(f"PayBotClientPool: bot already added: {opts.bot_id}")
        client = PayBotClient(
            PayBotConfig(
                api_key=self._config.api_key,
                bot_id=opts.bot_id,
                facilitator_url=self._config.facilitator_url,
                operator_id=self._config.operator_id,
                wallet_private_key=opts.wallet_private_key,
                max_retries=self._config.max_retries if self._config.max_retries is not None else 1,
                timeout_ms=self._config.timeout_ms if self._config.timeout_ms is not None else 30_000,
                telemetry=self._config.telemetry,
            )
        )
        self._bots[opts.bot_id] = _PoolEntry(client=client, daily_spent_usd=0.0, daily_tx_count=0)
        return client

    def get_bot(self, bot_id: str) -> PayBotClient:
        """Look up a bot's client (client-pool.ts:207).

        :raises ValueError: when ``bot_id`` is not in the pool.
        """
        entry = self._bots.get(bot_id)
        if entry is None:
            raise ValueError(f"PayBotClientPool: unknown bot: {bot_id}")
        return entry.client

    def remove_bot(self, bot_id: str) -> bool:
        """Remove a bot from the pool (client-pool.ts:221).

        :returns: ``True`` if a bot was removed, ``False`` if it was not present.
        """
        if bot_id in self._bots:
            del self._bots[bot_id]
            return True
        return False

    def has_bot(self, bot_id: str) -> bool:
        """Whether a bot with this id is in the pool (client-pool.ts:231)."""
        return bot_id in self._bots

    def bot_ids(self) -> List[str]:
        """All bot ids currently in the pool, in insertion order (client-pool.ts:240)."""
        return list(self._bots.keys())

    @property
    def size(self) -> int:
        """Number of bots in the pool (client-pool.ts:245)."""
        return len(self._bots)

    def record_spend(self, bot_id: str, amount_usd: float) -> None:
        """Record a successful spend against the treasury + bot counters (client-pool.ts:260).

        Negative/non-finite amounts are treated as 0. An unknown ``bot_id`` updates
        the shared treasury but records no per-bot stat.
        """
        self._rollover_if_needed()
        amount = amount_usd if (math.isfinite(amount_usd) and amount_usd > 0) else 0.0
        self._treasury_spent_usd += amount
        entry = self._bots.get(bot_id)
        if entry is not None:
            entry.daily_spent_usd += amount
            entry.daily_tx_count += 1

    def remaining_treasury_usd(self) -> Optional[float]:
        """Remaining shared-treasury budget for the current UTC day (client-pool.ts:277).

        :returns: The remaining USD (never below 0), or ``None`` when no shared
            limit is configured (unbounded treasury).
        """
        if self._config.shared_daily_limit_usd is None:
            return None
        self._rollover_if_needed()
        return max(0.0, self._config.shared_daily_limit_usd - self._treasury_spent_usd)

    def can_spend(self, amount_usd: float) -> bool:
        """Whether ``amount_usd`` fits within the remaining shared treasury (client-pool.ts:292).

        Always ``True`` when no shared limit is configured. A non-finite/negative
        amount is treated as 0 (consumes nothing, always fits).
        """
        remaining = self.remaining_treasury_usd()
        if remaining is None:
            return True
        amount = amount_usd if (math.isfinite(amount_usd) and amount_usd > 0) else 0.0
        return amount <= remaining

    def bot_stats(self, bot_id: str) -> PoolBotStats:
        """Per-bot local spend/tx bookkeeping for the current UTC day (client-pool.ts:311).

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
        """Pay on behalf of a bot, gated by the shared treasury (client-pool.ts:341).

        When a shared limit is configured, the prospective spend is checked against
        the remaining treasury FIRST. If it would exceed the budget, a
        ``TREASURY_EXCEEDED`` failure is returned immediately and NO network call
        is made. Otherwise the bot's own ``pay()`` runs; on ``success`` the spend is
        recorded.

        :raises ValueError: when ``bot_id`` is not in the pool.
        """
        client = self.get_bot(bot_id)
        amount_usd = _parse_amount_usd(request.amount)

        if self._config.shared_daily_limit_usd is not None and not self.can_spend(amount_usd):
            return PaymentResult(
                success=False,
                gross_amount="0",
                net_amount="0",
                commission_amount="0",
                commission_rate=0,
                error=(
                    f"Shared treasury exceeded: remaining {self.remaining_treasury_usd()} USD, "
                    f"requested {request.amount} USD"
                ),
                error_code="TREASURY_EXCEEDED",
            )

        result = await client.pay(request)
        if result.success:
            self.record_spend(bot_id, amount_usd)
        return result
