# paybot-sdk

USDC payments for bots via the [x402 protocol](https://www.x402.org/). One dependency (`viem`), 7 files, typed everything.

## Key Features

- **One dependency** (`viem`), 7 files, fully typed
- **Simple API** — register your bot and make payments in 2 lines of code
- **Network support** — Base and Base Sepolia (EIP155)
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

## Quick Start

```typescript
import { PayBotClient } from 'paybot-sdk';

const client = new PayBotClient({
  apiKey: 'pb_test_...',
  botId: 'my-bot',
  facilitatorUrl: 'https://api.paybotcore.com',
});

// Register your bot
await client.register();

// Make a payment
const result = await client.pay({
  resource: 'https://api.example.com/data',
  amount: '0.01',
  payTo: '0x1234...abcd',
});

console.log(result.success, result.txHash);
```

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

| Level | Name | Per-Tx Limit | Daily Limit |
|-------|------|-------------|-------------|
| 0 | Suspended | $0 | $0 |
| 1 | New | $1 | $10 |
| 2 | Basic | $10 | $100 |
| 3 | Verified | $100 | $1,000 |
| 4 | Trusted | $1,000 | $10,000 |
| 5 | Premium | $10,000 | $100,000 |

## SDK Methods

| Method | Description |
|--------|-------------|
| `client.pay(request)` | Execute a payment (verify + settle) |
| `client.register(trustLevel?)` | Register bot with facilitator |
| `client.balance()` | Get trust status and remaining budget |
| `client.history(limit?)` | Get transaction history |
| `client.setLimits(limits)` | Update spending limits |
| `client.health()` | Check facilitator health |

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
console.log(getSupportedNetworks()); // ['eip155:8453', 'eip155:84532']

// Get network details
const baseSepolia = getNetwork('eip155:84532');
console.log(baseSepolia?.name); // 'Base Sepolia'
```

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

## License

[MIT](LICENSE)
