"""Tests for telemetry (with_span) + idempotency (LRU cache + X-Idempotency-Key).
Mirrors ``tests/telemetry.test.ts`` (~16) + ``tests/idempotency.test.ts`` (~12).

Telemetry tests use a hand-rolled fake tracer/span (no opentelemetry dep).
HTTP is respx-mocked.
"""
from __future__ import annotations

import pytest
import respx
from httpx import Response

from paybot_sdk import (
    PayBotClient,
    PayBotConfig,
    PaymentRequest,
    TelemetryConfig,
    with_span,
)
from paybot_sdk.client import _LruCache


# ── Fake tracer / span recorders ───────────────────────────────────────────


class FakeSpan:
    def __init__(self, name):
        self.name = name
        self.attributes = {}
        self.status = None
        self.exceptions = []
        self.ended = False

    def set_attribute(self, key, value):
        self.attributes[key] = value

    def set_status(self, status):
        self.status = status

    def record_exception(self, err):
        self.exceptions.append(err)

    def end(self):
        self.ended = True


class FakeTracer:
    def __init__(self):
        self.spans = []

    def start_span(self, name, options=None):
        span = FakeSpan(name)
        self.spans.append(span)
        return span


# ── with_span: no-op path ──────────────────────────────────────────────────


async def test_with_span_noop_runs_fn_directly():
    called = {}

    async def fn(span):
        called["span"] = span
        return "result"

    out = await with_span(None, "x", {"a": 1}, fn)
    assert out == "result"
    assert called["span"] is None  # no span allocated


async def test_with_span_noop_no_span_object():
    tracer = FakeTracer()

    async def fn(span):
        return 42

    await with_span(None, "x", {}, fn)
    assert tracer.spans == []  # tracer never touched


# ── with_span: configured path ─────────────────────────────────────────────


async def test_with_span_sets_prefix_and_attrs():
    tracer = FakeTracer()
    cfg = TelemetryConfig(tracer=tracer)

    async def fn(span):
        return "ok"

    out = await with_span(cfg, "client.pay", {"network": "eip155:8453"}, fn)
    assert out == "ok"
    assert len(tracer.spans) == 1
    span = tracer.spans[0]
    assert span.name == "paybot.client.pay"  # default prefix
    assert span.attributes["network"] == "eip155:8453"


async def test_with_span_custom_prefix():
    tracer = FakeTracer()
    cfg = TelemetryConfig(tracer=tracer, prefix="myapp.")

    async def fn(span):
        return None

    await with_span(cfg, "x402.sign", {}, fn)
    assert tracer.spans[0].name == "myapp.x402.sign"


async def test_with_span_ok_status_on_success():
    tracer = FakeTracer()
    cfg = TelemetryConfig(tracer=tracer)

    async def fn(span):
        return 1

    await with_span(cfg, "n", {}, fn)
    assert tracer.spans[0].status == {"code": 1}
    assert tracer.spans[0].ended is True


async def test_with_span_returned_failure_object_is_ok_span():
    """A returned 'failure' object (nothing raised) still marks the span OK."""
    tracer = FakeTracer()
    cfg = TelemetryConfig(tracer=tracer)

    async def fn(span):
        return {"success": False}

    await with_span(cfg, "n", {}, fn)
    assert tracer.spans[0].status == {"code": 1}  # OK, not ERROR


async def test_with_span_error_status_on_raise():
    tracer = FakeTracer()
    cfg = TelemetryConfig(tracer=tracer)

    async def fn(span):
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        await with_span(cfg, "n", {}, fn)
    span = tracer.spans[0]
    assert span.status["code"] == 2
    assert "boom" in span.status["message"]
    assert len(span.exceptions) == 1
    assert span.ended is True  # always ended


async def test_with_span_span_passed_to_fn():
    tracer = FakeTracer()
    cfg = TelemetryConfig(tracer=tracer)

    async def fn(span):
        span.set_attribute("late", "value")
        return None

    await with_span(cfg, "n", {}, fn)
    assert tracer.spans[0].attributes["late"] == "value"


async def test_with_span_always_ends_on_success():
    tracer = FakeTracer()
    cfg = TelemetryConfig(tracer=tracer)

    async def fn(span):
        return None

    await with_span(cfg, "n", {}, fn)
    assert tracer.spans[0].ended is True


# ── client.pay emits spans ─────────────────────────────────────────────────


async def test_pay_emits_span_tree():
    tracer = FakeTracer()
    client = PayBotClient(
        PayBotConfig(
            api_key="k", bot_id="b", facilitator_url="https://fac.example",
            telemetry=TelemetryConfig(tracer=tracer),
        )
    )
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True, "txHash": "0xtx"})
        )
        await client.pay(PaymentRequest(resource="r", amount="0.01", pay_to="0xabc"))
    names = {s.name for s in tracer.spans}
    assert "paybot.client.pay" in names
    assert "paybot.x402.sign" in names
    assert "paybot.x402.challenge" in names
    assert "paybot.x402.settle" in names
    await client.close()


async def test_pay_span_records_success_attribute():
    tracer = FakeTracer()
    client = PayBotClient(
        PayBotConfig(api_key="k", bot_id="b", facilitator_url="https://fac.example",
                     telemetry=TelemetryConfig(tracer=tracer))
    )
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True, "txHash": "0xtx"})
        )
        await client.pay(PaymentRequest(resource="r", amount="0.01", pay_to="0xabc"))
    pay_span = next(s for s in tracer.spans if s.name == "paybot.client.pay")
    assert pay_span.attributes.get("success") is True
    assert pay_span.attributes.get("tx_hash") == "0xtx"
    await client.close()


async def test_pay_without_telemetry_is_noop():
    client = PayBotClient(
        PayBotConfig(api_key="k", bot_id="b", facilitator_url="https://fac.example")
    )
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        result = await client.pay(PaymentRequest(resource="r", amount="0.01", pay_to="0xabc"))
    assert result.success is True
    await client.close()


# ── _LruCache ──────────────────────────────────────────────────────────────


def test_lru_get_miss_returns_none():
    c = _LruCache(2)
    assert c.get("x") is None


def test_lru_set_then_get():
    c = _LruCache(2)
    c.set("a", 1)
    assert c.get("a") == 1
    assert c.size == 1


def test_lru_evicts_oldest_at_capacity():
    c = _LruCache(2)
    c.set("a", 1)
    c.set("b", 2)
    c.set("c", 3)  # evicts 'a'
    assert c.get("a") is None
    assert c.get("b") == 2
    assert c.get("c") == 3
    assert c.size == 2


def test_lru_get_refreshes_recency():
    c = _LruCache(2)
    c.set("a", 1)
    c.set("b", 2)
    c.get("a")  # 'a' now most-recently-used
    c.set("c", 3)  # should evict 'b', not 'a'
    assert c.get("a") == 1
    assert c.get("b") is None


def test_lru_update_in_place_refreshes_recency():
    c = _LruCache(2)
    c.set("a", 1)
    c.set("b", 2)
    c.set("a", 11)  # update + refresh recency
    c.set("c", 3)  # evicts 'b'
    assert c.get("a") == 11
    assert c.get("b") is None


# ── pay() idempotency ──────────────────────────────────────────────────────


async def test_pay_idempotency_caches_success_and_skips_network():
    client = PayBotClient(
        PayBotConfig(api_key="k", bot_id="b", facilitator_url="https://fac.example")
    )
    with respx.mock:
        verify = respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        settle = respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True, "txHash": "0xtx"})
        )
        req = PaymentRequest(resource="r", amount="0.01", pay_to="0xabc",
                             idempotency_key="key-1")
        first = await client.pay(req)
        second = await client.pay(req)  # served from cache
    assert first.success and second.success
    assert verify.call_count == 1  # only one network round-trip
    assert settle.call_count == 1
    assert second is first  # same cached object
    await client.close()


async def test_pay_idempotency_sends_header():
    client = PayBotClient(
        PayBotConfig(api_key="k", bot_id="b", facilitator_url="https://fac.example")
    )
    with respx.mock:
        verify = respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        await client.pay(
            PaymentRequest(resource="r", amount="0.01", pay_to="0xabc",
                           idempotency_key="key-x")
        )
    assert verify.calls.last.request.headers["X-Idempotency-Key"] == "key-x"
    await client.close()


async def test_pay_idempotency_does_not_cache_failure():
    client = PayBotClient(
        PayBotConfig(api_key="k", bot_id="b", facilitator_url="https://fac.example")
    )
    with respx.mock:
        verify = respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": False, "error": "nope"})
        )
        req = PaymentRequest(resource="r", amount="0.01", pay_to="0xabc",
                             idempotency_key="key-fail")
        first = await client.pay(req)
        await client.pay(req)  # not cached → second network call
    assert first.success is False
    assert verify.call_count == 2  # failure NOT cached, so retried
    await client.close()


async def test_pay_no_idempotency_key_always_hits_network():
    client = PayBotClient(
        PayBotConfig(api_key="k", bot_id="b", facilitator_url="https://fac.example")
    )
    with respx.mock:
        verify = respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        req = PaymentRequest(resource="r", amount="0.01", pay_to="0xabc")
        await client.pay(req)
        await client.pay(req)
    assert verify.call_count == 2
    await client.close()


# ── register() idempotency ─────────────────────────────────────────────────


async def test_register_idempotency_caches_and_skips_network():
    client = PayBotClient(
        PayBotConfig(api_key="k", bot_id="b", facilitator_url="https://fac.example")
    )
    with respx.mock:
        bots = respx.post("https://fac.example/bots").mock(
            return_value=Response(200, json={"success": True, "botId": "b", "trustLevel": 1})
        )
        first = await client.register(idempotency_key="reg-1")
        second = await client.register(idempotency_key="reg-1")
    assert bots.call_count == 1
    assert second is first
    await client.close()


async def test_register_idempotency_sends_header():
    client = PayBotClient(
        PayBotConfig(api_key="k", bot_id="b", facilitator_url="https://fac.example")
    )
    with respx.mock:
        bots = respx.post("https://fac.example/bots").mock(
            return_value=Response(200, json={"success": True, "botId": "b", "trustLevel": 1})
        )
        await client.register(idempotency_key="reg-x")
    assert bots.calls.last.request.headers["X-Idempotency-Key"] == "reg-x"
    await client.close()
