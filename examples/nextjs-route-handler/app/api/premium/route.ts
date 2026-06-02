/**
 * Next.js App Router route handler that gates a paid API route with x402.
 *
 * Drop this file into a Next.js App Router project at:
 *   app/api/premium/route.ts
 *
 * paybot402() is a Connect/Express-style middleware (req,res,next) and does not
 * fit the Next App Router (Request -> Response) signature, so this route
 * reproduces the SAME x402 402 contract directly using Web Request/Response:
 *
 *   - No `x-payment-response` header  -> 402 with x402 requirements JSON.
 *   - Header present + non-empty      -> the real handler runs.
 *
 * For the CONSUMER side (auto-pay + retry against a 402) use createX402Handler
 * from the SDK in your client/server code (see the comment at the bottom).
 *
 * Required env vars (set in .env.local):
 *   PAYBOT_PAY_TO           — merchant wallet (0x...) that receives payment.
 *   PAYBOT_FACILITATOR_URL  — (optional) self-hosted facilitator URL.
 */

// Build the x402 402 body once. $0.05 USDC = 50000 base units (6 decimals).
const PAY_TO = process.env.PAYBOT_PAY_TO ?? '0x0000000000000000000000000000000000000000';
const FACILITATOR_URL = process.env.PAYBOT_FACILITATOR_URL ?? 'https://api.paybotcore.com';
const NETWORK = 'eip155:84532'; // Base Sepolia
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const AMOUNT_BASE_UNITS = '50000'; // 0.05 USDC

const x402Body = {
  x402Version: 1 as const,
  accepts: [
    {
      scheme: 'exact' as const,
      network: NETWORK,
      asset: `${NETWORK}/erc20:${USDC_BASE_SEPOLIA}`,
      amount: AMOUNT_BASE_UNITS,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
    },
  ],
  facilitatorUrl: FACILITATOR_URL,
};

export async function GET(request: Request): Promise<Response> {
  const paymentProof = request.headers.get('x-payment-response');

  // No proof -> demand payment with the x402 requirements.
  if (!paymentProof) {
    return new Response(JSON.stringify(x402Body), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Proof present -> serve the paid content.
  return Response.json({ data: 'premium content unlocked', value: 42 });
}

/*
 * CONSUMER side (how a bot calls this route and auto-pays the 402):
 *
 *   import { createX402Handler } from 'paybot-sdk';
 *
 *   const handler = createX402Handler({
 *     apiKey: process.env.PAYBOT_API_KEY!,
 *     botId: 'nextjs-consumer',
 *     walletPrivateKey: process.env.WALLET_PRIVATE_KEY, // optional
 *     facilitatorUrl: process.env.PAYBOT_FACILITATOR_URL, // self-host
 *     maxAutoPay: '1.00', // refuse to auto-pay above $1.00
 *   });
 *
 *   // If /api/premium returns 402, this pays and retries automatically.
 *   const res = await handler.fetch('https://your-app.com/api/premium');
 *   const data = await res.json();
 */
