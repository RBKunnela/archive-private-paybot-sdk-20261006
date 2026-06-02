/**
 * express-bot — one Express server that is BOTH sides of an x402 exchange.
 *
 * PROVIDER side:
 *   GET /api/premium is gated by paybot402() middleware. Without a payment
 *   proof header it returns HTTP 402 with x402 requirements; with the
 *   `x-payment-response` header it runs the real handler.
 *
 * CONSUMER side:
 *   GET /buy uses PayBotClient.pay() to pay a remote (or our own) resource and
 *   returns the PaymentResult. This is what a bot does when it hits a 402.
 *
 * Required env vars (see .env.example):
 *   PAYBOT_API_KEY          — your PayBot API key (pb_...).
 *   PAYBOT_BOT_ID           — stable bot id (default "express-bot").
 *   PAYBOT_PAY_TO           — your merchant wallet (0x...) — receives payments.
 *   WALLET_PRIVATE_KEY      — (optional) enables real EIP-3009 signing for /buy.
 *   PAYBOT_FACILITATOR_URL  — (optional) self-hosted facilitator URL.
 *   PORT                    — (optional) HTTP port, default 3000.
 */
import 'dotenv/config';
import express from 'express';
import { PayBotClient, paybot402 } from 'paybot-sdk';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (copy .env.example to .env)`);
  }
  return value;
}

const PAY_TO = requireEnv('PAYBOT_PAY_TO');
const FACILITATOR_URL = process.env.PAYBOT_FACILITATOR_URL; // undefined => hosted default
const PORT = Number(process.env.PORT ?? 3000);

const app = express();

// One client this server uses to pay for resources (consumer side).
const client = new PayBotClient({
  apiKey: requireEnv('PAYBOT_API_KEY'),
  botId: process.env.PAYBOT_BOT_ID ?? 'express-bot',
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
  facilitatorUrl: FACILITATOR_URL, // default https://api.paybotcore.com
});

// ── PROVIDER: protect a route with the x402 payment wall ──────────────────────
// $0.05 USDC = 50000 base units (6 decimals). paybot402 takes BASE units.
app.get(
  '/api/premium',
  paybot402({
    payTo: PAY_TO,
    amount: '50000', // 0.05 USDC in base units
    facilitatorUrl: FACILITATOR_URL, // self-host: set PAYBOT_FACILITATOR_URL
    // network defaults to Base Sepolia (eip155:84532).
  }),
  (_req, res) => {
    // Only reached once a payment proof header is present.
    res.json({ data: 'this is the premium content you paid for', value: 42 });
  },
);

// ── CONSUMER: pay for a resource via PayBotClient.pay() ───────────────────────
app.get('/buy', async (_req, res) => {
  const result = await client.pay({
    resource: `http://localhost:${PORT}/api/premium`,
    amount: '0.05',
    payTo: PAY_TO,
  });
  res.status(result.success ? 200 : 502).json(result);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`express-bot listening on http://localhost:${PORT}`);
  console.log(`  GET /api/premium  → 402 until paid (provider)`);
  console.log(`  GET /buy          → pays via PayBotClient.pay() (consumer)`);
});
