/**
 * hono-cloudflare-worker — a Hono Worker that protects a route with x402.
 *
 * There is no Hono middleware port in the SDK yet, so this implements the x402
 * payment wall manually (same 402 contract as paybot402()):
 *
 *   - No `x-payment-response` header  -> 402 with x402 requirements JSON.
 *   - Header present + non-empty      -> the real handler runs.
 *
 * Secrets come from the Worker `env` (set via `wrangler secret put`), NEVER from
 * source. See wrangler.toml + README.
 */
import { Hono, type MiddlewareHandler } from 'hono';

interface Env {
  /** Merchant wallet (0x...) that receives payment. `wrangler secret put PAYBOT_PAY_TO` */
  PAYBOT_PAY_TO: string;
  /** Optional self-hosted facilitator URL. Defaults to https://api.paybotcore.com. */
  PAYBOT_FACILITATOR_URL?: string;
}

const NETWORK = 'eip155:84532'; // Base Sepolia
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const AMOUNT_BASE_UNITS = '50000'; // 0.05 USDC (6 decimals)

/**
 * Hono middleware that gates a route behind the x402 payment wall.
 * Mirrors the SDK's paybot402() contract for the Workers/Hono runtime.
 */
function honoX402(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const proof = c.req.header('x-payment-response');
    if (proof) {
      await next();
      return;
    }
    const facilitatorUrl = c.env.PAYBOT_FACILITATOR_URL ?? 'https://api.paybotcore.com';
    return c.json(
      {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: NETWORK,
            asset: `${NETWORK}/erc20:${USDC_BASE_SEPOLIA}`,
            amount: AMOUNT_BASE_UNITS,
            payTo: c.env.PAYBOT_PAY_TO,
            maxTimeoutSeconds: 300,
          },
        ],
        facilitatorUrl,
      },
      402,
    );
  };
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

// Protected: 402 until paid, then the handler runs.
app.get('/api/premium', honoX402(), (c) => c.json({ data: 'premium content unlocked', value: 42 }));

export default app;
