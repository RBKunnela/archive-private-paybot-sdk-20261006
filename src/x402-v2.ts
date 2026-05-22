/**
 * x402 v2 Protocol Handler
 *
 * Full x402 v2 implementation with MPP (Machine Payments Protocol) dual-mode compatibility.
 * Supports HTTP 402 Payment Required response handling, Payment-Intent header negotiation,
 * EIP-712 typed data signing, and receipt verification.
 *
 * References:
 * - x402 Foundation Specification v2.0
 * - MPP (Stripe/Tempo) dual-mode protocol
 * - EIP-712 typed structured data
 * - EIP-3009 TransferWithAuthorization
 */

import type {
  PaymentIntent,
  PaymentPayload,
  SignedPayment,
  Receipt,
  PaymentRequiredResponse,
  PaymentRequirements,
} from './types.js';
import { getErrorMessage, PayBotApiError } from './errors.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { generateEIP3009Nonce } from './crypto.js';
import { EIP712_DOMAINS, EIP3009_TYPES } from './networks.js';

/**
 * x402 v2 Handler - Complete protocol implementation
 */
export class X402Handler {
  private walletPrivateKey?: string;

  constructor(walletPrivateKey?: string) {
    if (walletPrivateKey && !walletPrivateKey.startsWith('0x')) {
      throw new Error('X402Handler: walletPrivateKey must start with 0x');
    }
    this.walletPrivateKey = walletPrivateKey;
  }

  /**
   * Parse HTTP 402 Payment Required response
   * Extracts Payment-Intent header and payment requirements
   */
  on402Response(response: PaymentRequiredResponse): PaymentPayload {
    if (response.status !== 402) {
      throw new PayBotApiError(
        `Expected HTTP 402 Payment Required, got ${response.status}`,
        'INVALID_HTTP_STATUS',
        response.status
      );
    }

    const paymentIntentHeader = this.extractPaymentIntentHeader(response.headers);
    const paymentIntent = this.parsePaymentIntent(paymentIntentHeader);

    const body = this.parsePaymentResponseBody(response.body);

    return {
      paymentIntent,
      requirements: body.requirements,
      merchant: body.merchant,
      meta: body.meta,
    };
  }

  /**
   * Extract Payment-Intent header from HTTP headers
   */
  private extractPaymentIntentHeader(headers: Record<string, string>): string {
    const header = headers['Payment-Intent'] || headers['payment-intent'];

    if (!header) {
      throw new PayBotApiError(
        'Payment-Intent header missing from 402 response',
        'MISSING_PAYMENT_INTENT_HEADER',
        402
      );
    }

    return header;
  }

  /**
   * Parse Payment-Intent header (base64 encoded JSON)
   */
  private parsePaymentIntent(headerValue: string): PaymentIntent {
    try {
      // Header format: "x402:v2:{base64_payload}"
      const parts = headerValue.split(':');
      if (parts.length < 3 || parts[0] !== 'x402' || parts[1] !== 'v2') {
        throw new Error('Invalid Payment-Intent header format');
      }

      const payload = parts.slice(2).join(':');
      const decoded = Buffer.from(payload, 'base64').toString('utf-8');

      return JSON.parse(decoded) as PaymentIntent;
    } catch (error) {
      throw new PayBotApiError(
        `Failed to parse Payment-Intent header: ${getErrorMessage(error)}`,
        'INVALID_PAYMENT_INTENT_FORMAT',
        402
      );
    }
  }

  /**
   * Parse payment response body
   */
  private parsePaymentResponseBody(body: unknown): {
    requirements: PaymentIntent['requirements'];
    merchant?: PaymentIntent['merchant'];
    meta?: PaymentIntent['meta'];
  } {
    if (!body || typeof body !== 'object') {
      throw new PayBotApiError(
        'Payment response body missing or invalid',
        'INVALID_PAYMENT_BODY',
        402
      );
    }

    const data = body as Record<string, unknown>;

    if (!data.requirements || typeof data.requirements !== 'object') {
      throw new PayBotApiError(
        'Payment requirements missing from response body',
        'MISSING_PAYMENT_REQUIREMENTS',
        402
      );
    }

    return {
      requirements: data.requirements as PaymentIntent['requirements'],
      merchant: data.merchant as PaymentIntent['merchant'] | undefined,
      meta: data.meta as PaymentIntent['meta'] | undefined,
    };
  }

  /**
   * Sign an x402 native EIP-3009 `TransferWithAuthorization` for the given
   * `PaymentRequirements` and signing `account`.
   *
   * Produces a signature byte-for-byte equivalent to the pre-refactor
   * `protocol === 'x402'` branch (Story 14 verbatim-migration guarantee —
   * regression-guarded by `tests/x402-v2.test.ts` Test #13).
   *
   * @param account - viem `PrivateKeyAccount` derived from the handler's wallet private key.
   * @param requirements - Payment requirements (network, amount, payTo).
   * @returns Object with the EIP-712 `signature` and an x402-shaped `signedData`
   *          containing `{ from, to, value, validAfter, validBefore, nonce, signature }`.
   * @throws {PayBotApiError} with code `UNSUPPORTED_NETWORK` (HTTP 402) if the
   *          requested network has no registered EIP-712 domain.
   *
   * @example
   *   const r = await this.signX402(account, requirements);
   *   r.signature;  // '0x...130 hex chars'
   *   r.signedData; // { from, to, value, validAfter, validBefore, nonce, signature }
   */
  private async signX402(
    account: PrivateKeyAccount,
    requirements: PaymentRequirements,
  ): Promise<{ signature: string; signedData: Record<string, unknown> }> {
    // x402 native signing (EIP-3009 TransferWithAuthorization)
    const network = requirements.network || 'eip155:8453';
    const domain = EIP712_DOMAINS[network];

    if (!domain) {
      throw new PayBotApiError(
        `No EIP-712 domain for network: ${network}`,
        'UNSUPPORTED_NETWORK',
        402
      );
    }

    const nonce = generateEIP3009Nonce();
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = BigInt(0);
    const validBefore = nowSeconds + BigInt(3600); // 1 hour from now

    const value = BigInt(requirements.amount);

    const signature = await account.signTypedData({
      domain,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: account.address,
        to: requirements.payTo as `0x${string}`,
        value,
        validAfter,
        validBefore,
        nonce,
      },
    });

    const signedData: Record<string, unknown> = {
      from: account.address,
      to: requirements.payTo,
      value: requirements.amount,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      signature,
    };

    return { signature, signedData };
  }

  /**
   * Sign an MPP (Machine Payments Protocol — Stripe/Tempo) `PaymentAuthorization`
   * for the given `PaymentRequirements` and signing `account`.
   *
   * Produces a signature byte-for-byte equivalent to the pre-refactor
   * `protocol === 'mpp'` branch. The typed-data structure (`PaymentAuthorization`)
   * differs from x402's EIP-3009 `TransferWithAuthorization`, so the resulting
   * signature MUST differ from `signX402`'s for the same inputs.
   *
   * @param account - viem `PrivateKeyAccount` derived from the handler's wallet private key.
   * @param requirements - Payment requirements (amount, payTo). Network not used in MPP domain.
   * @param intentId - Optional payment-intent identifier. Falsy values fall back to the
   *                   string `'unknown'` inside the signed message (gracefully handled,
   *                   never throws).
   * @returns Object with the EIP-712 `signature` and an MPP-shaped `signedData`
   *          containing `{ payer, recipient, amount, nonce, expires, paymentIntent, signature }`.
   *
   * @example
   *   const r = await this.signMPP(account, requirements, 'intent_abc');
   *   r.signature;  // '0x...130 hex chars' — differs from signX402 output
   */
  private async signMPP(
    account: PrivateKeyAccount,
    requirements: PaymentRequirements,
    intentId: string | undefined,
  ): Promise<{ signature: string; signedData: Record<string, unknown> }> {
    // MPP (Stripe/Tempo) compatibility mode
    // Uses different typed data structure
    const domain = {
      name: 'Machine Payments Protocol',
      version: '1.0',
      chainId: 1, // Ethereum mainnet
      verifyingContract: requirements.payTo as `0x${string}`,
    };

    const nonce = generateEIP3009Nonce();
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

    const signature = await account.signTypedData({
      domain,
      types: {
        PaymentAuthorization: [
          { name: 'payer', type: 'address' },
          { name: 'recipient', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'expires', type: 'uint256' },
          { name: 'paymentIntent', type: 'string' },
        ],
      },
      primaryType: 'PaymentAuthorization',
      message: {
        payer: account.address,
        recipient: requirements.payTo as `0x${string}`,
        amount: BigInt(requirements.amount),
        nonce,
        expires: nowSeconds + BigInt(3600),
        paymentIntent: intentId || 'unknown',
      },
    });

    const signedData: Record<string, unknown> = {
      payer: account.address,
      recipient: requirements.payTo,
      amount: requirements.amount,
      nonce,
      expires: nowSeconds.toString(),
      paymentIntent: intentId,
      signature,
    };

    return { signature, signedData };
  }

  /**
   * Sign a payment payload using EIP-712 typed data.
   *
   * Dispatches to the protocol-specific helper:
   *   - `x402` → `signX402` only (EIP-3009 TransferWithAuthorization)
   *   - `mpp`  → `signMPP`  only (MPP PaymentAuthorization)
   *   - `dual` → BOTH `signX402` AND `signMPP`; `signedData` is packed as
   *              `{ x402: <x402-signedData>, mpp: <mpp-signedData> }` and the
   *              top-level `signature` is the x402 signature (primary, for
   *              legacy compatibility).
   *
   * Story 14 (Option C refactor) replaced the pre-existing if/else-if chain
   * — whose `else if (protocol === 'dual')` arm was unreachable dead code —
   * with this `switch` dispatcher. The new dual case calls both helpers and
   * packs the result, so dual-mode now produces a REAL MPP cryptographic
   * signature, not inert `mppFormat` metadata.
   *
   * @param payload - Parsed `PaymentPayload` from an HTTP 402 response.
   * @returns A `SignedPayment` with `protocol`, `signedData`, `signature`,
   *          and `timestamp` populated.
   * @throws {PayBotApiError}
   *   - `MISSING_WALLET_KEY` (HTTP 402) if no wallet private key was configured.
   *   - `UNSUPPORTED_NETWORK` (HTTP 402) if the requirements specify a network
   *     with no registered EIP-712 domain (bubbled from `signX402`).
   *   - `UNSUPPORTED_PROTOCOL` (HTTP 402) for any protocol outside
   *     `'x402' | 'mpp' | 'dual'`.
   *
   * @example
   *   // dual-mode result shape:
   *   const signed = await handler.signPayment(dualPayload);
   *   signed.protocol;                 // 'dual'
   *   signed.signature;                // x402 signature (primary)
   *   signed.signedData.x402;          // full x402 signed payload
   *   signed.signedData.mpp;           // full MPP signed payload
   *   signed.signedData.mpp.signature; // real EIP-712 MPP signature (not metadata)
   */
  async signPayment(payload: PaymentPayload): Promise<SignedPayment> {
    if (!this.walletPrivateKey) {
      throw new PayBotApiError(
        'Wallet private key required for signing payments',
        'MISSING_WALLET_KEY',
        402
      );
    }

    const account = privateKeyToAccount(this.walletPrivateKey as `0x${string}`);
    const requirements = payload.paymentIntent.requirements;
    const protocol = payload.paymentIntent.protocol;

    let signature: string;
    let signedData: Record<string, unknown>;

    switch (protocol) {
      case 'x402': {
        const r = await this.signX402(account, requirements);
        signature = r.signature;
        signedData = r.signedData;
        break;
      }
      case 'mpp': {
        const r = await this.signMPP(
          account,
          requirements,
          payload.paymentIntent.intentId,
        );
        signature = r.signature;
        signedData = r.signedData;
        break;
      }
      case 'dual': {
        // WHY: dual-mode must produce BOTH a real EIP-3009 x402 signature
        // AND a real MPP PaymentAuthorization signature. We expose them as
        // a discriminated bag under `signedData = { x402, mpp }` so callers
        // can submit to either protocol's endpoint without re-signing. The
        // top-level `signature` mirrors the x402 signature for legacy
        // consumers that expect a single primary string field.
        const x = await this.signX402(account, requirements);
        const m = await this.signMPP(
          account,
          requirements,
          payload.paymentIntent.intentId,
        );
        signature = x.signature; // primary signature = x402
        signedData = { x402: x.signedData, mpp: m.signedData };
        break;
      }
      default:
        throw new PayBotApiError(
          `Unsupported payment protocol: ${protocol}`,
          'UNSUPPORTED_PROTOCOL',
          402
        );
    }

    return {
      protocol,
      signedData,
      signature,
      timestamp: Date.now(),
    };
  }

  /**
   * Submit signed payment to the payment endpoint
   */
  async submitPayment(
    signed: SignedPayment,
    paymentEndpoint: string,
    authToken?: string
  ): Promise<Receipt> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    // Add Payment-Intent-Authorization header
    headers['Payment-Intent-Authorization'] = this.encodeSignedPayment(signed);

    try {
      const response = await fetch(paymentEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          protocol: signed.protocol,
          ...signed.signedData,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new PayBotApiError(
          (errorData.error as string) ?? `HTTP ${response.status}`,
          (errorData.code as string) ?? 'PAYMENT_SUBMISSION_FAILED',
          response.status,
          errorData.details as Record<string, unknown> | undefined
        );
      }

      const receipt = (await response.json()) as Record<string, unknown>;

      return {
        receiptId: receipt.receiptId as string,
        transactionId: receipt.transactionId as string | undefined,
        status: receipt.status as 'pending' | 'confirmed' | 'failed',
        confirmedAt: receipt.confirmedAt ? new Date(receipt.confirmedAt as string) : undefined,
        amount: receipt.amount as string,
        network: receipt.network as string,
        blockNumber: receipt.blockNumber as number | undefined,
        gasUsed: receipt.gasUsed as string | undefined,
      };
    } catch (error) {
      if (error instanceof PayBotApiError) {
        throw error;
      }
      throw new PayBotApiError(
        `Failed to submit payment: ${getErrorMessage(error)}`,
        'PAYMENT_SUBMISSION_ERROR',
        0
      );
    }
  }

  /**
   * Encode signed payment for Payment-Intent-Authorization header
   */
  private encodeSignedPayment(signed: SignedPayment): string {
    const payload = JSON.stringify({
      protocol: signed.protocol,
      signedData: signed.signedData,
      signature: signed.signature,
      timestamp: signed.timestamp,
    });

    return `x402:v2:${Buffer.from(payload).toString('base64')}`;
  }

  /**
   * Verify payment receipt with merchant
   * Confirms payment was processed and service can be delivered
   */
  async verifyReceipt(receipt: Receipt, verificationEndpoint: string): Promise<boolean> {
    try {
      const response = await fetch(verificationEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receiptId: receipt.receiptId,
          transactionId: receipt.transactionId,
        }),
      });

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as Record<string, unknown>;
      return data.verified === true;
    } catch {
      return false;
    }
  }

  /**
   * Create Payment-Intent header for merchant endpoints
   * Used when acting as the payment receiver (selling services)
   */
  static createPaymentIntentHeader(intent: PaymentIntent): string {
    const payload = JSON.stringify(intent);
    const encoded = Buffer.from(payload).toString('base64');
    return `x402:v2:${encoded}`;
  }

  /**
   * Negotiate payment parameters with merchant
   * Automatically selects best payment rail and protocol
   */
  static negotiatePaymentIntent(
    requirements: PaymentRequirements,
    _supportedProtocols: ('x402' | 'mpp' | 'dual')[] = ['x402', 'mpp']
  ): PaymentIntent {
    // Select protocol - default to dual-mode for compatibility
    // TODO: honor `_supportedProtocols` once negotiation policy is finalized.
    const protocol = 'dual';

    return {
      intentId: `intent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      protocol: protocol as 'x402' | 'mpp' | 'dual',
      requirements,
      version: '2.0',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(), // 5 minutes
    };
  }
}