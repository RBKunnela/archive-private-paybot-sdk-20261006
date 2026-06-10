# paybot-sdk

USDC and EURC payments for bots via the [x402 protocol](https://www.x402.org/). One dependency (`viem`), typed everything.

## Key Features

- **One dependency** (`viem`), fully typed
- **Simple API** — register your bot and make payments in 2 lines of code
- **Network support** — Base, Optimism, Arbitrum One, Polygon PoS mainnets + Base Sepolia testnet (EIP155)
- **Mock mode** for testing without real transactions
- **MCP integration** — works with AI agent frameworks via [`paybot-mcp`](https://github.com/RBKunnela/paybot-mcp)
- **Self-hostable** facilitator service

## Architecture

```
PayBotClient → Facilitator (x402) → On-chain USDC (EIP-3009)
```

The SDK wraps payment logic for bots, handling registration, payment execution, and network configuration. Developers can use the hosted facilitator at `api.paybotcore.com` or run their own.

## Install

```bash
npm install paybot-sdk
```

> **ESM only.** This package ships no CommonJS export — `require('paybot-sdk')`
> fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. A fresh `npm init -y` project
> defaults to CommonJS, so set `"type": "module"` in your `package.json` (or
> use a `.mjs` file) and load the SDK with `import`.

## Get your API key

No dashboard needed — one `signup()` call against the hosted facilitator at `https://api.paybotcore.com` creates everything:

```typescript
import { PayBotClient } from 'paybot-sdk';

const account = await PayBotClient.signup('you@example.com', 'a-strong-password', {
  botId: 'my-bot', // optional, defaults to 'default'
});
console.log(account.apiKey); // pb_live_... — printed ONLY once, save it now
```

`signup()` registers your operator account, logs in, creates an API key, **and registers your bot** — all in one call. The returned `apiKey` is shown only once; store it securely (e.g. in the `PAYBOT_API_KEY` env var).

> **Heads-up:** because `signup()` already registered your bot, calling `client.register()` afterwards with the same `botId` throws a `409 ALREADY_EXISTS`. Skip `register()` and go straight to `pay()` / `balance()`. Only call `register()` when adding **additional** bots under new `botId`s.

## Quick Start

```typescript
import { PayBotClient } from 'paybot-sdk';

const client = new PayBotClient({
  apiKey: process.env.PAYBOT_API_KEY!, // from signup() above
  botId: 'my-bot',                     // same botId you passed to signup()
  facilitatorUrl: 'https://api.paybotcore.com',
});

// signup() already registered this bot — no register() needed.
// Make a payment:
const result = await client.pay({
  resource: 'https://api.example.com/data',
  amount: '0.01',
  payTo: '0x1234...abcd',
});

console.log(result.success, result.txHash);
```

### Mock mode vs real settlement

The SDK has two payment modes, decided by whether you pass `walletPrivateKey`:

- **Mock mode (default):** omit `walletPrivateKey` and the SDK sends a mock payment payload (`payer:<botId>`) — nothing is signed and **no funds move on-chain**. Use it to integrate and test against a facilitator running with `SETTLEMENT_MODE=mock` (the default for self-hosted instances).
- **Real settlement:** pass `walletPrivateKey` (`0x...`) so the SDK signs genuine EIP-3009 `TransferWithAuthorization` transfers, **and** point at a facilitator configured with `SETTLEMENT_MODE=real` (or `SETTLEMENT_MODE=testnet` for Base Sepolia). Both sides are required — a wallet key against a mock-mode server still settles nothing.

## x402 Auto-Handler

Automatically pay for HTTP 402 responses:

```typescript
import { createX402Handler } from 'paybot-sdk';

const handler = createX402Handler({
  apiKey: 'pb_test_...',
  botId: 'my-bot',
  maxAutoPay: '1.00', // Max USD per auto-payment
});

// If the server returns 402, PayBot pays and retries automatically
const response = await handler.fetch('https://api.example.com/paid-endpoint');
const data = await response.json();
```

When the server places a payment in its **approval band** (a borderline amount
that needs a human decision), the auto-handler does **not** block and does **not**
throw — it returns a `202` response carrying the pending result, so your agent
stays responsive:

```typescript
const response = await handler.fetch('https://api.example.com/paid-endpoint');
if (response.status === 202) {
  const pending = await response.json(); // { status: 'pending_approval', approvalId, … }
  // Opt-in: wait for the human to decide (or carry on and check back later).
  const final = await handler.client.waitForApproval(pending.approvalId);
}
```

> **Pending vs. over-ceiling — two distinct paths.** The client-side `maxAutoPay`
> ceiling still **throws** (your bot saying "I will never auto-pay this much"). A
> server-side `pending_approval` is a **returned result** (the server saying "a
> human should look at this"). They never collapse into one.

## Human-in-the-Loop Approvals (pending payments)

When PayBotFin's policy places a payment in the **approval band**, `pay()` returns
a **non-throwing** pending result instead of settling — the money has not moved,
but the payment is paused awaiting a human, not failed:

```typescript
const result = await client.pay({ resource, amount: '500', payTo });

if (result.status === 'pending_approval') {
  // success is false (money didn't move) but this is a PAUSE, not a failure.
  console.log('Awaiting approval:', result.approvalId, 'expires', result.expiresAt);

  // Opt-in: block until a human approves/denies, or the request times out.
  const final = await client.waitForApproval(result.approvalId!, {
    timeoutMs: 15 * 60_000, // default: 15 min (aligned to the server TTL)
    intervalMs: 3_000,      // default: 3 s poll cadence
  });

  if (final.success) {
    console.log('Approved + settled:', final.txHash);
  } else if (final.status === 'denied') {
    console.log('Denied or expired:', final.error);
  } else if (final.status === 'pending_approval') {
    // Local timeout — the SERVER record is still live; the SDK timing out never
    // cancels the approval. You may call waitForApproval(...) again later.
  }
}
```

**Safe degradation:** a consumer that only reads `result.success` keeps working
unchanged — a pending payment looks like `success: false` ("not done yet"), with
no new crash path. `waitForApproval()` itself **never throws**: poll errors and
local timeouts are returned as `PaymentResult`s, not exceptions.

## Real Payments (EIP-3009)

Pass a wallet private key to sign actual on-chain USDC transfers:

```typescript
const client = new PayBotClient({
  apiKey: 'pb_...',
  botId: 'my-bot',
  walletPrivateKey: '0x...', // Signs EIP-3009 TransferWithAuthorization
});
```

## Trust Levels

PayBot enforces progressive trust levels that govern what your bot can do:

| Level | Name | Per-Tx Limit | Daily Limit | Description |
|-------|------|-------------|-------------|-------------|
| 0 | Sandbox | $0 | $0 | Test-only mode, no real payments |
| 1 | Basic | $1 | $10 | Email-verified, micropayments only |
| 2 | Verified | $10 | $100 | KYB-verified operator |
| 3 | Trusted | $100 | $1,000 | 30-day clean history |
| 4 | Premium | $1,000 | $10,000 | Manual review passed |
| 5 | Enterprise | Custom | Custom | Contract-backed, limits negotiated |

New bots register at level 1 (Basic) by default. Names and limits mirror the facilitator's canonical trust registry.

## SDK Methods

| Method | Description |
|--------|-------------|
| `client.pay(request)` | Execute a payment (verify + settle); returns a pending result if the server requires human approval |
| `client.waitForApproval(approvalId, opts?)` | Poll a pending approval until settled/denied/expired (or local timeout). Never throws |
| `client.register(trustLevel?)` | Register bot with facilitator |
| `client.balance()` | Get trust status and remaining budget |
| `client.history(limit?)` | Get transaction history |
| `client.setLimits(limits)` | Update spending limits |
| `client.health()` | Check facilitator health |

> **Units:** payment amounts returned by `history()` / `balance()` records are in 6-decimal USDC base units (`1000000` = 1 USDC) — unlike the human-readable strings you pass to `pay()` (e.g. `'0.01'`).

## CLI

The package ships a `paybot` command — a thin wrapper over `PayBotClient`. No
install needed beyond `npx`:

```bash
npx paybot --help
```

(Or install globally / as a dependency: `npm i -g paybot-sdk` then `paybot ...`.)

### Configuration

Every command resolves config with precedence **flags > environment > error**:

| Setting | Flag | Environment variable |
|---------|------|----------------------|
| API key | `--api-key <key>` | `PAYBOT_API_KEY` |
| Bot id | `--bot-id <id>` | `PAYBOT_BOT_ID` |
| Wallet key (for real payments) | _(env only)_ | `WALLET_PRIVATE_KEY` |
| Facilitator URL | `--facilitator-url <url>` | `PAYBOT_FACILITATOR_URL` |

Secrets (API keys, wallet keys) are **never printed in full** — any echoed value
is masked as `prefix…suffix`.

```bash
export PAYBOT_API_KEY="pb_test_..."
export PAYBOT_BOT_ID="my-bot"
```

### Commands

```bash
# Register this bot (optional initial trust level 0-5)
paybot register --bot-id my-bot --trust-level 2

# Show trust status + remaining budget
paybot balance

# Pay for a resource (amount is human-readable, e.g. 0.05)
paybot pay \
  --resource https://api.example.com/data \
  --amount 0.05 \
  --pay-to 0xRecipient... \
  --token USDC \
  --idempotency-key order-123

# Check facilitator health
paybot health

# List supported networks (CAIP-2 + name)
paybot networks

# List supported tokens (optionally for one network)
paybot tokens
paybot tokens --network eip155:10
```

| Command | Wraps |
|---------|-------|
| `paybot register [--trust-level <n>]` | `client.register()` |
| `paybot balance` | `client.balance()` |
| `paybot pay --resource <url> --amount <human> --pay-to <0x> [--token <SYM>] [--network <caip2>] [--idempotency-key <k>]` | `client.pay()` |
| `paybot health` | `client.health()` |
| `paybot networks` | `getSupportedNetworks()` |
| `paybot tokens [--network <caip2>]` | `getSupportedTokens()` |

## Error Handling

Non-`pay()` methods throw `PayBotApiError` on failure:

```typescript
import { PayBotApiError } from 'paybot-sdk';

try {
  await client.balance();
} catch (err) {
  if (err instanceof PayBotApiError) {
    console.log(err.code);       // 'NOT_FOUND'
    console.log(err.statusCode); // 404
    console.log(err.details);    // { botId: 'unknown-bot' }
  }
}
```

`pay()` returns `PaymentResult` with `success: false` instead of throwing:

```typescript
const result = await client.pay({ ... });
if (!result.success) {
  console.log(result.error);        // Human-readable message
  console.log(result.errorCode);    // 'TRUST_VIOLATION'
  console.log(result.errorDetails); // { gate: 'SPENDING_ENVELOPE', ... }
}
```

## Network Configuration

```typescript
import { NETWORKS, getNetwork, getSupportedNetworks } from 'paybot-sdk';

// Available networks
console.log(getSupportedNetworks());
// ['eip155:8453', 'eip155:84532', 'eip155:10', 'eip155:42161', 'eip155:137']

// Get network details
const baseSepolia = getNetwork('eip155:84532');
console.log(baseSepolia?.name); // 'Base Sepolia'
```

### Networks supported

| Network | CAIP-2 | Chain ID | Type |
|---|---|---|---|
| Base Mainnet | `eip155:8453` | 8453 | mainnet |
| Base Sepolia | `eip155:84532` | 84532 | testnet |
| Optimism | `eip155:10` | 10 | mainnet |
| Arbitrum One | `eip155:42161` | 42161 | mainnet |
| Polygon PoS | `eip155:137` | 137 | mainnet |

RPC URLs default to public endpoints (`mainnet.optimism.io`, `arb1.arbitrum.io/rpc`, `polygon-rpc.com`, …); override per network for production use.

## Webhook Signature Verification

Verify inbound webhooks from the facilitator (HMAC-SHA256, constant-time compare, replay-window guard). No extra dependency — uses Node's built-in `crypto`.

```typescript
import { verifyWebhookSignature } from 'paybot-sdk';

app.post('/paybot/webhook', (req, res) => {
  const valid = verifyWebhookSignature({
    payload: req.rawBody,                       // raw string/Buffer, exactly as received
    signature: req.headers['paybot-signature'], // 't=<unix_ts>,v1=<hmac_hex>'
    secret: process.env.PAYBOT_WEBHOOK_SECRET,
    tolerance: 300,                             // optional replay window in seconds (default 300)
  });
  if (!valid) return res.status(400).send('invalid signature');
  // ...handle event
  res.sendStatus(200);
});
```

The signing string is `` `${t}.${payload}` ``; the same algorithm is implemented identically in the Python SDK, so a server-signed webhook verifies byte-for-byte in either runtime. `signWebhookPayload({ payload, secret })` produces a header value for TS-based senders and tests.

## OpenTelemetry (opt-in)

Pass any OpenTelemetry-compatible tracer to emit spans around the payment lifecycle. When no tracer is supplied, telemetry is a zero-overhead no-op — `@opentelemetry/api` is **not** a dependency of this SDK.

```typescript
import { trace } from '@opentelemetry/api';

const client = new PayBotClient({
  apiKey: 'pb_...',
  botId: 'my-bot',
  walletPrivateKey: '0x...',
  telemetry: { tracer: trace.getTracer('my-bot'), prefix: 'paybot.' },
});
```

Spans emitted per `pay()`: `paybot.client.pay`, `paybot.x402.sign`, `paybot.x402.challenge`, `paybot.x402.settle` — with `network`, `amount`, `bot_id`, `tx_hash`, and `success` attributes. A returned payment failure is an OK span with `success=false`; only thrown errors become span ERROR + `recordException`.

## x402 v2 conformance

Tracks the [x402-foundation](https://github.com/x402-foundation/x402) spec: v2 `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers (the legacy `Payment-Intent` path still works), CAIP-2 network identifiers, and the `upto` (metered/usage) scheme alongside `exact`.

```typescript
import { parseCaip2, isSupportedCaip2 } from 'paybot-sdk';

parseCaip2('eip155:8453');        // { namespace: 'eip155', reference: '8453' }
isSupportedCaip2('eip155:8453');  // true

// 'upto' authorizes a capture ceiling; the facilitator settles the actual usage <= max.
// X402Handler.validateUptoCapture(authorizedMax, captured) throws UPTO_OVERCHARGE if exceeded.
```

## Tokens (USDC + EURC + DAI)

Pay in USDC (default), EURC, or DAI. The signing domain is resolved per-token, so each
token signs against its own contract. USDC defaults everywhere; the public surface is
unchanged for existing USDC callers.

```typescript
import { getToken, getSupportedTokens } from 'paybot-sdk';

getSupportedTokens();      // ['USDC', 'EURC', 'DAI']
getToken('EURC')?.symbol;  // 'EURC'
getToken('DAI')?.decimals; // 18

await client.pay({
  resource: 'https://api.example.com/data',
  amount: '0.50',
  payTo: '0x....',
  token: 'EURC',           // defaults to 'USDC'; unknown token → UNSUPPORTED_TOKEN
  network: 'eip155:84532', // EURC testnet ships in the public registry
});
```

### Token coverage

Only `(token, network)` pairs verifiable against an **official issuer source** are
shipped in the public registry. A wrong contract address routes real funds to the
wrong contract, so unverifiable pairs are deliberately omitted rather than guessed.
The public registry carries only addresses that are safe to ship open-core — mainnet
addresses for regulated tokens (e.g. EURC mainnet) are operator-supplied at runtime
(see below), not hardcoded here.

| Token | Decimals | Base | Base Sepolia | Optimism | Arbitrum | Polygon | Issuer source |
|---|---|---|---|---|---|---|---|
| USDC | 6 | ✓ | ✓ | ✓ | ✓ | ✓ | [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) |
| EURC | 6 | override | ✓ | — | — | — | [Circle EURC addresses](https://developers.circle.com/stablecoins/eurc-contract-addresses) |
| DAI | 18 | — | — | ✓ | ✓ | ✓ | [MakerDAO / Sky](https://docs.makerdao.com/) |

`override` = the address is not shipped in the public registry; supply it at runtime
via `tokenAddressOverrides` (see below).

**Not currently supported:** PYUSD (Paxos — Ethereum + Solana only) and RLUSD (Ripple —
Ethereum + XRPL only) are not deployed on any network in this registry, so they are not
registered.

> Token contract addresses ship with their official issuer source cited inline in
> `src/networks.ts`. Re-verify each address against the cited source before mainnet use.

### Mainnet token addresses (operator-supplied)

The public registry ships only addresses that are safe to distribute open-core
(e.g. testnet deployments). Mainnet addresses for regulated tokens are **not**
hardcoded in the SDK — inject them at runtime via `tokenAddressOverrides`
(`symbol → caip2Network → address`):

```typescript
const client = new PayBotClient({
  apiKey: 'pb_...',
  botId: 'my-bot',
  tokenAddressOverrides: {
    EURC: { 'eip155:8453': '0x...' }, // your EURC mainnet contract address
  },
});
```

Address resolution precedence: explicit `PaymentRequest.tokenContract` →
`tokenAddressOverrides[symbol][network]` → the public registry → otherwise a
`PaymentResult` failure with code `TOKEN_ADDRESS_NOT_CONFIGURED`. This keeps the
SDK from signing against a wrong or absent address when a mainnet token is not
configured.

## Error Taxonomy

`pay()` still returns `PaymentResult` (never throws). The other methods throw a typed hierarchy you can `instanceof`-switch on — all subclasses remain `instanceof PayBotApiError` for backward compatibility.

```typescript
import {
  PayBotError,            // abstract root
  PayBotApiError,         // HTTP-level (unchanged)
  PayBotNetworkError, PayBotTimeoutError, PayBotAuthError,
  PayBotPolicyError,      // trust/AML/daily-limit
  PayBotSignatureError, PayBotSettlementError,
} from 'paybot-sdk';

try {
  await client.balance();
} catch (err) {
  if (err instanceof PayBotPolicyError) { /* trust/limit gate */ }
  else if (err instanceof PayBotAuthError) { /* re-auth */ }
}
```

## Idempotency Keys

Pass an `idempotencyKey` to `pay()` / `register()` — sent as `X-Idempotency-Key` and deduped in a per-client LRU so a retried call doesn't double-bill.

```typescript
await client.pay({ resource, amount: '0.01', payTo, idempotencyKey: 'order_42_attempt_1' });
// A second call with the same key returns the cached result with no network round-trip.
```

## Multi-Bot Pool + Spend Treasury

Run many bots in one process from shared operator/transport config, each with its own signing key, under an optional shared daily spend ceiling.

```typescript
import { PayBotClientPool } from 'paybot-sdk';

const pool = new PayBotClientPool({
  apiKey: 'pb_...',
  operatorId: 'op_1',
  sharedDailyLimitUsd: 500,         // optional treasury across all bots
});
pool.addBot({ botId: 'bot-1', walletPrivateKey: '0x...' });
pool.addBot({ botId: 'bot-2', walletPrivateKey: '0x...' });

// payAs() blocks over-treasury BEFORE any network call (errorCode 'TREASURY_EXCEEDED')
const result = await pool.payAs('bot-1', { resource, amount: '12.00', payTo });
pool.remainingTreasuryUsd();        // 488 after a successful $12 spend
```

## Micropayment Batching

`MicropaymentEngine` queues many sub-cent payments and settles them as one signed batch, so per-payment gas is amortized across the group. Auto-settle fires when the batch window closes or the count/total thresholds are reached.

```typescript
import { MicropaymentEngine } from 'paybot-sdk';

const engine = new MicropaymentEngine({
  walletPrivateKey: '0x...',
  batchWindowMs: 60_000,   // default 60s window
  minPaymentCount: 100,    // auto-settle thresholds
  minTotalUsd: 1.0,
});

const id = await engine.queuePayment('0xRecipient...', '0.001');  // returns paymentId
const batch = await engine.batchPayments([id]);                   // signed BatchedSettlement
engine.getQueueStatistics();                                      // BatchStatistics
```

## AP2 + MPP

paybot is a clean x402 settlement engine, so a Google **AP2** (A2A x402-extension) mandate can settle through it directly. **MPP** (Stripe/Tempo) is still preview — the SDK ships only a detect-and-route capability seam, not a full client.

```typescript
import { Ap2Adapter, detectMppCapability, InMemoryReplayStore } from 'paybot-sdk';

const ap2 = new Ap2Adapter(handler);              // handler: X402Handler

// Verified path (recommended): full AP2 mandate VC envelope.
// Fail-closed 8-step pipeline: envelope shape -> pinned proof suite ->
// offline DID/key resolution -> operator trust anchors -> signature ->
// temporal validity -> replay -> cart/intent linkage.
const receipt = await ap2.settleVc(mandateVc, {
  verify: {
    trustedIssuers: ['did:key:z6Mk...'],          // EMPTY LIST = NOTHING TRUSTED
    replayStore: new InMemoryReplayStore(),        // per-process; core is authoritative
  },
});
receipt.mandateVerification; // 'verified'

// Legacy path: translation-only settlement slice (NO authenticity check).
if (ap2.validateMandate(mandate).valid) {
  const r = await ap2.settle(mandate);            // signs + submits via x402
  r.mandateVerification;                          // always 'not-performed'
}

detectMppCapability(responseHeaders);             // { supported, mode: 'detect-only'|'none', specVersion? }
// createMppSeam().settle(...) throws MPP_NOT_IMPLEMENTED (501) — full MPP deferred until GA
```

> **What our AP2 support means (honesty note).** `settleVc()` cryptographically
> verifies an AP2 mandate VC envelope before settlement: pinned proof suites
> (the reference SDK's SD-JWT/ES256 shape and W3C `eddsa-jcs-2022`), offline-only
> DID resolution (`did:key` + operator-pinned `did:web` documents — never a
> network fetch), an operator trust-anchor list that fails closed when empty,
> and replay protection keyed `(mandateId, cartHash)`. The legacy
> `settle(mandate)` slice path remains translation-only: its opaque `signature`
> field is **not** verified and its receipts are always marked
> `mandateVerification: 'not-performed'`. PayBot is the consumer side of AP2
> mandates — it does not issue them. SD-JWT key-binding presentations and
> delegation chains are not yet supported and are rejected fail-closed.

## Python SDK

A Python port lives in [`packages/python`](./packages/python) (`paybot-sdk` on PyPI, `>=3.10`). Mirrors the TS client surface, real EIP-3009 signing via `eth-account`, and the identical webhook verification contract.

```python
from paybot_sdk import PayBotClient, PayBotConfig, PaymentRequest, verify_webhook_signature

client = PayBotClient(PayBotConfig(api_key="pb_...", bot_id="my-bot", wallet_private_key="0x..."))
result = await client.pay(PaymentRequest(resource="https://api.example.com/data",
                                         amount="0.01", pay_to="0x...."))
```

## MCP Integration

For AI agent frameworks, use [paybot-mcp](https://github.com/RBKunnela/paybot-mcp) which wraps this SDK as an MCP server.

## Roadmap & Status

> **Legend:** ✅ shipped · 🟡 partial · 🔭 deferred (intentional) · ⬜ gap

**Capability map** — what the SDK can do today:

![paybot-sdk capability map](./.github/assets/paybot-sdk-capability-map.png)

**Roadmap ahead** — the phased plan:

![paybot-sdk roadmap](./.github/assets/paybot-sdk-roadmap-timeline.png)

### What we've built

**Core rail (hardened):** `PayBotClient` (pay/balance/history/setLimits/register/health/commission/API-keys) · x402 auto-handler · EIP-3009 signing · `MicropaymentEngine` · trust levels 0–5 · commission accounting · `paybot402()` middleware · self-hostable facilitator · CI hardening (CodeQL, OSV, 80% coverage gate, SHA-pinned actions).

| Shipped | Gap ID |
|---------|--------|
| ✅ x402 **v2 conformance** — `upto` scheme, `PAYMENT-*` headers, CAIP-2 helpers | T1.1 + new |
| ✅ **Webhook signature verification** (TS + Python, byte-identical HMAC) | T1.2 |
| ✅ **Idempotency keys** (`X-Idempotency-Key` + LRU dedupe) | T1.3 |
| ✅ **Error taxonomy** (`PayBotError` + 6 typed subclasses) | T1.4 |
| ✅ **OpenTelemetry hooks** (opt-in, zero new deps) | T1.5 |
| ✅ **Multi-bot pool + spend treasury** | T1.6 |
| ✅ **EURC + token registry** (per-token EIP-712 domains) | T2.2 |
| ✅ **AP2 settlement adapter** · 🔭 thin **MPP capability seam** (deferred to GA) | T2.3 |
| ✅ **Python SDK 0.1.0** (real EIP-3009 signing) | T3.2 (partial) |
| ✅ **Network expansion** — Optimism, Arbitrum One, Polygon PoS (+ Base, Base Sepolia) | T2.1 |
| ✅ **CLI** — `paybot` command (register/balance/pay/health/networks/tokens) | T3.4 |

**Tier 1 (credibility blockers) is 100% complete** (T1.1–T1.6). Test posture: 331 TS tests / 98.66% coverage · 52 Python tests.

### Current gaps

- ⬜ **CCTP V2 cross-chain receive** — ⏰ *time-sensitive: Circle CCTP V1 deprecates 2026-07-31.*
- ⬜ **Refund + reversal helpers (T2.4)** · ⬜ **Streaming subscriptions (T2.5)** · ⬜ **Wallet-connect bridge (T2.6)**
- 🟡 **Token breadth** — USDC + EURC + DAI done; PYUSD / RLUSD not added (no deployments on the supported networks).
- 🟡 **Language ports (T3.2)** — Python runtime shipped (middleware/x402-handler unported); Go / Rust not started.
- ⬜ **Framework ports (T3.1)** (Hono/Next/NestJS/FastAPI/Django) · ⬜ **Examples + tutorial site (T3.5)** · ⬜ **More MCP tools (T3.3)** · ⬜ **L402 shim (T3.6)**
- 🔭 **Full MPP (T2.3)** — deliberately deferred; Stripe/Tempo MPP is still preview and shares no signing code with EIP-3009. Detect-only seam ships now.

### Roadmap ahead

Prioritized by internal gap severity × external leverage (EU-bank credibility, live distribution channels, hard deadlines).

**Phase A — Near-term (rail credibility):**
1. CCTP V2 cross-chain receive — ⏰ hard deadline (CCTP V1 dies 2026-07-31).
2. Refund + reversal helpers — table-stakes for real commerce.
3. Token breadth (PYUSD/RLUSD, operator-gated).

**Phase B — Mid-term (agent-economy surface):** streaming subscriptions · framework ports (Hono/Next/FastAPI first) · examples + tutorial site · wallet-connect bridge.

**Phase C — Strategic / opportunistic:** full MPP (on GA) · more language ports (Go/Rust) · L402/Lightning shim · more MCP tools.

**Strategic posture:** the moat is *self-hosted, non-custodial, MIT, trust-layer-in-the-SDK* — which custodial/portal-locked rivals (Coinbase Agentic Wallets, Circle, Crossmint, Payman) structurally cannot copy. Being a clean x402 settlement engine makes paybot AP2-pluggable and AgentCore-compatible today — so MPP can wait for GA.

## Deployment Options

### Option 1: Hosted (Recommended)

Use the hosted facilitator at `api.paybotcore.com` — no setup needed, ready to go:

```typescript
const client = new PayBotClient({
  apiKey: 'pb_test_...',
  botId: 'my-bot',
  facilitatorUrl: 'https://api.paybotcore.com',  // ← Hosted
});
```

### Option 2: Self-Hosted with Docker

For enterprise bots or custom networks, deploy your own PayBot facilitator with Docker (5 minutes):

```bash
git clone https://github.com/RBKunnela/paybot-core.git
cd paybot-core
docker compose up -d
```

Then configure your bot:

```typescript
const client = new PayBotClient({
  apiKey: 'pb_dev_...',
  botId: 'my-bot',
  facilitatorUrl: 'http://localhost:3000',  // ← Self-hosted
});
```

**Quick start guide**: See [SELF_HOSTING.md](./SELF_HOSTING.md) in this repository.

**Full deployment guide**: See [DEPLOYMENT.md](https://github.com/RBKunnela/paybot-core/blob/main/DEPLOYMENT.md) in paybot-core repository.

## Contributing

We take security seriously. **All PRs are reviewed by an army of AI agents** from different specializations (@dev, @qa, @architect, @security, @devops) before acceptance. This ensures code quality, correctness, security validation, and architectural alignment.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[MIT](LICENSE)
