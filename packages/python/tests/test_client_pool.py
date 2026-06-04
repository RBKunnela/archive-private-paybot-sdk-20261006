"""Tests for PayBotClientPool + shared treasury. Mirrors ``tests/client-pool.test.ts``."""
from __future__ import annotations

import math

import pytest
import respx
from httpx import Response

from paybot_sdk import (
    PayBotClient,
    PayBotClientPool,
    PayBotClientPoolConfig,
    PaymentRequest,
    PoolBotOptions,
    PoolBotStats,
)
from paybot_sdk.client_pool import _parse_amount_usd

PK = "0x" + "1" * 64


def _pool(**over):
    cfg = dict(api_key="pb_test", facilitator_url="https://fac.example")
    cfg.update(over)
    return PayBotClientPool(PayBotClientPoolConfig(**cfg))


# ── construction validation ────────────────────────────────────────────────


def test_pool_requires_api_key():
    with pytest.raises(ValueError, match="api_key"):
        PayBotClientPool(PayBotClientPoolConfig(api_key=""))


def test_pool_rejects_negative_limit():
    with pytest.raises(ValueError, match="shared_daily_limit_usd"):
        PayBotClientPool(PayBotClientPoolConfig(api_key="k", shared_daily_limit_usd=-1))


def test_pool_rejects_inf_limit():
    with pytest.raises(ValueError):
        PayBotClientPool(PayBotClientPoolConfig(api_key="k", shared_daily_limit_usd=math.inf))


def test_pool_accepts_zero_limit():
    pool = _pool(shared_daily_limit_usd=0)
    assert pool.remaining_treasury_usd() == 0


# ── add/get/remove/has/ids/size ────────────────────────────────────────────


def test_add_bot_returns_client():
    pool = _pool()
    client = pool.add_bot(PoolBotOptions(bot_id="a", wallet_private_key=PK))
    assert isinstance(client, PayBotClient)
    assert pool.size == 1


def test_add_bot_duplicate_raises():
    pool = _pool()
    pool.add_bot(PoolBotOptions(bot_id="a"))
    with pytest.raises(ValueError, match="already added"):
        pool.add_bot(PoolBotOptions(bot_id="a"))


def test_get_bot_returns_same_client():
    pool = _pool()
    c = pool.add_bot(PoolBotOptions(bot_id="a"))
    assert pool.get_bot("a") is c


def test_get_bot_unknown_raises():
    pool = _pool()
    with pytest.raises(ValueError, match="unknown bot"):
        pool.get_bot("nope")


def test_remove_bot_true_then_false():
    pool = _pool()
    pool.add_bot(PoolBotOptions(bot_id="a"))
    assert pool.remove_bot("a") is True
    assert pool.remove_bot("a") is False


def test_has_bot():
    pool = _pool()
    pool.add_bot(PoolBotOptions(bot_id="a"))
    assert pool.has_bot("a") is True
    assert pool.has_bot("b") is False


def test_bot_ids_insertion_order():
    pool = _pool()
    pool.add_bot(PoolBotOptions(bot_id="a"))
    pool.add_bot(PoolBotOptions(bot_id="b"))
    assert pool.bot_ids() == ["a", "b"]


def test_size():
    pool = _pool()
    assert pool.size == 0
    pool.add_bot(PoolBotOptions(bot_id="a"))
    assert pool.size == 1


# ── treasury accounting ────────────────────────────────────────────────────


def test_remaining_treasury_none_when_unbounded():
    pool = _pool()
    assert pool.remaining_treasury_usd() is None


def test_remaining_treasury_with_limit():
    pool = _pool(shared_daily_limit_usd=100)
    assert pool.remaining_treasury_usd() == 100


def test_record_spend_decrements_treasury():
    pool = _pool(shared_daily_limit_usd=100)
    pool.add_bot(PoolBotOptions(bot_id="a"))
    pool.record_spend("a", 30)
    assert pool.remaining_treasury_usd() == 70


def test_record_spend_negative_treated_as_zero():
    pool = _pool(shared_daily_limit_usd=100)
    pool.record_spend("a", -50)
    assert pool.remaining_treasury_usd() == 100


def test_record_spend_nan_treated_as_zero():
    pool = _pool(shared_daily_limit_usd=100)
    pool.record_spend("a", math.nan)
    assert pool.remaining_treasury_usd() == 100


def test_record_spend_unknown_bot_updates_treasury_only():
    pool = _pool(shared_daily_limit_usd=100)
    pool.record_spend("ghost", 10)
    assert pool.remaining_treasury_usd() == 90


def test_can_spend_within_budget():
    pool = _pool(shared_daily_limit_usd=100)
    assert pool.can_spend(50) is True


def test_can_spend_over_budget():
    pool = _pool(shared_daily_limit_usd=100)
    pool.record_spend("a", 80)
    assert pool.can_spend(30) is False


def test_can_spend_unbounded_always_true():
    pool = _pool()
    assert pool.can_spend(1_000_000) is True


def test_bot_stats():
    pool = _pool()
    pool.add_bot(PoolBotOptions(bot_id="a"))
    pool.record_spend("a", 5)
    pool.record_spend("a", 7)
    stats = pool.bot_stats("a")
    assert isinstance(stats, PoolBotStats)
    assert stats.daily_spent_usd == 12
    assert stats.daily_tx_count == 2


def test_bot_stats_unknown_raises():
    pool = _pool()
    with pytest.raises(ValueError, match="unknown bot"):
        pool.bot_stats("nope")


# ── day rollover (seam monkeypatched) ──────────────────────────────────────


def test_rollover_zeroes_counters(monkeypatch):
    pool = _pool(shared_daily_limit_usd=100)
    pool.add_bot(PoolBotOptions(bot_id="a"))
    pool.record_spend("a", 40)
    assert pool.remaining_treasury_usd() == 60
    # Advance the UTC day via the module-level seam.
    monkeypatch.setattr("paybot_sdk.client_pool._utc_day_key", lambda: "2099-12-31")
    assert pool.remaining_treasury_usd() == 100  # reset
    assert pool.bot_stats("a").daily_spent_usd == 0


# ── pay_as treasury gating ─────────────────────────────────────────────────


async def test_pay_as_treasury_exceeded_pre_network():
    pool = _pool(shared_daily_limit_usd=10)
    pool.add_bot(PoolBotOptions(bot_id="a"))
    with respx.mock:
        verify = respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        result = await pool.pay_as("a", PaymentRequest(resource="r", amount="50", pay_to="0xabc"))
    assert result.success is False
    assert result.error_code == "TREASURY_EXCEEDED"
    assert verify.call_count == 0  # NO network call (pre-network block)


async def test_pay_as_success_records_spend():
    pool = _pool(shared_daily_limit_usd=100)
    pool.add_bot(PoolBotOptions(bot_id="a"))
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True, "txHash": "0xtx"})
        )
        result = await pool.pay_as("a", PaymentRequest(resource="r", amount="5", pay_to="0xabc"))
    assert result.success is True
    assert pool.remaining_treasury_usd() == 95
    assert pool.bot_stats("a").daily_tx_count == 1


async def test_pay_as_unbounded_no_gating():
    pool = _pool()  # no limit
    pool.add_bot(PoolBotOptions(bot_id="a"))
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        result = await pool.pay_as("a", PaymentRequest(resource="r", amount="999999", pay_to="0xabc"))
    assert result.success is True


async def test_pay_as_unknown_bot_raises():
    pool = _pool()
    with pytest.raises(ValueError, match="unknown bot"):
        await pool.pay_as("ghost", PaymentRequest(resource="r", amount="1", pay_to="0xabc"))


# ── _parse_amount_usd parity with JS parseFloat ────────────────────────────


def test_parse_amount_usd_numeric():
    assert _parse_amount_usd("5.5") == 5.5


def test_parse_amount_usd_leading_numeric_prefix():
    assert _parse_amount_usd("5abc") == 5.0


def test_parse_amount_usd_non_numeric_is_nan():
    assert math.isnan(_parse_amount_usd("abc"))


async def test_pay_as_non_numeric_amount_treated_zero_cost():
    """A non-numeric amount parses to NaN → zero-cost → always fits the treasury."""
    pool = _pool(shared_daily_limit_usd=0)  # zero budget
    pool.add_bot(PoolBotOptions(bot_id="a"))
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        # amount 'abc' → NaN → can_spend True even at zero budget.
        result = await pool.pay_as("a", PaymentRequest(resource="r", amount="abc", pay_to="0xabc"))
    assert result.success is True
