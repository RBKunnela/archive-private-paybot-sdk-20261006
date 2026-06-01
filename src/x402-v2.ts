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
  PaymentResponseConfirmation,
} from './types.js';
import { getErrorMessage, PayBotApiError } from './errors.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { generateEIP3009Nonce } from './crypto.js';
import { EIP3009_TYPES, parseCaip2, getEip712Domain, getToken } from './networks.js';

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

    // x402 v2 renamed the negotiation header to PAYMENT-REQUIRED (base64 of the
    // requirements). Prefer it when present; otherwise fall back to the legacy
    // `Payment-Intent` (`x402:v2:<base64>`) path so existing servers/tests keep
    // working. This is purely additive.
    const v2Header = X402Handler.readHeaderCaseInsensitive(
      response.headers,
      'PAYMENT-REQUIRED',
    );
    if (v2Header) {
      const paymentIntent = this.parsePaymentRequiredHeader(v2Header);
      const body = this.parsePaymentResponseBody(response.body);
      return {
        paymentIntent,
        requirements: body.requirements,
        merchant: body.merchant,
        meta: body.meta,
      };
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
   * Read a header value by name, case-insensitively, from a plain headers
   * record. Returns `undefined` when no casing variant is present.
   *
   * @param headers - The HTTP headers record.
   * @param name - The canonical header name (e.g. `'PAYMENT-REQUIRED'`).
   * @returns The header value, or `undefined`.
   */
  private static readHeaderCaseInsensitive(
    headers: Record<string, string>,
    name: string,
  ): string | undefined {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === target) {
        return headers[key];
      }
    }
    return undefined;
  }

  /**
   * Parse an x402 v2 `PAYMENT-REQUIRED` header. The value is the base64 of the
   * JSON payment requirements (no `x402:v2:` prefix — that prefix is the legacy
   * `Payment-Intent` format). The decoded JSON may be either a full
   * `PaymentIntent` or a bare `PaymentRequirements`; in the latter case we wrap
   * it into a minimal `PaymentIntent` so downstream code sees a uniform shape.
   *
   * @param headerValue - The base64-encoded header value.
   * @returns A `PaymentIntent`.
   * @throws {PayBotApiError} `INVALID_PAYMENT_INTENT_FORMAT` (HTTP 402) on bad base64/JSON.
   */
  private parsePaymentRequiredHeader(headerValue: string): PaymentIntent {
    try {
      const decoded = Buffer.from(headerValue, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded) as Record<string, unknown>;

      // Full PaymentIntent? (has its own requirements) — use as-is.
      if (parsed.requirements && typeof parsed.requirements === 'object') {
        return parsed as unknown as PaymentIntent;
      }

      // Otherwise treat the payload itself as bare PaymentRequirements and
      // synthesize a minimal v2 PaymentIntent envelope around it.
      const now = new Date();
      return {
        intentId: `intent_${now.getTime()}`,
        protocol: 'x402',
        requirements: parsed as unknown as PaymentIntent['requirements'],
        version: '2.0',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      };
    } catch (error) {
      throw new PayBotApiError(
        `Failed to parse PAYMENT-REQUIRED header: ${getErrorMessage(error)}`,
        'INVALID_PAYMENT_INTENT_FORMAT',
        402,
      );
    }
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
  /**
   * Resolve the EIP-712 domain for a requirements' network, validating the
   * CAIP-2 shape first.
   *
   * The domain is token-specific: it resolves through {@link getEip712Domain}
   * using `requirements.token` (default `'USDC'`), so EURC payments sign under
   * the EURC contract/name while USDC payments remain byte-identical to before.
   *
   * Three distinct failure modes are surfaced:
   *   - A malformed CAIP-2 string (e.g. `'not-a-network'`, `'solana:foo'`) →
   *     `INVALID_CAIP2` (bubbled from {@link parseCaip2}).
   *   - An unknown token symbol → `UNSUPPORTED_TOKEN` (402).
   *   - A well-formed `eip155:<chainId>` with no registered domain for the token
   *     (e.g. `'eip155:999999'`) → `UNSUPPORTED_NETWORK` (preserves the
   *     historical behavior the regression tests lock in).
   *
   * @param requirements - Payment requirements carrying the `network` and optional `token`.
   * @returns The resolved EIP-712 domain.
   * @throws {PayBotApiError} `INVALID_CAIP2` (400), `UNSUPPORTED_TOKEN` (402),
   *          or `UNSUPPORTED_NETWORK` (402).
   */
  private resolveDomain(
    requirements: PaymentRequirements,
  ): { name: string; version: string; chainId: number; verifyingContract: `0x${string}` } {
    const network = requirements.network || 'eip155:8453';
    const symbol = requirements.token ?? 'USDC';

    // Throws INVALID_CAIP2 for malformed network strings.
    parseCaip2(network);

    // Distinguish an unknown token from an unsupported network so callers get a
    // precise error code (mirrors the UNSUPPORTED_NETWORK pattern).
    if (!getToken(symbol)) {
      throw new PayBotApiError(
        `Unsupported token: ${symbol}`,
        'UNSUPPORTED_TOKEN',
        402,
      );
    }

    const domain = getEip712Domain(network, symbol);
    if (!domain) {
      throw new PayBotApiError(
        `No EIP-712 domain for network: ${network}`,
        'UNSUPPORTED_NETWORK',
        402,
      );
    }
    return domain;
  }

  private async signX402(
    account: PrivateKeyAccount,
    requirements: PaymentRequirements,
  ): Promise<{ signature: string; signedData: Record<string, unknown> }> {
    // x402 native signing (EIP-3009 TransferWithAuthorization)
    const domain = this.resolveDomain(requirements);

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
   * Sign an x402 v2 `upto` (metered / usage-billing) authorization.
   *
   * The `upto` scheme is x402 v2's answer to streaming: instead of charging a
   * fixed amount, the payer signs an EIP-3009 `TransferWithAuthorization` for
   * the MAXIMUM amount, authorizing the merchant to capture UP TO that max as
   * usage accrues. The capped maximum is `requirements.maxAmount` when present,
   * otherwise it falls back to `requirements.amount`.
   *
   * The signed `value` equals the authorized max (NOT the eventual capture).
   * The returned `signedData` carries `scheme: 'upto'` and a `maxAmount` marker
   * so a caller can tell this is a capped authorization, not an exact charge.
   *
   * @param account - viem `PrivateKeyAccount` derived from the handler's wallet private key.
   * @param requirements - Payment requirements. `maxAmount` (else `amount`) is the cap.
   * @returns Object with the EIP-712 `signature` and an upto-shaped `signedData`
   *          containing `{ from, to, value, maxAmount, scheme: 'upto',
   *          validAfter, validBefore, nonce, signature }`.
   * @throws {PayBotApiError} `INVALID_CAIP2` (HTTP 400) when the network string
   *          is not a well-formed `eip155:<chainId>`.
   * @throws {PayBotApiError} `UNSUPPORTED_NETWORK` (HTTP 402) when the network
   *          is well-formed but has no registered EIP-712 domain.
   *
   * @example
   *   const r = await handler.signUpto(account, { ...reqs, scheme: 'upto', maxAmount: '5000000' });
   *   r.signedData.value;     // '5000000' — signs for the MAX
   *   r.signedData.scheme;    // 'upto'
   *   r.signedData.maxAmount; // '5000000'
   */
  async signUpto(
    account: PrivateKeyAccount,
    requirements: PaymentRequirements,
  ): Promise<{ signature: string; signedData: Record<string, unknown> }> {
    const domain = this.resolveDomain(requirements);

    // WHY: `upto` authorizes the MAX, not the requested amount. The cap is
    // `maxAmount` when the merchant specified one, else the plain `amount`.
    const authorizedMax = requirements.maxAmount ?? requirements.amount;

    const nonce = generateEIP3009Nonce();
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = BigInt(0);
    const validBefore = nowSeconds + BigInt(3600); // 1 hour from now

    const value = BigInt(authorizedMax);

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
      value: authorizedMax,
      // Markers so the caller knows this is a capped authorization.
      scheme: 'upto',
      maxAmount: authorizedMax,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      signature,
    };

    return { signature, signedData };
  }

  /**
   * Validate that a captured amount does not exceed the authorized maximum of
   * an `upto` authorization.
   *
   * Amounts are base-unit decimal strings (USDC has 6 decimals); comparison is
   * done with `BigInt` to avoid float rounding. A capture exactly equal to the
   * max is allowed; anything greater is an overcharge.
   *
   * @param authorizedMax - The signed maximum (base-unit decimal string).
   * @param captured - The amount the merchant wants to capture (base-unit decimal string).
   * @returns The captured amount as a normalized base-unit string when valid.
   * @throws {PayBotApiError} `UPTO_OVERCHARGE` (HTTP 402) when `captured > authorizedMax`.
   * @throws {PayBotApiError} `INVALID_AMOUNT` (HTTP 400) when either value is not a
   *          non-negative integer string.
   *
   * @example
   *   X402Handler.validateUptoCapture('5000000', '3000000'); // '3000000'
   *   X402Handler.validateUptoCapture('5000000', '6000000'); // throws UPTO_OVERCHARGE
   */
  static validateUptoCapture(authorizedMax: string, captured: string): string {
    const max = X402Handler.parseBaseUnitAmount(authorizedMax, 'authorizedMax');
    const cap = X402Handler.parseBaseUnitAmount(captured, 'captured');

    if (cap > max) {
      throw new PayBotApiError(
        `upto capture ${captured} exceeds authorized max ${authorizedMax}`,
        'UPTO_OVERCHARGE',
        402,
        { authorizedMax, captured },
      );
    }

    return cap.toString();
  }

  /**
   * Parse a base-unit amount (non-negative integer decimal string) into a
   * `BigInt`, throwing a typed error on malformed input.
   *
   * @param value - The candidate amount string.
   * @param label - Field name for error messages.
   * @returns The parsed `BigInt`.
   * @throws {PayBotApiError} `INVALID_AMOUNT` (HTTP 400) when not a non-negative integer.
   */
  private static parseBaseUnitAmount(value: string, label: string): bigint {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw new PayBotApiError(
        `Invalid ${label}: expected a non-negative integer string, got '${value}'`,
        'INVALID_AMOUNT',
        400,
        { [label]: value },
      );
    }
    return BigInt(value);
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

    // x402 v2 `upto` (metered/usage) scheme is dispatched on the scheme, not
    // the protocol: it signs an EIP-3009 authorization for the MAXIMUM amount.
    // This is additive — existing payloads carry scheme 'exact'/'max'/'range'
    // and fall through to the protocol switch below unchanged.
    if (requirements.scheme === 'upto') {
      const r = await this.signUpto(account, requirements);
      return {
        protocol,
        signedData: r.signedData,
        signature: r.signature,
        timestamp: Date.now(),
      };
    }

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

    // Add Payment-Intent-Authorization header (legacy) + the x402 v2
    // PAYMENT-SIGNATURE header (base64 of the signed payload). Both are sent so
    // v1 and v2 facilitators can each read the form they expect — additive.
    const encoded = this.encodeSignedPayment(signed);
    headers['Payment-Intent-Authorization'] = encoded;
    headers['PAYMENT-SIGNATURE'] = X402Handler.encodePaymentSignatureHeader(signed);

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
   * Encode a signed payment for the x402 v2 `PAYMENT-SIGNATURE` header.
   *
   * Unlike {@link encodeSignedPayment} (which prefixes `x402:v2:` for the legacy
   * `Payment-Intent-Authorization` header), the v2 spec header value is the bare
   * base64 of the signed payload JSON — no prefix.
   *
   * @param signed - The signed payment to encode.
   * @returns Base64 of the signed-payload JSON.
   */
  static encodePaymentSignatureHeader(signed: SignedPayment): string {
    const payload = JSON.stringify({
      protocol: signed.protocol,
      signedData: signed.signedData,
      signature: signed.signature,
      timestamp: signed.timestamp,
    });
    return Buffer.from(payload).toString('base64');
  }

  /**
   * Parse an x402 v2 `PAYMENT-RESPONSE` header into a settlement confirmation.
   *
   * The v2 spec returns settlement results in a `PAYMENT-RESPONSE` header whose
   * value is base64-encoded JSON. This helper decodes it and projects the
   * receipt-relevant fields (`receiptId`, `status`, optional `transactionId`).
   *
   * Tolerant of common field-name variants seen across facilitators
   * (`receiptId`/`receipt_id`, `transactionId`/`transaction_id`/`txHash`).
   *
   * @param headerValue - The base64-encoded `PAYMENT-RESPONSE` header value.
   * @returns A {@link PaymentResponseConfirmation}.
   * @throws {PayBotApiError} `INVALID_PAYMENT_RESPONSE` (HTTP 502) when the
   *          header is not valid base64 JSON or lacks a `receiptId`.
   *
   * @example
   *   const b64 = Buffer.from(JSON.stringify({ receiptId: 'r1', status: 'confirmed' })).toString('base64');
   *   X402Handler.parsePaymentResponseHeader(b64); // { receiptId: 'r1', status: 'confirmed' }
   */
  static parsePaymentResponseHeader(
    headerValue: string,
  ): PaymentResponseConfirmation {
    let parsed: Record<string, unknown>;
    try {
      const decoded = Buffer.from(headerValue, 'base64').toString('utf-8');
      parsed = JSON.parse(decoded) as Record<string, unknown>;
    } catch (error) {
      throw new PayBotApiError(
        `Failed to parse PAYMENT-RESPONSE header: ${getErrorMessage(error)}`,
        'INVALID_PAYMENT_RESPONSE',
        502,
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new PayBotApiError(
        'PAYMENT-RESPONSE header did not decode to an object',
        'INVALID_PAYMENT_RESPONSE',
        502,
      );
    }

    const receiptId = (parsed.receiptId ?? parsed.receipt_id) as
      | string
      | undefined;
    if (typeof receiptId !== 'string' || receiptId.length === 0) {
      throw new PayBotApiError(
        'PAYMENT-RESPONSE header missing receiptId',
        'INVALID_PAYMENT_RESPONSE',
        502,
      );
    }

    const rawStatus = (parsed.status as string | undefined) ?? 'pending';
    const status: PaymentResponseConfirmation['status'] =
      rawStatus === 'confirmed' || rawStatus === 'failed' ? rawStatus : 'pending';

    const transactionId = (parsed.transactionId ??
      parsed.transaction_id ??
      parsed.txHash) as string | undefined;

    return {
      receiptId,
      status,
      ...(transactionId ? { transactionId } : {}),
    };
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