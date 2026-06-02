# nextjs-route-handler

A copy-pasteable Next.js **App Router** route handler that gates a paid API
route with x402.

**Demonstrates:** the x402 402-challenge pattern in a `route.ts`, plus how to use
`createX402Handler` on the consumer side (shown in a comment in the file).

## Why not `paybot402()` directly?

The SDK's `paybot402()` is a Connect/Express middleware with a `(req, res, next)`
signature. The Next.js App Router uses the Web `Request -> Response` signature, so
this route reproduces the **same** x402 402 contract using `Request`/`Response`
directly. The body shape is byte-identical to what `paybot402()` emits.

## Install into a Next.js app

There is intentionally **no full Next scaffold** here — just the route. To use it:

1. In your Next.js App Router project, copy
   [`app/api/premium/route.ts`](./app/api/premium/route.ts) to the same path.
2. Add `paybot-sdk` if you want the consumer-side `createX402Handler`:
   ```bash
   npm install paybot-sdk
   ```
3. Set env vars in `.env.local` (see [`.env.example`](./.env.example)).

## Behavior

| Request | Response |
|---------|----------|
| `GET /api/premium` (no `x-payment-response` header) | **402** with x402 requirements JSON |
| `GET /api/premium` (header present) | `200` with the premium content |

## Required env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `PAYBOT_PAY_TO` | yes | Merchant wallet that receives payment. |
| `PAYBOT_FACILITATOR_URL` | no | Self-hosted facilitator. Defaults to `https://api.paybotcore.com`. |
| `PAYBOT_API_KEY` / `WALLET_PRIVATE_KEY` | consumer only | Needed only if you call the route via `createX402Handler`. |

## Consumer side

See the comment block at the bottom of `route.ts` for the `createX402Handler`
snippet that auto-pays a 402 and retries the request.
