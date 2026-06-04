# express-bot

One Express server that is **both** sides of an x402 payment exchange.

**Demonstrates:**
- **Provider:** `paybot402()` middleware gating `GET /api/premium`.
- **Consumer:** `PayBotClient.pay()` on `GET /buy`.

## Routes

| Route | Side | Behavior |
|-------|------|----------|
| `GET /api/premium` | provider | Returns **402** + x402 requirements until a payment proof header is present; then returns the premium JSON. |
| `GET /buy` | consumer | Calls `PayBotClient.pay()` for `$0.05` and returns the `PaymentResult`. |
| `GET /health` | — | Liveness check. |

> Note: `paybot402()` takes the amount in **base units** (6-decimal USDC), so
> `$0.05` is `"50000"`. `PayBotClient.pay()` takes the **human-readable** amount
> (`"0.05"`). That asymmetry is intentional and matches the SDK API.

## Run

```bash
cd ../.. && npm install && npm run build && cd examples/express-bot
cp .env.example .env   # fill in PAYBOT_API_KEY + PAYBOT_PAY_TO
npm install
npm start
```

Then:

```bash
# Provider: returns 402 with x402 requirements (no payment proof yet)
curl -i http://localhost:3000/api/premium

# Consumer: pays via the SDK and prints the PaymentResult
curl http://localhost:3000/buy
```

## Required env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `PAYBOT_API_KEY` | yes | PayBot API key for the consumer client. |
| `PAYBOT_PAY_TO` | yes | Merchant wallet that receives payments. |
| `PAYBOT_BOT_ID` | no | Bot id (default `express-bot`). |
| `WALLET_PRIVATE_KEY` | no | Enables real on-chain signing on `/buy`. |
| `PAYBOT_FACILITATOR_URL` | no | Self-hosted facilitator. Defaults to `https://api.paybotcore.com`. |
| `PORT` | no | HTTP port (default 3000). |

## Self-hosting

Set `PAYBOT_FACILITATOR_URL` in `.env`; both the middleware and the client read it.
