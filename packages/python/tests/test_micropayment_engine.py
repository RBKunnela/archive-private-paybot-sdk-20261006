"""Tests for the micropayment batching engine. Mirrors tests/micropayment-engine.test.ts.

Covers queueing, batch signing (address recovery), statistics, settlement
thresholds, gas estimate, and old-payment cleanup.
"""
from __future__ import annotations

import pytest

from paybot_sdk.micropayment_engine import MicropaymentEngine
from paybot_sdk.types import SettlementOptions

TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
RECIP_A = "0x000000000000000000000000000000000000aAaA"
RECIP_B = "0x000000000000000000000000000000000000bBbB"


def _engine(**kw) -> MicropaymentEngine:
    base = dict(wallet_private_key=TEST_KEY, min_payment_count=1000, min_total_usd=1000.0)
    base.update(kw)
    return MicropaymentEngine(**base)


# ── constructor ───────────────────────────────────────────────────────────


def test_constructor_rejects_non_0x_key():
    with pytest.raises(ValueError, match="0x"):
        MicropaymentEngine(wallet_private_key="abc")


def test_constructor_defaults():
    eng = MicropaymentEngine(wallet_private_key=TEST_KEY)
    stats = eng.get_queue_statistics()
    assert stats.total_payments == 0


# ── queue_payment ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_queue_payment_returns_id_and_records():
    eng = _engine()
    pid = await eng.queue_payment(RECIP_A, "0.001")
    assert pid.startswith("mp_")
    item = eng.get_payment_status(pid)
    assert item is not None
    assert item.amount_base_units == "1000"  # 0.001 * 1e6
    assert item.status == "queued"


@pytest.mark.asyncio
async def test_queue_payment_invalid_amount_raises():
    eng = _engine()
    with pytest.raises(ValueError, match="Invalid USD amount"):
        await eng.queue_payment(RECIP_A, "abc")


@pytest.mark.asyncio
async def test_queue_payment_rejects_sub_base_unit_precision():
    # CodeRabbit #7: amounts finer than USDC's 6 decimals were silently
    # truncated (underpay). They must now be rejected.
    eng = _engine()
    with pytest.raises(ValueError, match="precision"):
        await eng.queue_payment(RECIP_A, "0.0000009")  # 7 significant decimals


@pytest.mark.asyncio
async def test_queue_payment_allows_trailing_zero_padding():
    # Trailing zeros carry no value, so 6+ decimals that are all zeros past the
    # 6th place are still accepted (not a precision loss).
    eng = _engine()
    pid = await eng.queue_payment(RECIP_A, "0.0010000000")
    item = eng.get_payment_status(pid)
    assert item.amount_base_units == "1000"


@pytest.mark.asyncio
async def test_queue_payment_unknown_status_is_none():
    eng = _engine()
    assert eng.get_payment_status("mp_missing") is None


# ── statistics ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_statistics_aggregate():
    eng = _engine()
    await eng.queue_payment(RECIP_A, "0.10")
    await eng.queue_payment(RECIP_A, "0.20")
    await eng.queue_payment(RECIP_B, "0.30")
    stats = eng.get_queue_statistics()
    assert stats.total_payments == 3
    assert stats.unique_recipients == 2
    assert stats.queued_count == 3
    assert abs(stats.total_usd - 0.60) < 1e-9
    assert stats.payments_by_recipient[RECIP_A] == 2


@pytest.mark.asyncio
async def test_statistics_should_settle_threshold():
    # min_total_usd=0.5: queue past it and should_settle flips.
    eng = _engine(min_payment_count=1000, min_total_usd=0.5)
    await eng.queue_payment(RECIP_A, "0.10")
    assert eng.get_queue_statistics().should_settle is False
    await eng.queue_payment(RECIP_A, "0.50")
    assert eng.get_queue_statistics().should_settle is True


# ── batch_payments ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_payments_signs_and_recovers():
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from paybot_sdk.micropayment_engine import _BATCH_DOMAIN, _BATCH_TYPES

    eng = _engine()
    p1 = await eng.queue_payment(RECIP_A, "0.001")
    p2 = await eng.queue_payment(RECIP_B, "0.002")
    batch = await eng.batch_payments([p1, p2])

    assert batch.recipient_count == 2
    assert batch.signed_settlement["signature"].startswith("0x")
    # Mark settled status transition.
    assert eng.get_payment_status(p1).status == "pending"

    # Recover the batch signer.
    ss = batch.signed_settlement
    message = {
        "from": ss["from"],
        "nonce": ss["nonce"],
        "expiresAt": int(ss["expiresAt"]),
        "totalAmount": 1000 + 2000,
        "paymentCount": 2,
        "payments": [
            {"recipient": RECIP_A, "amount": 1000, "paymentId": p1},
            {"recipient": RECIP_B, "amount": 2000, "paymentId": p2},
        ],
    }
    encoded = encode_typed_data(_BATCH_DOMAIN, _BATCH_TYPES, message)
    recovered = Account.recover_message(encoded, signature=ss["signature"])
    assert recovered.lower() == Account.from_key(TEST_KEY).address.lower()


@pytest.mark.asyncio
async def test_batch_payments_unknown_ids_raises():
    # CodeRabbit #8: unknown ids must fail loudly, naming the missing id, not be
    # silently dropped.
    eng = _engine()
    with pytest.raises(ValueError, match="missing: mp_nope"):
        await eng.batch_payments(["mp_nope"])


@pytest.mark.asyncio
async def test_batch_payments_rejects_non_queued_ids():
    # CodeRabbit #8: an already-batched (pending) payment must not be silently
    # re-included in a second batch.
    eng = _engine()
    pid = await eng.queue_payment(RECIP_A, "0.001")
    await eng.batch_payments([pid])  # moves pid -> pending
    with pytest.raises(ValueError, match="not queued"):
        await eng.batch_payments([pid])


@pytest.mark.asyncio
async def test_batch_payments_gas_priced_from_batch_recipients():
    # CodeRabbit #9: gas is priced from the batch's own recipients, not the
    # whole queue. Queue many recipients but batch only one; the batch's
    # estimate must equal the single-recipient estimate, independent of the
    # other queued recipients.
    eng = _engine()
    target = await eng.queue_payment(RECIP_A, "0.001")
    for i in range(5):
        await eng.queue_payment(f"0x{i:040x}", "0.001")
    batch = await eng.batch_payments([target])
    expected = f"{eng._estimate_gas_cost(1, 1):.6f}"
    assert batch.gas_estimate_usd == expected


@pytest.mark.asyncio
async def test_batch_payments_skip_gas_estimate():
    eng = _engine()
    pid = await eng.queue_payment(RECIP_A, "0.001")
    batch = await eng.batch_payments([pid], SettlementOptions(skip_gas_estimate=True))
    assert batch.gas_estimate_usd == "0.000000"


# ── auto-settle on threshold ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_auto_settle_marks_pending_when_threshold_met():
    # threshold 1 payment → queueing one auto-settles it (status → pending).
    eng = _engine(min_payment_count=1, min_total_usd=1000.0)
    pid = await eng.queue_payment(RECIP_A, "0.001")
    assert eng.get_payment_status(pid).status == "pending"


def _seed_window(eng, window_key, recipient, amount_usd, n):
    """White-box helper: place ``n`` queued items into an explicit window."""
    from paybot_sdk.micropayment_engine import MicropaymentQueueItem, _now_ms, _usd_to_base_units

    items = []
    for i in range(n):
        items.append(
            MicropaymentQueueItem(
                payment_id=f"{window_key}_{i}",
                recipient=recipient,
                amount_usd=amount_usd,
                amount_base_units=_usd_to_base_units(amount_usd),
                queued_at=_now_ms(),
                status="queued",
                metadata=None,
            )
        )
    eng._queue.setdefault(window_key, []).extend(items)
    return items


@pytest.mark.asyncio
async def test_auto_settle_scoped_to_target_window_not_engine_wide():
    # CodeRabbit #10: a fresh sub-threshold window must NOT auto-settle just
    # because the engine-wide aggregate (other windows) is already over the
    # threshold. min_payment_count=3: window A holds 3 queued items (engine-wide
    # total already >= 3), then a single payment is queued into the current
    # wall-clock window B. B has only 1 item → must stay queued, and A (not the
    # target) must remain untouched.
    eng = _engine(min_payment_count=3, min_total_usd=1000.0)
    _seed_window(eng, "window_old_A", RECIP_B, "0.001", 3)

    pid_b = await eng.queue_payment(RECIP_A, "0.001")

    # The fresh window's lone payment did NOT settle on engine-wide totals.
    assert eng.get_payment_status(pid_b).status == "queued"
    # The accumulated window A was not the target → left untouched (still queued).
    for item in eng._queue["window_old_A"]:
        assert item.status == "queued"


@pytest.mark.asyncio
async def test_auto_settle_when_target_window_crosses_on_own_count():
    # CodeRabbit #10: a window DOES settle when ITS OWN queued items cross the
    # count threshold. min_payment_count=3 → the 3rd payment into the same
    # wall-clock window settles all three.
    eng = _engine(min_payment_count=3, min_total_usd=1000.0)
    p1 = await eng.queue_payment(RECIP_A, "0.001")
    p2 = await eng.queue_payment(RECIP_A, "0.001")
    assert eng.get_payment_status(p1).status == "queued"  # below threshold
    p3 = await eng.queue_payment(RECIP_A, "0.001")  # crosses count threshold
    for pid in (p1, p2, p3):
        assert eng.get_payment_status(pid).status == "pending"


@pytest.mark.asyncio
async def test_auto_settle_when_target_window_crosses_on_own_usd():
    # CodeRabbit #10: a window settles when its own queued USD sum crosses
    # min_total_usd, independent of count.
    eng = _engine(min_payment_count=1000, min_total_usd=0.5)
    p1 = await eng.queue_payment(RECIP_A, "0.3")
    assert eng.get_payment_status(p1).status == "queued"  # 0.3 < 0.5
    p2 = await eng.queue_payment(RECIP_A, "0.3")  # 0.6 >= 0.5 → settle window
    assert eng.get_payment_status(p1).status == "pending"
    assert eng.get_payment_status(p2).status == "pending"


# ── gas estimate + cleanup + window ──────────────────────────────────────


@pytest.mark.asyncio
async def test_get_gas_estimate_formatted():
    eng = _engine()
    await eng.queue_payment(RECIP_A, "0.001")
    est = eng.get_gas_estimate(1)
    assert "." in est  # 6-decimal formatted string


@pytest.mark.asyncio
async def test_clear_old_payments_only_settled():
    eng = _engine()
    pid = await eng.queue_payment(RECIP_A, "0.001")
    # queued (not settled) → not cleared even if "old".
    assert eng.clear_old_payments(0) == 0
    item = eng.get_payment_status(pid)
    item.status = "settled"
    item.queued_at = 0  # ancient
    assert eng.clear_old_payments(0) == 1


def test_set_batch_window():
    eng = _engine()
    eng.set_batch_window(30)
    assert eng._batch_window_ms == 30_000
