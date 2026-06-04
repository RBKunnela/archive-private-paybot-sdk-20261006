# raw-node-script

The smallest possible PayBot SDK program. A good first-run smoke test.

**Demonstrates:** `PayBotClient` construction → `register()` → `balance()` → one `pay()`.

## What it does

1. `register()` — registers the bot (idempotent via an idempotency key).
2. `balance()` — prints trust level + remaining daily budget.
3. `pay()` — makes one $0.01 payment for a resource. `pay()` never throws; it
   returns `{ success: false, errorCode, error }` on failure.

By default it runs in **mock mode** (no `WALLET_PRIVATE_KEY`). Provide a wallet
key to switch to real EIP-3009 on-chain signing.

## Run

```bash
# 1. Build the SDK once at the repo root (produces dist/).
cd ../.. && npm install && npm run build && cd examples/raw-node-script

# 2. Configure and run.
cp .env.example .env   # fill in PAYBOT_API_KEY + PAYBOT_PAY_TO
npm install
npm start
```

## Required env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `PAYBOT_API_KEY` | yes | Your PayBot API key. Never hardcode it. |
| `PAYBOT_BOT_ID` | no (default `smoke-bot`) | Stable bot id. |
| `PAYBOT_PAY_TO` | yes | Recipient wallet (`0x...`) for the test payment. |
| `WALLET_PRIVATE_KEY` | no | Enables real on-chain signing. Omit for mock mode. |
| `PAYBOT_FACILITATOR_URL` | no | Self-hosted facilitator. Defaults to `https://api.paybotcore.com`. |

## Getting an API key

Run `PayBotClient.signup('you@example.com', 'password')` once — it returns
`{ apiKey, botId }`. Save the `apiKey` (shown only once) into `.env`.
