"""Tests for the multi-bot client pool. Mirrors tests/client-pool.test.ts.

Covers add/get/remove bots, per-bot signing isolation, the shared treasury
(TREASURY_EXCEEDED pre-network block), per-bot accounting, and pay_as.
"""
from __future__ import annotations


import pytest
import respx
from httpx import Response

from paybot_sdk import PaymentRequest
from paybot_sdk.client_pool import (
    PayBotClientPool,
    PayBotClientPoolConfig,
    PoolBotOptions,
)

KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
PAY_TO = "0x0000000000000000000000000000000000000001"


def _pool(**kw) -> PayBotClientPool:
    base = dict(api_key="pb_test", facilitator_url="https://fac.example")
    base.update(kw)
    return PayBotClientPool(PayBotClientPoolConfig(**base))


def _req(amount: str) -> PaymentRequest:
    return PaymentRequest(resource="https://x.example/y", amount=amount, pay_to=PAY_TO, network="eip155:84532")


# ── constructor validation ───────────────────────────────────────────────


def test_constructor_requires_api_key():
    with pytest.raises(ValueError, match="api_key"):
        PayBotClientPool(PayBotClientPoolConfig(api_key=""))


def test_constructor_rejects_bad_shared_limit():
    with pytest.raises(ValueError, match="shared_daily_limit_usd"):
        PayBotClientPool(PayBotClientPoolConfig(api_key="pb", shared_daily_limit_usd=-1))


def test_constructor_accepts_no_limit():
    pool = _pool()
    assert pool.remaining_treasury_usd() is None


# ── add/get/remove/has ────────────────────────────────────────────────────


def test_add_and_get_bot():
    pool = _pool()
    client = pool.add_bot(PoolBotOptions(bot_id="bot-a", wallet_private_key=KEY_A))
    assert pool.get_bot("bot-a") is client
    assert pool.has_bot("bot-a")
    assert pool.size == 1
    assert pool.bot_ids() == ["bot-a"]


def test_add_duplicate_raises():
    pool = _pool()
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    with pytest.raises(ValueError, match="already added"):
        pool.add_bot(PoolBotOptions(bot_id="bot-a"))


def test_get_unknown_raises():
    pool = _pool()
    with pytest.raises(ValueError, match="unknown bot"):
        pool.get_bot("nope")


def test_remove_bot():
    pool = _pool()
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    # CodeRabbit #2: sync remove_bot leaks the client and warns about it.
    with pytest.warns(ResourceWarning, match="aclose_bot"):
        assert pool.remove_bot("bot-a") is True
    assert pool.remove_bot("bot-a") is False  # absent → no warning, False
    assert not pool.has_bot("bot-a")


@pytest.mark.asyncio
async def test_aclose_bot_closes_client_and_removes():
    # CodeRabbit #2: aclose_bot closes the bot's httpx client (no leak).
    pool = _pool()
    client = pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    assert client.is_closed is False
    assert await pool.aclose_bot("bot-a") is True
    assert client.is_closed is True
    assert not pool.has_bot("bot-a")
    assert await pool.aclose_bot("bot-a") is False  # already gone


@pytest.mark.asyncio
async def test_aclose_closes_all_clients():
    pool = _pool()
    a = pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    b = pool.add_bot(PoolBotOptions(bot_id="bot-b"))
    await pool.aclose()
    assert a.is_closed and b.is_closed
    assert pool.size == 0
    await pool.aclose()  # idempotent


def test_per_bot_signing_isolation():
    # Each bot's client carries its own wallet key (no cross-signing).
    pool = _pool()
    a = pool.add_bot(PoolBotOptions(bot_id="bot-a", wallet_private_key=KEY_A))
    b = pool.add_bot(PoolBotOptions(bot_id="bot-b", wallet_private_key=KEY_B))
    assert a._wallet_private_key == KEY_A
    assert b._wallet_private_key == KEY_B


# ── treasury accounting ───────────────────────────────────────────────────


def test_record_spend_and_remaining():
    pool = _pool(shared_daily_limit_usd=100.0)
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    pool.record_spend("bot-a", 30.0)
    assert pool.remaining_treasury_usd() == 70.0
    assert pool.bot_stats("bot-a").daily_spent_usd == 30.0
    assert pool.bot_stats("bot-a").daily_tx_count == 1


def test_record_spend_ignores_negative_and_nonfinite():
    pool = _pool(shared_daily_limit_usd=100.0)
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    pool.record_spend("bot-a", -5.0)
    pool.record_spend("bot-a", float("nan"))
    assert pool.remaining_treasury_usd() == 100.0


def test_can_spend_unbounded_when_no_limit():
    pool = _pool()
    assert pool.can_spend(1_000_000.0) is True


def test_can_spend_respects_limit():
    pool = _pool(shared_daily_limit_usd=50.0)
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    pool.record_spend("bot-a", 40.0)
    assert pool.can_spend(10.0) is True
    assert pool.can_spend(10.01) is False


def test_bot_stats_unknown_raises():
    pool = _pool(shared_daily_limit_usd=50.0)
    with pytest.raises(ValueError, match="unknown bot"):
        pool.bot_stats("nope")


# ── pay_as ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_pay_as_treasury_exceeded_blocks_before_network():
    pool = _pool(shared_daily_limit_usd=10.0)
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    with respx.mock:
        verify = respx.post("https://fac.example/verify")
        result = await pool.pay_as("bot-a", _req("50"))
    assert result.success is False
    assert result.error_code == "TREASURY_EXCEEDED"
    assert not verify.called  # pre-network block


@pytest.mark.parametrize("bad_amount", ["nan", "inf", "-inf", "abc", "-5"])
@pytest.mark.asyncio
async def test_pay_as_rejects_non_finite_amount_before_treasury(bad_amount):
    # CodeRabbit #3: nan/inf/unparseable/negative amounts were coerced to
    # zero-cost and sailed past the treasury without ever being debited. They
    # must be rejected before any treasury math AND before any network call.
    pool = _pool(shared_daily_limit_usd=10.0)
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    with respx.mock:
        verify = respx.post("https://fac.example/verify")
        result = await pool.pay_as("bot-a", _req(bad_amount))
    assert result.success is False
    assert result.error_code == "INVALID_AMOUNT"
    assert not verify.called  # rejected pre-network
    assert pool.remaining_treasury_usd() == 10.0  # treasury untouched


@pytest.mark.asyncio
async def test_pay_as_rejects_non_finite_amount_even_when_unbounded():
    # Even with no shared limit, a non-finite amount is invalid input.
    pool = _pool()
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    with respx.mock:
        verify = respx.post("https://fac.example/verify")
        result = await pool.pay_as("bot-a", _req("inf"))
    assert result.error_code == "INVALID_AMOUNT"
    assert not verify.called


@pytest.mark.asyncio
async def test_pay_as_records_spend_on_success():
    pool = _pool(shared_daily_limit_usd=100.0)
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "st"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True, "txHash": "0x1"})
        )
        result = await pool.pay_as("bot-a", _req("5"))
    assert result.success is True
    assert pool.remaining_treasury_usd() == 95.0
    assert pool.bot_stats("bot-a").daily_tx_count == 1


@pytest.mark.asyncio
async def test_pay_as_does_not_record_on_failure():
    pool = _pool(shared_daily_limit_usd=100.0)
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(403, json={"error": "trust", "code": "TRUST_VIOLATION"})
        )
        result = await pool.pay_as("bot-a", _req("5"))
    assert result.success is False
    # Failed pay → treasury unchanged.
    assert pool.remaining_treasury_usd() == 100.0


@pytest.mark.asyncio
async def test_pay_as_unbounded_treasury_allows_any():
    pool = _pool()  # no shared limit
    pool.add_bot(PoolBotOptions(bot_id="bot-a"))
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "st"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        result = await pool.pay_as("bot-a", _req("999999"))
    assert result.success is True


@pytest.mark.asyncio
async def test_pay_as_unknown_bot_raises():
    pool = _pool()
    with pytest.raises(ValueError, match="unknown bot"):
        await pool.pay_as("nope", _req("1"))


# ── treasury concurrency (CodeRabbit #4) ──────────────────────────────────


def _ok_result() -> "object":
    from paybot_sdk.types import PaymentResult

    return PaymentResult(
        success=True,
        gross_amount="0",
        net_amount="0",
        commission_amount="0",
        commission_rate=0,
    )


@pytest.mark.asyncio
async def test_pay_as_concurrent_never_overruns_limit():
    import asyncio

    # Limit admits exactly 5 of 10 concurrent $10 spends. Each stubbed pay()
    # yields control (await asyncio.sleep(0)) so all coroutines interleave
    # between the limit check and the spend record — the exact window the lock
    # must close. Without reserve-under-lock, every caller would pass can_spend()
    # and the treasury would overrun.
    pool = _pool(shared_daily_limit_usd=50.0)
    client = pool.add_bot(PoolBotOptions(bot_id="bot-a"))

    async def fake_pay(_request):
        await asyncio.sleep(0)  # yield point inside the "network" call
        return _ok_result()

    client.pay = fake_pay  # type: ignore[assignment]

    results = await asyncio.gather(*[pool.pay_as("bot-a", _req("10")) for _ in range(10)])

    successes = [r for r in results if r.success]
    rejections = [r for r in results if not r.success]
    assert len(successes) == 5
    assert all(r.error_code == "TREASURY_EXCEEDED" for r in rejections)
    # Treasury never exceeded the cap.
    assert pool.remaining_treasury_usd() == 0.0
    assert pool.bot_stats("bot-a").daily_tx_count == 5


@pytest.mark.asyncio
async def test_pay_as_refunds_reservation_on_exception():
    import asyncio

    # An exception from pay() must refund the reservation under lock so the
    # treasury is not permanently debited for a payment that never happened.
    pool = _pool(shared_daily_limit_usd=100.0)
    client = pool.add_bot(PoolBotOptions(bot_id="bot-a"))

    async def boom(_request):
        await asyncio.sleep(0)
        raise RuntimeError("network exploded")

    client.pay = boom  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="network exploded"):
        await pool.pay_as("bot-a", _req("30"))
    assert pool.remaining_treasury_usd() == 100.0  # reservation refunded
