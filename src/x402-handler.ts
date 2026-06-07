import { PayBotClient } from './client.js';
import type { PayBotConfig } from './types.js';

/**
 * Configuration for the x402 auto-handler.
 */
export interface X402HandlerConfig extends PayBotConfig {
  /** Maximum amount (in USD) to auto-pay without confirmation (default: "1.00") */
  maxAutoPay?: string;
  /** Network CAIP-2 ID (default: eip155:84532 Base Sepolia) */
  network?: string;
}

/**
 * Create an x402 auto-handler that intercepts HTTP 402 responses
 * and automatically pays using PayBot, then retries the request.
 *
 * Usage:
 * ```typescript
 * import { createX402Handler } from 'paybot-sdk';
 *
 * const handler = createX402Handler({
 *   apiKey: 'pb_...',
 *   botId: 'my-bot',
 *   walletPrivateKey: '0x...', // optional: enables real on-chain payments
 * });
 *
 * // Automatic: if 402, pays and retries. If 200, returns normally.
 * const response = await handler.fetch('https://api.example.com/paid-endpoint');
 * const data = await response.json();
 * ```
 */
export function createX402Handler(config: X402HandlerConfig) {
  const client = new PayBotClient(config);
  const maxAutoPay = config.maxAutoPay ?? '1.00';

  return {
    /**
     * Fetch a URL, automatically handling HTTP 402 Payment Required responses.
     * If the server returns 402 with x402 payment requirements, PayBot pays
     * and retries the request.
     */
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const response = await globalThis.fetch(url, init);

      if (response.status !== 402) {
        return response;
      }

      // Parse 402 response for payment requirements
      const requirements = await parse402Response(response, url);
      if (!requirements) {
        return response; // Can't parse, return original 402
      }

      // Check amount is within auto-pay limit
      const amountUsd = Number(requirements.amount) / 1e6;
      if (amountUsd > Number(maxAutoPay)) {
        throw new Error(
          `x402: Payment of $${amountUsd.toFixed(2)} exceeds auto-pay limit of $${maxAutoPay}`
        );
      }

      // Pay via PayBot
      const result = await client.pay({
        resource: url,
        amount: amountUsd.toFixed(6),
        payTo: requirements.payTo,
        network: config.network,
      });

      // A5 HITL pending pass-through (contract §3.3). The amount was UNDER the
      // client ceiling (the over-ceiling throw above never fired) but the SERVER
      // placed it in the approval band. Return the pending result WITHOUT
      // blocking — blocking up to 15 min inside the middleware would hang the
      // agent's HTTP call. Waiting is opt-in: the caller decides whether to
      // `await client.waitForApproval(approvalId)`. This is DISTINCT from the
      // over-ceiling throw: a server band-decision is not a client ceiling hit.
      if (result.status === 'pending_approval') {
        return new Response(JSON.stringify(result), {
          status: 202, // Accepted — awaiting human approval (not an error).
          headers: {
            'Content-Type': 'application/json',
            'X-Payment-Status': 'pending_approval',
            ...(result.approvalId ? { 'X-Payment-Approval-Id': result.approvalId } : {}),
          },
        });
      }

      if (!result.success) {
        throw new Error(`x402: Payment failed: ${result.error}`);
      }

      // Retry original request with payment proof header
      const retryHeaders = new Headers(init?.headers ?? {});
      retryHeaders.set('X-Payment-Proof', result.txHash ?? '');
      retryHeaders.set('X-Payment-Facilitator', 'paybot');

      return globalThis.fetch(url, {
        ...init,
        headers: retryHeaders,
      });
    },

    /** The underlying PayBotClient instance */
    client,
  };
}

/**
 * Parse an HTTP 402 response to extract payment requirements.
 * Supports JSON body with x402 payment info.
 */
async function parse402Response(
  response: Response,
  _url: string
): Promise<{ amount: string; payTo: string } | null> {
  try {
    const body = await response.json() as Record<string, unknown>;

    // x402 standard format
    if (body.paymentRequirements) {
      const req = body.paymentRequirements as Record<string, unknown>;
      return {
        amount: String(req.amount ?? '0'),
        payTo: String(req.payTo ?? ''),
      };
    }

    // Simplified format
    if (body.amount && body.payTo) {
      return {
        amount: String(body.amount),
        payTo: String(body.payTo),
      };
    }

    // Header-based (x402 spec allows this)
    const headerAmount = response.headers.get('X-Payment-Amount');
    const headerPayTo = response.headers.get('X-Payment-Address');
    if (headerAmount && headerPayTo) {
      return { amount: headerAmount, payTo: headerPayTo };
    }

    return null;
  } catch {
    return null;
  }
}
