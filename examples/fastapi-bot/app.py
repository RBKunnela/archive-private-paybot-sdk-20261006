"""fastapi-bot — a FastAPI app using the Python PayBot SDK (v0.2.0).

Demonstrates:
  - paybot_402_dependency: gate one route behind the x402 payment wall.
  - PayBotClient (async) registered at startup via the FastAPI lifespan.

Behavior of the gated route:
  - No `x-payment-response` header -> HTTPException 402 with x402 requirements.
  - Header present + non-empty     -> the real handler runs.

Required env vars (see .env.example):
  PAYBOT_API_KEY          — your PayBot API key (pb_...). NEVER hardcode it.
  PAYBOT_BOT_ID           — stable bot id (default "fastapi-bot").
  PAYBOT_PAY_TO           — merchant wallet (0x...) that receives payment.
  WALLET_PRIVATE_KEY      — (optional) enables real EIP-3009 signing.
  PAYBOT_FACILITATOR_URL  — (optional) self-hosted facilitator URL.

Run:
  pip install -r requirements.txt
  cp .env.example .env   # fill in your keys
  uvicorn app:app --reload
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import Depends, FastAPI

# Load .env into the process environment (no-op if python-dotenv is absent).
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover - dotenv is a convenience, not required
    pass

from paybot_sdk import (
    PayBotClient,
    Paybot402Config,
    PayBotConfig,
    paybot_402_dependency,
)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required env var: {name} (copy .env.example to .env)")
    return value


# Merchant wallet that receives payment on the gated route.
PAY_TO = os.environ.get("PAYBOT_PAY_TO", "0x0000000000000000000000000000000000000000")
# undefined -> the SDK uses the hosted default https://api.paybotcore.com.
FACILITATOR_URL = os.environ.get("PAYBOT_FACILITATOR_URL")

# x402 payment wall for /premium. amount is in USDC base units (6 decimals):
# "50000" = $0.05.
wall = paybot_402_dependency(
    Paybot402Config(
        pay_to=PAY_TO,
        amount="50000",
        facilitator_url=FACILITATOR_URL,  # self-host: set PAYBOT_FACILITATOR_URL
        # network defaults to Base Sepolia (eip155:84532).
    )
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Register the bot once when the app starts (async PayBotClient)."""
    client = PayBotClient(
        PayBotConfig(
            api_key=_require_env("PAYBOT_API_KEY"),
            bot_id=os.environ.get("PAYBOT_BOT_ID", "fastapi-bot"),
            wallet_private_key=os.environ.get("WALLET_PRIVATE_KEY"),
            facilitator_url=FACILITATOR_URL,
        )
    )
    app.state.paybot = client
    # Register the bot at trust level 1 (idempotency key dedupes re-runs).
    await client.register(trust_level=1, idempotency_key="fastapi-register")
    yield
    # Nothing to tear down for this minimal example.


app = FastAPI(title="paybot fastapi-bot example", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, bool]:
    """Liveness check (unpaid)."""
    return {"ok": True}


@app.get("/premium", dependencies=[Depends(wall)])
async def premium() -> dict[str, object]:
    """Paid route — only runs once a payment proof header is present."""
    return {"data": "premium content unlocked", "value": 42}
