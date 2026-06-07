/**
 * @module ap2
 *
 * AP2 (Google Agent Payments Protocol) → x402 settlement adapter.
 *
 * AP2 sits ABOVE x402 as an orchestration layer: it issues Intent / Cart /
 * Payment **Mandates** as verifiable credentials (VCs), and the A2A x402
 * extension lets an AP2 Payment Mandate authorize an x402 USDC/EURC settlement.
 *
 * paybot is the **settlement layer**, NOT the mandate issuer. This module
 * therefore consumes the minimal slice of the AP2 Payment Mandate we need to
 * settle, and translates it into the x402 {@link PaymentRequirements} our
 * {@link X402Handler} already knows how to sign and submit.
 *
 * TRUST BOUNDARY (read carefully):
 *   This adapter does **NOT** verify the AP2 verifiable-credential signature
 *   (`Ap2PaymentMandate.signature`). VC issuance and verification live in the
 *   mandate issuer's trust domain (the AP2 orchestrator / wallet). We treat the
 *   signature as opaque. A caller that needs cryptographic assurance the mandate
 *   is authentic MUST verify the VC out-of-band before handing it to
 *   {@link Ap2Adapter.settle}. {@link Ap2Adapter.validateMandate} only checks
 *   structural completeness and expiry — it is NOT an authenticity check.
 *
 * Dependencies: ./x402-v2 (X402Handler), ./networks (token registry), ./errors.
 * Used by: bot developers integrating AP2-issued mandates with paybot settlement.
 */

import type { X402Handler } from './x402-v2.js';
import type {
  PaymentRequirements,
  PaymentPayload,
  PaymentIntent,
  Receipt,
} from './types.js';
import { PayBotApiError } from './errors.js';
import { getToken, getTokenAddress } from './networks.js';

/**
 * The minimal AP2 Payment Mandate surface paybot consumes as the settlement
 * layer. The full AP2 mandate VC carries far more (issuer, proof, holder, cart
 * line-items, etc.); we deliberately model only the fields required to derive an
 * x402 settlement. Fields we do not act on (e.g. `cartHash`, `signature`) are
 * carried through opaquely.
 */
export interface Ap2PaymentMandate {
  /** Unique mandate identifier (the VC id, or a stable mandate reference). */
  mandateId: string;
  /** Optional id of the upstream Intent Mandate this payment fulfills. */
  intentId?: string;
  /** Payer account / wallet address (the agent authorizing the spend). */
  payer: string;
  /** Payee account / wallet address (settlement recipient). */
  payee: string;
  /** Amount in base units (token's smallest unit; USDC/EURC use 6 decimals). */
  amount: string;
  /** Token ticker symbol to settle in (e.g. `'USDC'`, `'EURC'`). */
  currency: string;
  /** Settlement network as a CAIP-2 identifier (e.g. `'eip155:8453'`). */
  network: string;
  /** Optional ISO-8601 expiry; a past value makes the mandate invalid. */
  expiresAt?: string;
  /** Optional hash of the associated AP2 Cart Mandate (opaque to us). */
  cartHash?: string;
  /** Opaque AP2 VC signature. NOT verified here — see module trust boundary. */
  signature?: string;
}

/** Default x402 settlement timeout (seconds) when the mandate has no expiry. */
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

/**
 * Derive `maxTimeoutSeconds` from an optional ISO-8601 `expiresAt`.
 *
 * Returns the whole seconds from "now" until `expiresAt`. When `expiresAt` is
 * absent, unparseable, or already in the past, falls back to
 * {@link DEFAULT_MAX_TIMEOUT_SECONDS} (we never return a non-positive timeout).
 *
 * @param expiresAt - Optional ISO-8601 timestamp.
 * @param nowMs - Current epoch ms (injectable for deterministic tests).
 * @returns A positive integer number of seconds.
 */
export function deriveMaxTimeoutSeconds(
  expiresAt: string | undefined,
  nowMs: number = Date.now(),
): number {
  if (!expiresAt) {
    return DEFAULT_MAX_TIMEOUT_SECONDS;
  }
  const expMs = Date.parse(expiresAt);
  if (Number.isNaN(expMs)) {
    return DEFAULT_MAX_TIMEOUT_SECONDS;
  }
  // Round UP so any positive remaining window survives (CodeRabbit #1).
  // Math.floor mapped sub-second windows (e.g. 500ms) to 0, which then fell
  // through to the 300s default — silently granting far more time than the
  // mandate allowed. ceil keeps any positive remaining as at least 1 second.
  const seconds = Math.ceil((expMs - nowMs) / 1000);
  return seconds > 0 ? seconds : DEFAULT_MAX_TIMEOUT_SECONDS;
}

/** Required string fields a mandate MUST carry to be settleable. */
const REQUIRED_MANDATE_FIELDS = [
  'mandateId',
  'payer',
  'payee',
  'amount',
  'currency',
  'network',
] as const;

/**
 * Identify which required fields are missing/blank on a candidate mandate.
 *
 * @param mandate - The mandate to inspect.
 * @returns An array of missing field names (empty when all present).
 */
function missingRequiredFields(mandate: Ap2PaymentMandate): string[] {
  return REQUIRED_MANDATE_FIELDS.filter((field) => {
    const value = mandate[field];
    return typeof value !== 'string' || value.length === 0;
  });
}

/**
 * Translate an AP2 Payment Mandate into an x402 {@link PaymentRequirements}.
 *
 * The mandate's `currency` symbol + `network` resolve the on-chain `asset`
 * address via the token registry. The resulting requirements use scheme
 * `'exact'`, `payTo = mandate.payee`, `token = mandate.currency`, and a
 * `maxTimeoutSeconds` derived from `expiresAt` (else a 300s default).
 *
 * This does NOT verify the AP2 VC signature (see module trust boundary).
 *
 * @param mandate - The AP2 Payment Mandate to translate.
 * @returns An x402 {@link PaymentRequirements} ready for {@link X402Handler}.
 * @throws {PayBotApiError} `INVALID_AP2_MANDATE` (HTTP 400) when a required
 *          field is missing/blank.
 * @throws {PayBotApiError} `UNSUPPORTED_TOKEN` (HTTP 400) when `currency` is not
 *          in the token registry.
 * @throws {PayBotApiError} `UNSUPPORTED_NETWORK` (HTTP 400) when the token is
 *          known but not deployed on `network` (no resolvable asset address).
 *
 * @example
 *   const reqs = ap2MandateToPaymentRequirements({
 *     mandateId: 'm1', payer: '0xaaa', payee: '0xbbb',
 *     amount: '1000000', currency: 'USDC', network: 'eip155:8453',
 *   });
 *   reqs.scheme; // 'exact'
 *   reqs.token;  // 'USDC'
 */
export function ap2MandateToPaymentRequirements(
  mandate: Ap2PaymentMandate,
): PaymentRequirements {
  const missing = missingRequiredFields(mandate);
  if (missing.length > 0) {
    throw new PayBotApiError(
      `AP2 mandate missing required field(s): ${missing.join(', ')}`,
      'INVALID_AP2_MANDATE',
      400,
      { missing },
    );
  }

  const { currency, network } = mandate;

  // Unknown token symbol → precise UNSUPPORTED_TOKEN (mirror X402Handler).
  if (!getToken(currency)) {
    throw new PayBotApiError(
      `Unsupported token: ${currency}`,
      'UNSUPPORTED_TOKEN',
      400,
      { currency },
    );
  }

  // Known token but not deployed on this network → UNSUPPORTED_NETWORK.
  const asset = getTokenAddress(currency, network);
  if (!asset) {
    throw new PayBotApiError(
      `Token ${currency} is not available on network: ${network}`,
      'UNSUPPORTED_NETWORK',
      400,
      { currency, network },
    );
  }

  return {
    scheme: 'exact',
    network,
    // CAIP-19-style asset id: <caip2>/erc20:<address>.
    asset: `${network}/erc20:${asset}`,
    amount: mandate.amount,
    payTo: mandate.payee,
    maxTimeoutSeconds: deriveMaxTimeoutSeconds(mandate.expiresAt),
    token: currency,
  };
}

/**
 * Structural type guard for {@link Ap2PaymentMandate}.
 *
 * Checks that `x` is an object with the required string fields present. Does NOT
 * validate field semantics (address format, expiry, VC signature) — use
 * {@link Ap2Adapter.validateMandate} for expiry/completeness checks.
 *
 * @param x - The value to test.
 * @returns `true` if `x` structurally matches an {@link Ap2PaymentMandate}.
 *
 * @example
 *   isAp2Mandate({ mandateId: 'm', payer: 'a', payee: 'b', amount: '1',
 *                  currency: 'USDC', network: 'eip155:8453' }); // true
 *   isAp2Mandate({ payer: 'a' }); // false
 */
export function isAp2Mandate(x: unknown): x is Ap2PaymentMandate {
  if (typeof x !== 'object' || x === null) {
    return false;
  }
  const candidate = x as Record<string, unknown>;
  return REQUIRED_MANDATE_FIELDS.every(
    (field) =>
      typeof candidate[field] === 'string' &&
      (candidate[field] as string).length > 0,
  );
}

/**
 * Settlement-time options for {@link Ap2Adapter.settle}.
 */
export interface Ap2SettleOptions {
  /** Endpoint the signed x402 payload is POSTed to (the facilitator/merchant). */
  paymentEndpoint?: string;
  /** Optional bearer token forwarded to the payment endpoint. */
  authToken?: string;
}

/** Default payment endpoint used when {@link Ap2SettleOptions.paymentEndpoint} is omitted. */
const DEFAULT_PAYMENT_ENDPOINT = 'https://api.paybotcore.com/x402/settle';

/**
 * Adapter that settles AP2 Payment Mandates through the x402 rail.
 *
 * Wraps an injected {@link X402Handler}: it builds x402 requirements from the
 * mandate, synthesizes a minimal x402 {@link PaymentPayload}, signs it with the
 * handler, and submits it. The handler owns the wallet key and the EIP-3009
 * signing; the adapter owns only the AP2 → x402 translation.
 *
 * TRUST BOUNDARY: the adapter does NOT verify the AP2 VC signature. See the
 * module-level note. {@link Ap2Adapter.validateMandate} checks completeness and
 * expiry only.
 */
export class Ap2Adapter {
  private readonly handler: X402Handler;

  /**
   * @param handler - The {@link X402Handler} that holds the wallet key and
   *                   performs EIP-3009 signing + submission.
   */
  constructor(handler: X402Handler) {
    this.handler = handler;
  }

  /**
   * Validate that a mandate is structurally complete and not expired.
   *
   * This is NOT an authenticity check — the AP2 VC signature is not verified
   * here (see module trust boundary). Returns a result object rather than
   * throwing so callers can branch on it cheaply.
   *
   * @param mandate - The mandate to validate.
   * @param nowMs - Current epoch ms (injectable for deterministic tests).
   * @returns `{ valid: true }` when complete and unexpired; otherwise
   *          `{ valid: false, reason }` describing the first failure.
   *
   * @example
   *   adapter.validateMandate(goodMandate);            // { valid: true }
   *   adapter.validateMandate(expiredMandate);         // { valid: false, reason: 'mandate expired' }
   */
  validateMandate(
    mandate: Ap2PaymentMandate,
    nowMs: number = Date.now(),
  ): { valid: boolean; reason?: string } {
    const missing = missingRequiredFields(mandate);
    if (missing.length > 0) {
      return {
        valid: false,
        reason: `missing required field(s): ${missing.join(', ')}`,
      };
    }

    if (mandate.expiresAt) {
      const expMs = Date.parse(mandate.expiresAt);
      if (Number.isNaN(expMs)) {
        return { valid: false, reason: 'expiresAt is not a valid ISO-8601 date' };
      }
      if (expMs <= nowMs) {
        return { valid: false, reason: 'mandate expired' };
      }
    }

    return { valid: true };
  }

  /**
   * Settle an AP2 Payment Mandate over x402.
   *
   * Steps: validate → translate to {@link PaymentRequirements} → wrap in a
   * minimal x402 {@link PaymentPayload} (protocol `'x402'`) → sign via the
   * injected handler → submit to the payment endpoint → return the
   * {@link Receipt}.
   *
   * Does NOT verify the AP2 VC signature (see module trust boundary).
   *
   * @param mandate - The AP2 Payment Mandate to settle.
   * @param opts - Optional payment endpoint + auth token.
   * @returns The settlement {@link Receipt} from the payment endpoint.
   * @throws {PayBotApiError} `INVALID_AP2_MANDATE` (HTTP 400) when the mandate
   *          fails {@link Ap2Adapter.validateMandate} (incomplete or expired).
   * @throws {PayBotApiError} `UNSUPPORTED_TOKEN` / `UNSUPPORTED_NETWORK` bubbled
   *          from {@link ap2MandateToPaymentRequirements}.
   *
   * @example
   *   const receipt = await adapter.settle(mandate, {
   *     paymentEndpoint: 'https://merchant.example/settle',
   *   });
   *   receipt.status; // 'confirmed' | 'pending' | 'failed'
   */
  async settle(
    mandate: Ap2PaymentMandate,
    opts: Ap2SettleOptions = {},
  ): Promise<Receipt> {
    const validation = this.validateMandate(mandate);
    if (!validation.valid) {
      throw new PayBotApiError(
        `Cannot settle AP2 mandate: ${validation.reason}`,
        'INVALID_AP2_MANDATE',
        400,
        { reason: validation.reason },
      );
    }

    const requirements = ap2MandateToPaymentRequirements(mandate);

    const now = new Date();
    const paymentIntent: PaymentIntent = {
      // Reuse the mandate's intent linkage when present; else mint one.
      intentId: mandate.intentId ?? `ap2_${mandate.mandateId}`,
      protocol: 'x402',
      requirements,
      version: '2.0',
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + requirements.maxTimeoutSeconds * 1000,
      ).toISOString(),
    };

    const payload: PaymentPayload = {
      paymentIntent,
      requirements,
    };

    const signed = await this.handler.signPayment(payload);

    return this.handler.submitPayment(
      signed,
      opts.paymentEndpoint ?? DEFAULT_PAYMENT_ENDPOINT,
      opts.authToken,
    );
  }
}
