# multi-bot-pool

Run several bots from one operator process with a **shared spend treasury**.

**Demonstrates:** `PayBotClientPool` with `sharedDailyLimitUsd`, `addBot()`,
`payAs()`, and the `TREASURY_EXCEEDED` guard.

## What it does

1. Creates a pool with `sharedDailyLimitUsd: 10` (a $10/day envelope across **all** bots).
2. Adds two bots, each with its **own** signing key (bots never cross-sign).
3. `payAs('bot-a', { amount: '4' })` — fits the budget; the spend is recorded.
4. `payAs('bot-b', { amount: '50' })` — would blow the remaining budget, so the
   pool refuses it locally with `errorCode: 'TREASURY_EXCEEDED'` and makes **no**
   network call.
5. Prints `botStats('bot-a')` — local per-bot bookkeeping (a convenience
   projection, not the authoritative server-side limit).

## Run

```bash
cd ../.. && npm install && npm run build && cd examples/multi-bot-pool
cp .env.example .env   # fill in PAYBOT_API_KEY + PAYBOT_PAY_TO
npm install
npm start
```

Expected output (mock mode, abbreviated):

```
Pool bots: [ 'bot-a', 'bot-b' ]
Remaining treasury: 10 USD
bot-a $4 → OK
Remaining treasury: 6 USD
bot-b $50 → correctly refused by the shared treasury (no network call)
bot-a stats: { dailySpentUsd: 4, dailyTxCount: 1 }
```

## Required env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `PAYBOT_API_KEY` | yes | Operator API key shared by the pool. |
| `PAYBOT_PAY_TO` | yes | Recipient wallet for the demo payments. |
| `BOT_A_WALLET_KEY` / `BOT_B_WALLET_KEY` | no | Per-bot signing keys for real mode. |
| `PAYBOT_FACILITATOR_URL` | no | Self-hosted facilitator. Defaults to `https://api.paybotcore.com`. |

> The shared treasury is an **in-process** envelope. The facilitator still
> enforces its own authoritative per-bot limits on every `pay()`.
