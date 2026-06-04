"""x402 payment-wall middleware. Mirrors ``src/middleware.ts``.

The TS SDK exports one Connect/Express/Fastify middleware ``paybot402(config)``.
There is no single universal Python web-middleware contract, so this maps to two
idiomatic Python entry points sharing one core:

- :class:`Paybot402Middleware` — a framework-agnostic raw-ASGI middleware
  (Starlette / FastAPI / any ASGI app), needs no third-party import.
- :func:`paybot_402_dependency` — an ergonomic FastAPI dependency for per-route
  gating. FastAPI is lazy-imported (optional ``web`` extra); a clear
  ``ImportError`` with an install hint is raised if missing.

Both reproduce the TS behavior: a request WITHOUT a non-empty
``x-payment-response`` header gets HTTP 402 with the x402 requirements JSON;
WITH the header, the request passes through to the real handler.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Optional

from .networks import NETWORKS

#: USDC on Base Sepolia — the fallback verifying contract (middleware.ts:91).
_FALLBACK_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"


@dataclass
class Paybot402Config:
    """Configuration for the paybot402 middleware (middleware.ts:23-42).

    :param pay_to: Merchant wallet address to receive payment.
    :param amount: Payment amount in USDC base units (6 decimals), e.g. ``"1000000"``.
    :param facilitator_url: PayBot facilitator URL (default ``https://api.paybotcore.com``).
    :param network: CAIP-2 network id (default ``eip155:84532`` Base Sepolia).
    :param asset: Full CAIP-19 asset id. Defaults to USDC on the chosen network.
    :param max_timeout_seconds: Max seconds a payment proof is valid (default 300).
    """

    pay_to: str
    amount: str
    facilitator_url: Optional[str] = None
    network: Optional[str] = None
    asset: Optional[str] = None
    max_timeout_seconds: Optional[int] = None


def _build_402_body(config: Paybot402Config) -> Dict[str, Any]:
    """Build the x402 402 response body dict (middleware.ts:96-109).

    :returns: ``{"x402Version": 1, "accepts": [...], "facilitatorUrl": ...}``.
    """
    network = config.network or "eip155:84532"
    network_config = NETWORKS.get(network)
    usdc_address = network_config.usdc_address if network_config else _FALLBACK_USDC
    asset = config.asset or f"{network}/erc20:{usdc_address}"
    facilitator_url = config.facilitator_url or "https://api.paybotcore.com"
    max_timeout_seconds = (
        config.max_timeout_seconds if config.max_timeout_seconds is not None else 300
    )
    return {
        "x402Version": 1,
        "accepts": [
            {
                "scheme": "exact",
                "network": network,
                "asset": asset,
                "amount": config.amount,
                "payTo": config.pay_to,
                "maxTimeoutSeconds": max_timeout_seconds,
            }
        ],
        "facilitatorUrl": facilitator_url,
    }


class Paybot402Middleware:
    """Framework-agnostic ASGI x402 payment-wall middleware.

    Wrap any ASGI app::

        app.add_middleware(Paybot402Middleware, config=Paybot402Config(pay_to="0x...", amount="1000000"))

    A request without a non-empty ``x-payment-response`` header is short-circuited
    with a 402 JSON response; otherwise it passes through to the wrapped app.
    """

    def __init__(self, app: Any, config: Paybot402Config) -> None:
        """:param app: The downstream ASGI application. :param config: Wall config."""
        self._app = app
        self._config = config
        self._body_bytes = json.dumps(_build_402_body(config)).encode("utf-8")

    async def __call__(
        self,
        scope: Dict[str, Any],
        receive: Callable[[], Awaitable[Dict[str, Any]]],
        send: Callable[[Dict[str, Any]], Awaitable[None]],
    ) -> None:
        """ASGI entry point. Gates HTTP requests behind the payment wall."""
        if scope.get("type") != "http":
            await self._app(scope, receive, send)
            return

        payment_header = b""
        for name, value in scope.get("headers", []):
            if name == b"x-payment-response":
                payment_header = value
                break

        if payment_header:  # present AND non-empty
            await self._app(scope, receive, send)
            return

        await send(
            {
                "type": "http.response.start",
                "status": 402,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(self._body_bytes)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": self._body_bytes})


def paybot_402_dependency(config: Paybot402Config) -> Callable[..., Any]:
    """Create a FastAPI dependency that gates a route behind the x402 wall.

    Usage::

        from fastapi import Depends
        @app.get("/data", dependencies=[Depends(paybot_402_dependency(cfg))])
        async def data(): ...

    When the request lacks a non-empty ``x-payment-response`` header, the
    dependency raises ``fastapi.HTTPException(status_code=402, detail=<x402 body>)``.

    FastAPI is imported lazily so it is NOT a hard dependency of the SDK.

    :raises ImportError: at call time, if FastAPI/Starlette are not installed.
    """
    try:
        from fastapi import HTTPException, Request
    except ImportError as exc:  # pragma: no cover - exercised via monkeypatch in tests
        raise ImportError(
            "paybot_402_dependency requires FastAPI. Install it with: "
            'pip install "paybot-sdk[web]"'
        ) from exc

    body = _build_402_body(config)

    async def _dependency(request: Request) -> None:
        payment_header = request.headers.get("x-payment-response")
        if payment_header:  # present AND non-empty
            return
        raise HTTPException(status_code=402, detail=body)

    return _dependency
