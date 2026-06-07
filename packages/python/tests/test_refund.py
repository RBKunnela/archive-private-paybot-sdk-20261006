"""Tests for PayBotClient.refund(). The wrapper must NEVER raise — failures
surface as RefundResult(success=False, ...).
"""
from __future__ import annotations

import json

import pytest
import respx
from httpx import Response

from paybot_sdk import PayBotClient, PayBotConfig
from paybot_sdk.types import RefundResult


def _client(**kw) -> PayBotClient:
    base = dict(api_key="pb_test", bot_id="bot-1", facilitator_url="https://fac.example")
    base.update(kw)
    return PayBotClient(PayBotConfig(**base))


# ── happy path ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_refund_success():
    client = _client()
    with respx.mock:
        route = respx.post("https://fac.example/refund").mock(
            return_value=Response(
                200,
                json={
                    "success": True,
                    "refundId": "rf_1",
                    "txHash": "0xrefund",
                    "amount": "0.05",
                    "status": "pending",
                },
            )
        )
        result = await client.refund(tx_hash="0xpaid", amount="0.05", reason="customer request")
    assert isinstance(result, RefundResult)
    assert result.success is True
    assert result.refund_id == "rf_1"
    assert result.status == "pending"
    # Body carries botId + txHash + amount + reason.
    body = json.loads(route.calls.last.request.content)
    assert body["botId"] == "bot-1"
    assert body["txHash"] == "0xpaid"
    assert body["amount"] == "0.05"
    assert body["reason"] == "customer request"
    await client.close()


@pytest.mark.asyncio
async def test_refund_minimal_body_only_required():
    client = _client()
    with respx.mock:
        route = respx.post("https://fac.example/refund").mock(
            return_value=Response(200, json={"success": True, "refundId": "rf_2"})
        )
        result = await client.refund(tx_hash="0xpaid")
    body = json.loads(route.calls.last.request.content)
    assert body == {"botId": "bot-1", "txHash": "0xpaid"}
    assert result.success is True
    # tx_hash falls back to the requested one when server omits it.
    assert result.tx_hash == "0xpaid"
    await client.close()


# ── error path: never raises ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_refund_4xx_does_not_raise():
    client = _client()
    with respx.mock:
        respx.post("https://fac.example/refund").mock(
            return_value=Response(404, json={"error": "not found", "code": "NOT_FOUND"})
        )
        result = await client.refund(tx_hash="0xmissing")
    assert result.success is False
    assert result.error_code == "NOT_FOUND"
    assert "not found" in result.error
    await client.close()


@pytest.mark.asyncio
async def test_refund_transport_error_does_not_raise():
    client = _client(max_retries=0)
    with respx.mock:
        import httpx

        respx.post("https://fac.example/refund").mock(side_effect=httpx.ConnectError("down"))
        result = await client.refund(tx_hash="0xpaid")
    assert result.success is False
    # _request maps transport failures to a NETWORK_ERROR PayBotApiError.
    assert result.error_code == "NETWORK_ERROR"
    await client.close()


# ── edge: server reports success=False ───────────────────────────────────


@pytest.mark.asyncio
async def test_refund_server_reports_failure_payload():
    client = _client()
    with respx.mock:
        respx.post("https://fac.example/refund").mock(
            return_value=Response(
                200,
                json={"success": False, "errorCode": "ALREADY_REFUNDED", "error": "dup"},
            )
        )
        result = await client.refund(tx_hash="0xpaid")
    assert result.success is False
    assert result.error_code == "ALREADY_REFUNDED"
    await client.close()
