# hono-cloudflare-worker

A [Hono](https://hono.dev) Cloudflare Worker that protects a route with x402.

**Demonstrates:** a manual x402 payment wall on a Worker route. The SDK has no
Hono middleware port yet, so this implements the same 402 contract as
`paybot402()` using an idiomatic Hono `MiddlewareHandler`.

## Behavior

| Request | Response |
|---------|----------|
| `GET /api/premium` (no `x-payment-response` header) | **402** with x402 requirements JSON |
| `GET /api/premium` (header present) | `200` with the premium content |
| `GET /health` | `200 { ok: true }` |

## Run locally

```bash
cp .env.example .dev.vars   # wrangler loads .dev.vars as the Worker env
npm install
npm run dev                 # wrangler dev
```

```bash
curl -i http://localhost:8787/api/premium     # 402 with requirements
```

## Deploy

1. Fill in `account_id` in [`wrangler.toml`](./wrangler.toml) (or set
   `CLOUDFLARE_ACCOUNT_ID`).
2. Set secrets out-of-band (never in source):
   ```bash
   wrangler secret put PAYBOT_PAY_TO
   wrangler secret put PAYBOT_FACILITATOR_URL   # optional, for self-hosting
   ```
3. Deploy:
   ```bash
   npm run deploy
   ```

## Env / secrets

| Var | Required | Purpose |
|-----|----------|---------|
| `PAYBOT_PAY_TO` | yes | Merchant wallet that receives payment. |
| `PAYBOT_FACILITATOR_URL` | no | Self-hosted facilitator. Defaults to `https://api.paybotcore.com`. |

Secrets are set via `wrangler secret put` (prod) or `.dev.vars` (local). They are
never committed.
