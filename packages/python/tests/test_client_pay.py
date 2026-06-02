"""Tests for PayBotClient.pay() multi-token + contract-change behavior.

Covers the observable contract change flagged by the architect: an unknown token
now returns ``UNSUPPORTED_TOKEN`` (not ``UNSUPPORTED_NETWORK``), and pay() never
throws even when the signing domain cannot be resolved.
"""
from __future__ import annotations

import json

import httpx
import pytest
import respx
from httpx import Response

from paybot_sdk import PayBotClient, PayBotConfig, PaymentRequest, TelemetryConfig
from paybot_sdk.errors import PayBotApiError

PK = "0x" + "1" * 64


def _client(**over):
    cfg = dict(api_key="k", bot_id="b", facilitator_url="https://fac.example")
    cfg.update(over)
    return PayBotClient(PayBotConfig(**cfg))


class _RecordingSpan:
    def __init__(self, name):
        self.name = name
        self.attributes = {}

    def set_attribute(self, key, value):
        self.attributes[key] = value

    def set_status(self, status):
        pass

    def record_exception(self, err):
        pass

    def end(self):
        pass


class _RecordingTracer:
    def __init__(self):
        self.spans = []

    def start_span(self, name, options=None):
        span = _RecordingSpan(name)
        self.spans.append(span)
        return span


async def test_pay_unknown_token_returns_unsupported_token():
    """Unknown token → UNSUPPORTED_TOKEN failure result. Telemetry wired so the
    pay_span.set_attribute branch (client.py:389) is exercised."""
    tracer = _RecordingTracer()
    client = _client(telemetry=TelemetryConfig(tracer=tracer))
    result = await client.pay(
        PaymentRequest(resource="r", amount="1", pay_to="0xabc", token="DOGE")
    )
    assert result.success is False
    assert result.error_code == "UNSUPPORTED_TOKEN"  # NOT UNSUPPORTED_NETWORK
    pay_span = next(s for s in tracer.spans if s.name == "paybot.client.pay")
    assert pay_span.attributes.get("success") is False
    await client.close()


async def test_pay_real_mode_eurc_signs_under_own_domain():
    """EURC real-mode pay() resolves the EURC domain and runs verify→settle."""
    client = _client(wallet_private_key=PK)
    with respx.mock:
        verify = respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True, "txHash": "0xtx"})
        )
        result = await client.pay(
            PaymentRequest(
                resource="r", amount="0.01",
                pay_to="0x000000000000000000000000000000000000dEaD",
                token="EURC", network="eip155:8453",
            )
        )
    assert result.success is True
    # Asset must reference the EURC contract, not USDC.
    body = json.loads(verify.calls.last.request.content)
    assert "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" in body["requirements"]["asset"]
    await client.close()


async def test_pay_real_mode_eurc_unsupported_network_never_throws():
    """A signing-domain failure (EURC on a bad network) becomes a failure result,
    not a raised exception — pay() never throws (outer except, client.py:555-565).
    Telemetry is wired so the pay_span.set_attribute branch (line 557) is run."""
    tracer = _RecordingTracer()
    client = _client(wallet_private_key=PK, telemetry=TelemetryConfig(tracer=tracer))
    # eip155:1 has no EURC domain → _sign_payload raises ValueError internally,
    # which pay() converts to a failure result.
    result = await client.pay(
        PaymentRequest(resource="r", amount="0.01", pay_to="0xabc",
                       token="EURC", network="eip155:1")
    )
    assert result.success is False
    assert result.error  # carries the error message
    pay_span = next(s for s in tracer.spans if s.name == "paybot.client.pay")
    assert pay_span.attributes.get("success") is False
    await client.close()


async def test_pay_mock_mode_default_usdc_unchanged():
    """Default (no token) mock-mode pay() still works on USDC base sepolia."""
    client = _client()
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        result = await client.pay(PaymentRequest(resource="r", amount="0.05", pay_to="0xabc"))
    assert result.success is True
    await client.close()


async def test_pay_uses_token_decimals():
    """Token decimals (6) drive base-unit conversion."""
    client = _client()
    with respx.mock:
        verify = respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        await client.pay(PaymentRequest(resource="r", amount="1", pay_to="0xabc"))
    body = json.loads(verify.calls.last.request.content)
    assert body["requirements"]["amount"] == "1000000"  # 1 USDC * 10^6
    await client.close()


async def test_pay_explicit_token_contract_overrides():
    client = _client()
    with respx.mock:
        verify = respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        await client.pay(
            PaymentRequest(resource="r", amount="1", pay_to="0xabc",
                           token_contract="0xCUSTOMCONTRACT")
        )
    body = json.loads(verify.calls.last.request.content)
    assert "0xCUSTOMCONTRACT" in body["requirements"]["asset"]
    await client.close()


# ── pay() error-path branches (never throws; client.py:467-470/482-485/515-518) ──


async def test_pay_challenge_error_returns_failure_result():
    """A PayBotApiError from the /verify (challenge) step becomes a failure
    PaymentResult — pay() never throws (client.py:467-470). Telemetry is wired so
    the pay_span.set_attribute('success', False) branch (line 469) is exercised."""
    tracer = _RecordingTracer()
    client = _client(telemetry=TelemetryConfig(tracer=tracer))
    with respx.mock:
        verify = respx.post("https://fac.example/verify").mock(
            return_value=Response(403, json={"error": "trust violation",
                                             "code": "TRUST_VIOLATION",
                                             "details": {"limit": "0"}})
        )
        settle = respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        result = await client.pay(PaymentRequest(resource="r", amount="0.01", pay_to="0xabc"))
    assert verify.called
    assert settle.call_count == 0  # never reached settle after challenge failure
    assert result.success is False
    assert result.error_code == "TRUST_VIOLATION"
    assert result.error == "trust violation"
    assert result.error_details == {"limit": "0"}
    pay_span = next(s for s in tracer.spans if s.name == "paybot.client.pay")
    assert pay_span.attributes.get("success") is False
    await client.close()


async def test_pay_missing_settlement_token_returns_no_settlement_token():
    """A 2xx verify response without a settlementToken short-circuits to
    NO_SETTLEMENT_TOKEN and makes no /settle call (client.py:482-485). Telemetry
    is wired so the pay_span.set_attribute branch (line 484) is exercised."""
    tracer = _RecordingTracer()
    client = _client(telemetry=TelemetryConfig(tracer=tracer))
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"commission": {"grossAmount": "0"}})
        )
        settle = respx.post("https://fac.example/settle").mock(
            return_value=Response(200, json={"success": True})
        )
        result = await client.pay(PaymentRequest(resource="r", amount="0.01", pay_to="0xabc"))
    assert settle.call_count == 0  # never reached settle
    assert result.success is False
    assert result.error_code == "NO_SETTLEMENT_TOKEN"
    assert "settlementToken" in result.error
    pay_span = next(s for s in tracer.spans if s.name == "paybot.client.pay")
    assert pay_span.attributes.get("success") is False
    await client.close()


async def test_pay_settle_error_returns_failure_result():
    """A PayBotApiError from the /settle step becomes a failure PaymentResult —
    pay() never throws (client.py:515-518). A 4xx is used so the server-provided
    error/code propagate (5xx is retried + collapsed to a generic HTTP_ERROR).
    Telemetry is wired so the pay_span.set_attribute branch (line 517) runs."""
    tracer = _RecordingTracer()
    client = _client(telemetry=TelemetryConfig(tracer=tracer))
    with respx.mock:
        respx.post("https://fac.example/verify").mock(
            return_value=Response(200, json={"settlementToken": "stok"})
        )
        settle = respx.post("https://fac.example/settle").mock(
            return_value=Response(403, json={"error": "settlement rejected",
                                             "code": "SETTLEMENT_REJECTED"})
        )
        result = await client.pay(PaymentRequest(resource="r", amount="0.01", pay_to="0xabc"))
    assert settle.called
    assert result.success is False
    assert result.error_code == "SETTLEMENT_REJECTED"
    assert result.error == "settlement rejected"
    pay_span = next(s for s in tracer.spans if s.name == "paybot.client.pay")
    assert pay_span.attributes.get("success") is False
    await client.close()


# ── _request error/retry paths (exercised via public mock-mode methods that the
#    new idempotency/auth code all depend on; client.py:_request). Uses health()
#    and balance() — NOT in the out-of-scope exclusion list. ──────────────────


async def test_request_4xx_raises_paybot_api_error():
    """A 4xx surfaces the server error/code/details and is NOT retried."""
    client = _client()
    with respx.mock:
        route = respx.get("https://fac.example/health").mock(
            return_value=Response(404, json={"error": "missing", "code": "NOT_FOUND",
                                             "details": {"path": "/health"}})
        )
        with pytest.raises(PayBotApiError) as ei:
            await client.health()
    assert route.call_count == 1  # 4xx is not retried
    assert ei.value.code == "NOT_FOUND"
    assert ei.value.status_code == 404
    assert ei.value.details == {"path": "/health"}
    await client.close()


async def test_request_5xx_retries_then_raises():
    """A 5xx is retried up to max_retries, then collapses to a generic HTTP_ERROR."""
    client = _client(max_retries=1)
    with respx.mock:
        route = respx.get("https://fac.example/health").mock(return_value=Response(503))
        with pytest.raises(PayBotApiError) as ei:
            await client.health()
    assert route.call_count == 2  # initial + 1 retry
    assert ei.value.code == "HTTP_ERROR"
    assert ei.value.status_code == 503
    await client.close()


async def test_request_network_error_raises_network_error():
    """A transport error (after retries exhausted) surfaces as NETWORK_ERROR."""
    client = _client(max_retries=0)
    with respx.mock:
        respx.get("https://fac.example/health").mock(
            side_effect=httpx.ConnectError("refused")
        )
        with pytest.raises(PayBotApiError) as ei:
            await client.health()
    assert ei.value.code == "NETWORK_ERROR"
    assert ei.value.status_code == 0
    await client.close()


async def test_request_invalid_json_in_2xx_raises():
    """A 2xx body that is not valid JSON surfaces as INVALID_RESPONSE."""
    client = _client()
    with respx.mock:
        respx.get("https://fac.example/health").mock(
            return_value=Response(200, content=b"not json", headers={"content-type": "application/json"})
        )
        with pytest.raises(PayBotApiError) as ei:
            await client.health()
    assert ei.value.code == "INVALID_RESPONSE"
    await client.close()


async def test_request_query_string_appended():
    """The query path of _request (line 202) is exercised via balance()."""
    client = _client()
    with respx.mock:
        route = respx.get("https://fac.example/balance").mock(
            return_value=Response(
                200,
                json={"botId": "b", "trustLevel": 1, "trustLevelName": "low",
                      "dailySpentUsd": 0, "dailyLimitUsd": 10, "dailyRemainingUsd": 10,
                      "hourlyTransactions": 0, "hourlyLimit": 5},
            )
        )
        result = await client.balance()
    assert "botId=b" in str(route.calls.last.request.url)
    assert result.bot_id == "b"
    await client.close()
