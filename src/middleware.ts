/**
 * paybot402() — Express/Connect/Fastify middleware that gates any endpoint
 * behind an x402 payment wall.
 *
 * Usage:
 * ```typescript
 * import express from 'express';
 * import { paybot402 } from 'paybot-sdk';
 *
 * const app = express();
 * app.get('/api/data', paybot402({ payTo: '0xYourWallet', amount: '1000000' }), handler);
 * ```
 *
 * When a request arrives WITHOUT an `x-payment-response` header the middleware
 * returns HTTP 402 with the x402 payment requirements JSON so the caller knows
 * how much to pay and where.  When the header IS present the middleware calls
 * `next()` and the real handler runs normally.
 */

import { NETWORKS } from './networks.js';

/** Configuration for the paybot402 middleware. */
export interface Paybot402Config {
  /** Merchant wallet address to receive payment */
  payTo: string;
  /**
   * Payment amount in USDC base units (6 decimals).
   * e.g. "1000000" = $1.00 USDC
   */
  amount: string;
  /** PayBot facilitator URL (default: https://api.paybotcore.com) */
  facilitatorUrl?: string;
  /** CAIP-2 network identifier (default: eip155:84532 Base Sepolia) */
  network?: string;
  /**
   * Full CAIP-19 asset identifier.
   * Defaults to USDC on the chosen network.
   */
  asset?: string;
  /** Max seconds a payment proof is valid (default: 300) */
  maxTimeoutSeconds?: number;
}

/**
 * Minimal Connect-compatible request/response/next types so we do not need
 * @types/express as a runtime or devDependency.
 */
interface IncomingMessage {
  headers: Record<string, string | string[] | undefined>;
}

interface ServerResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

type NextFunction = (err?: unknown) => void;

type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFunction
) => void;

/** x402 "accepts" entry shape */
interface X402Accept {
  scheme: 'exact';
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

/** Full x402 402 response body */
interface X402Response {
  x402Version: 1;
  accepts: X402Accept[];
  facilitatorUrl: string;
}

/**
 * Create an x402 payment-wall middleware.
 *
 * Returns HTTP 402 with x402-compatible JSON when no payment proof is present.
 * Calls next() when the `x-payment-response` header is present.
 */
export function paybot402(config: Paybot402Config): ConnectMiddleware {
  const network = config.network ?? 'eip155:84532';
  const networkConfig = NETWORKS[network];
  const usdcAddress = networkConfig?.usdcAddress ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const asset = config.asset ?? `${network}/erc20:${usdcAddress}`;
  const facilitatorUrl = config.facilitatorUrl ?? 'https://api.paybotcore.com';
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 300;

  const body: X402Response = {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network,
        asset,
        amount: config.amount,
        payTo: config.payTo,
        maxTimeoutSeconds,
      },
    ],
    facilitatorUrl,
  };

  const bodyJson = JSON.stringify(body);

  return function x402Middleware(req, res, next) {
    const paymentHeader = req.headers['x-payment-response'];
    if (paymentHeader !== undefined && paymentHeader !== '') {
      return next();
    }

    res.writeHead(402, {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyJson)),
    });
    res.end(bodyJson);
  };
}
