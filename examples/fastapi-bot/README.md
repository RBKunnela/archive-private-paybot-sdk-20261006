# fastapi-bot (Python)

A FastAPI app using the **Python** PayBot SDK (`paybot-sdk` v0.2.0).

**Demonstrates:**
- `paybot_402_dependency` — gate one route behind the x402 payment wall.
- The async `PayBotClient`, registered once at startup via the FastAPI lifespan.

## Behavior

| Route | Paid? | Behavior |
|-------|-------|----------|
| `GET /health` | no | `{ "ok": true }` |
| `GET /premium` | yes | **402** with x402 requirements until a payment proof header is present; then the premium JSON. |

The bot is registered with `register(trust_level=1, ...)` when the app starts.

## Run

```bash
cd examples/fastapi-bot
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env    # fill in PAYBOT_API_KEY + PAYBOT_PAY_TO
uvicorn app:app --reload
```

Then:

```bash
curl -i http://localhost:8000/premium      # 402 with x402 requirements
curl -i http://localhost:8000/health       # 200 { "ok": true }
```

`requirements.txt` installs the in-repo SDK in editable mode with the `[web]`
(FastAPI) and `[signing]` (EIP-3009) extras.

## Required env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `PAYBOT_API_KEY` | yes | Your PayBot API key. |
| `PAYBOT_PAY_TO` | yes | Merchant wallet that receives payment. |
| `PAYBOT_BOT_ID` | no | Bot id (default `fastapi-bot`). |
| `WALLET_PRIVATE_KEY` | no | Enables real on-chain signing. |
| `PAYBOT_FACILITATOR_URL` | no | Self-hosted facilitator. Defaults to `https://api.paybotcore.com`. |

## Notes

- `paybot_402_dependency` takes the amount in **base units** (6-decimal USDC), so
  `$0.05` is `"50000"`.
- For a framework-agnostic wall (any ASGI app, no FastAPI import), use
  `Paybot402Middleware` instead — see the SDK's `paybot_sdk.middleware`.
