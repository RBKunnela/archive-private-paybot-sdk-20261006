"""Tests for the ASGI middleware + FastAPI dependency + static auth helpers.
Mirrors ``tests/middleware.test.ts`` + ``tests/auth.test.ts``.

The ASGI middleware is exercised directly via the ASGI protocol (no web framework
needed). Auth statics are respx-mocked.
"""
from __future__ import annotations

import json

import pytest
import respx
from httpx import Response

from paybot_sdk import (
    PayBotClient,
    Paybot402Config,
    Paybot402Middleware,
)
from paybot_sdk.errors import PayBotApiError
from paybot_sdk.middleware import _build_402_body


# ── ASGI harness ───────────────────────────────────────────────────────────


async def _run_asgi(middleware, headers):
    """Drive an ASGI app through one HTTP request; capture the response."""
    scope = {"type": "http", "method": "GET", "path": "/data", "headers": headers}
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    await middleware(scope, receive, send)
    return sent


async def _passthrough_app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"OK"})


# ── _build_402_body ────────────────────────────────────────────────────────


def test_build_402_body_shape():
    body = _build_402_body(Paybot402Config(pay_to="0xMerchant", amount="1000000"))
    assert body["x402Version"] == 1
    assert body["facilitatorUrl"] == "https://api.paybotcore.com"
    accept = body["accepts"][0]
    assert accept["scheme"] == "exact"
    assert accept["amount"] == "1000000"
    assert accept["payTo"] == "0xMerchant"
    assert accept["maxTimeoutSeconds"] == 300


def test_build_402_body_default_network_and_asset():
    body = _build_402_body(Paybot402Config(pay_to="0xM", amount="1"))
    accept = body["accepts"][0]
    assert accept["network"] == "eip155:84532"
    assert accept["asset"] == "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e"


def test_build_402_body_custom_asset():
    body = _build_402_body(
        Paybot402Config(pay_to="0xM", amount="1", asset="eip155:8453/erc20:0xCUSTOM")
    )
    assert body["accepts"][0]["asset"] == "eip155:8453/erc20:0xCUSTOM"


def test_build_402_body_mainnet_network():
    body = _build_402_body(Paybot402Config(pay_to="0xM", amount="1", network="eip155:8453"))
    accept = body["accepts"][0]
    assert accept["network"] == "eip155:8453"
    assert "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" in accept["asset"]


# ── ASGI middleware ────────────────────────────────────────────────────────


async def test_middleware_blocks_without_header():
    mw = Paybot402Middleware(_passthrough_app, Paybot402Config(pay_to="0xM", amount="1000000"))
    sent = await _run_asgi(mw, headers=[])
    assert sent[0]["status"] == 402
    body = json.loads(sent[1]["body"])
    assert body["x402Version"] == 1


async def test_middleware_blocks_with_empty_header():
    mw = Paybot402Middleware(_passthrough_app, Paybot402Config(pay_to="0xM", amount="1"))
    sent = await _run_asgi(mw, headers=[(b"x-payment-response", b"")])
    assert sent[0]["status"] == 402


async def test_middleware_passes_with_header():
    mw = Paybot402Middleware(_passthrough_app, Paybot402Config(pay_to="0xM", amount="1"))
    sent = await _run_asgi(mw, headers=[(b"x-payment-response", b"proof123")])
    assert sent[0]["status"] == 200
    assert sent[1]["body"] == b"OK"


async def test_middleware_sets_content_type_json():
    mw = Paybot402Middleware(_passthrough_app, Paybot402Config(pay_to="0xM", amount="1"))
    sent = await _run_asgi(mw, headers=[])
    header_map = dict(sent[0]["headers"])
    assert header_map[b"content-type"] == b"application/json"


async def test_middleware_passes_non_http_scope():
    captured = {}

    async def app(scope, receive, send):
        captured["type"] = scope["type"]

    mw = Paybot402Middleware(app, Paybot402Config(pay_to="0xM", amount="1"))
    await mw({"type": "lifespan"}, None, None)
    assert captured["type"] == "lifespan"


# ── FastAPI dependency (skipped if FastAPI absent) ─────────────────────────

fastapi = pytest.importorskip("fastapi", reason="FastAPI optional [web] extra not installed")


async def test_fastapi_dependency_blocks_without_header():
    from fastapi import HTTPException

    from paybot_sdk import paybot_402_dependency

    class FakeRequest:
        headers = {}

    dep = paybot_402_dependency(Paybot402Config(pay_to="0xM", amount="1"))
    with pytest.raises(HTTPException) as ei:
        await dep(FakeRequest())
    assert ei.value.status_code == 402
    assert ei.value.detail["x402Version"] == 1


async def test_fastapi_dependency_passes_with_header():
    from paybot_sdk import paybot_402_dependency

    class FakeRequest:
        headers = {"x-payment-response": "proof"}

    dep = paybot_402_dependency(Paybot402Config(pay_to="0xM", amount="1"))
    assert await dep(FakeRequest()) is None


# ── static auth: signup ────────────────────────────────────────────────────


async def test_signup_happy_path():
    base = "https://fac.example"
    with respx.mock:
        respx.post(f"{base}/auth/register").mock(
            return_value=Response(200, json={"operatorId": "op_1"})
        )
        respx.post(f"{base}/auth/login").mock(
            return_value=Response(200, json={"accessToken": "jwt_1"})
        )
        respx.post(f"{base}/api-keys").mock(
            return_value=Response(200, json={"key": "pb_live_xyz"})
        )
        respx.post(f"{base}/bots").mock(return_value=Response(200, json={"botId": "default"}))
        result = await PayBotClient.signup("a@b.com", "pw", facilitator_url=base)
    assert result.operator_id == "op_1"
    assert result.api_key == "pb_live_xyz"
    assert result.bot_id == "default"


async def test_signup_register_failure():
    base = "https://fac.example"
    with respx.mock:
        respx.post(f"{base}/auth/register").mock(
            return_value=Response(409, json={"error": "exists", "code": "OPERATOR_EXISTS"})
        )
        with pytest.raises(PayBotApiError) as ei:
            await PayBotClient.signup("a@b.com", "pw", facilitator_url=base)
    assert ei.value.code == "OPERATOR_EXISTS"


async def test_signup_login_failure():
    base = "https://fac.example"
    with respx.mock:
        respx.post(f"{base}/auth/register").mock(
            return_value=Response(200, json={"operatorId": "op_1"})
        )
        respx.post(f"{base}/auth/login").mock(return_value=Response(401, json={}))
        with pytest.raises(PayBotApiError) as ei:
            await PayBotClient.signup("a@b.com", "pw", facilitator_url=base)
    assert ei.value.code == "LOGIN_FAILED"


async def test_signup_key_creation_failure():
    base = "https://fac.example"
    with respx.mock:
        respx.post(f"{base}/auth/register").mock(
            return_value=Response(200, json={"operatorId": "op_1"})
        )
        respx.post(f"{base}/auth/login").mock(
            return_value=Response(200, json={"accessToken": "jwt_1"})
        )
        respx.post(f"{base}/api-keys").mock(return_value=Response(500, json={}))
        with pytest.raises(PayBotApiError) as ei:
            await PayBotClient.signup("a@b.com", "pw", facilitator_url=base)
    assert ei.value.code == "KEY_CREATION_FAILED"


async def test_signup_bot_registration_failure():
    base = "https://fac.example"
    with respx.mock:
        respx.post(f"{base}/auth/register").mock(
            return_value=Response(200, json={"operatorId": "op_1"})
        )
        respx.post(f"{base}/auth/login").mock(
            return_value=Response(200, json={"accessToken": "jwt_1"})
        )
        respx.post(f"{base}/api-keys").mock(
            return_value=Response(200, json={"key": "pb_live_xyz"})
        )
        respx.post(f"{base}/bots").mock(return_value=Response(409, json={"code": "BOT_EXISTS"}))
        with pytest.raises(PayBotApiError) as ei:
            await PayBotClient.signup("a@b.com", "pw", facilitator_url=base)
    assert ei.value.code == "BOT_EXISTS"


# ── static auth: login ─────────────────────────────────────────────────────


async def test_login_happy_path():
    base = "https://fac.example"
    with respx.mock:
        respx.post(f"{base}/auth/login").mock(
            return_value=Response(
                200,
                json={
                    "accessToken": "at", "refreshToken": "rt", "expiresIn": 3600,
                    "operator": {"id": "op_1", "email": "a@b.com", "tier": "free"},
                },
            )
        )
        result = await PayBotClient.login("a@b.com", "pw", facilitator_url=base)
    assert result.access_token == "at"
    assert result.refresh_token == "rt"
    assert result.expires_in == 3600
    assert result.operator.id == "op_1"


async def test_login_failure():
    base = "https://fac.example"
    with respx.mock:
        respx.post(f"{base}/auth/login").mock(
            return_value=Response(401, json={"error": "bad creds", "code": "LOGIN_FAILED"})
        )
        with pytest.raises(PayBotApiError) as ei:
            await PayBotClient.login("a@b.com", "pw", facilitator_url=base)
    assert ei.value.code == "LOGIN_FAILED"
