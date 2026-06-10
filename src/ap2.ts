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
 * TRUST BOUNDARY (updated by story AK-1, 2026-06-10):
 *   Cryptographic mandate verification IS supported — on the full VC envelope
 *   only. {@link Ap2Adapter.settleVc} verifies an {@link Ap2MandateVc} through
 *   the fail-closed 8-step pipeline in `./ap2-vc` (pinned proof suites,
 *   offline DID resolution, operator trust anchors, signature over the
 *   canonicalized payload, temporal validity, replay protection, cart→intent
 *   linkage) BEFORE any translation or signing happens. An unverifiable
 *   envelope never reaches the x402 rail.
 *
 *   The legacy {@link Ap2PaymentMandate} slice remains **translation-only**:
 *   its opaque `signature` field is NOT verified, {@link
 *   Ap2Adapter.validateMandate} checks completeness/expiry only (NOT
 *   authenticity), and a receipt settled through the legacy {@link
 *   Ap2Adapter.settle} path is always marked
 *   `mandateVerification: 'not-performed'`. Verification can only ever
 *   succeed on the full envelope.
 *
 * Dependencies: ./x402-v2 (X402Handler), ./networks (token registry),
 * ./ap2-vc (VC verification), ./errors.
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
import {
  verifyMandate,
  getMandateId,
  getCartHash,
  MAX_CLOCK_SKEW_MS,
} from './ap2-vc.js';
import type { Ap2MandateVc, Ap2VerifyOptions } from './ap2-vc.js';

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
 * Options for {@link Ap2Adapter.settleVc} - settlement of a full, verifiable
 * AP2 mandate envelope.
 */
export interface Ap2SettleVcOptions extends Ap2SettleOptions {
  /** Trust anchors, pinned DID documents, replay store (see ./ap2-vc). */
  verify: Ap2VerifyOptions;
  /**
   * When an envelope is supplied, verification defaults to REQUIRED.
   * Setting `false` skips verification (the receipt is then marked
   * `mandateVerification: 'not-performed'`) - discouraged; exists only for
   * staged migrations.
   */
  requireVerifiedMandate?: boolean;
  /** Current epoch ms (injectable for deterministic tests). */
  nowMs?: number;
}

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

    const receipt = await this.handler.submitPayment(
      signed,
      opts.paymentEndpoint ?? DEFAULT_PAYMENT_ENDPOINT,
      opts.authToken,
    );
    // Legacy slice path: authenticity was NOT checked (translation-only).
    return { ...receipt, mandateVerification: 'not-performed' };
  }

  /**
   * Settle a full AP2 mandate VC envelope - verification FIRST, fail closed.
   *
   * Steps: {@link verifyMandate} (8-step pipeline; default REQUIRED) ->
   * record the replay key `(mandateId, cartHash)` -> extract the settlement
   * slice from `credentialSubject` -> {@link Ap2Adapter.settle}. A mandate
   * that fails verification NEVER reaches translation or signing - there is
   * no partial path where an unverified envelope settles silently.
   *
   * The replay record is written immediately after verification succeeds
   * (before signing/submission): on a submission failure the mandate is
   * burned for this process rather than risking a double settlement
   * (fail-closed direction; paybot core remains the authoritative replay
   * layer).
   *
   * @param vc - The AP2 mandate VC envelope (untrusted input).
   * @param opts - Verification options + payment endpoint/auth.
   * @returns The settlement {@link Receipt}, marked
   *          `mandateVerification: 'verified'` (or `'not-performed'` when
   *          `requireVerifiedMandate: false` skipped verification).
   * @throws {PayBotApiError} `INVALID_AP2_MANDATE` (HTTP 400) carrying
   *          `details.errorCode` (one of the `AP2_*` verify codes) when
   *          verification fails, or when `credentialSubject` is not a
   *          settleable payment slice.
   *
   * @example
   *   const receipt = await adapter.settleVc(vc, {
   *     verify: { trustedIssuers: ['did:key:z6Mk...'] },
   *   });
   *   receipt.mandateVerification; // 'verified'
   */
  async settleVc(
    vc: Ap2MandateVc,
    opts: Ap2SettleVcOptions,
  ): Promise<Receipt> {
    const requireVerified = opts.requireVerifiedMandate !== false;
    let verified = false;
    if (requireVerified) {
      const result = verifyMandate(vc, opts.verify, opts.nowMs ?? Date.now());
      if (!result.verified) {
        throw new PayBotApiError(
          `AP2 mandate verification failed: ${result.errorCode} (${result.errorDetail})`,
          'INVALID_AP2_MANDATE',
          400,
          {
            errorCode: result.errorCode,
            errorDetail: result.errorDetail,
            mandateHash: result.mandateHash,
            issuerDid: result.issuerDid,
          },
        );
      }
      verified = true;
      // Record the replay key now - before signing - so a crash mid-settle
      // cannot let the same mandate settle twice in this process.
      if (opts.verify.replayStore) {
        const mandateId = getMandateId(vc) as string;
        const ttlMs =
          Date.parse(vc.validUntil as string) -
          (opts.nowMs ?? Date.now()) +
          MAX_CLOCK_SKEW_MS;
        opts.verify.replayStore.record(
          mandateId,
          getCartHash(vc),
          result.mandateHash,
          ttlMs,
        );
      }
    }

    const slice = vc.credentialSubject as unknown;
    if (!isAp2Mandate(slice)) {
      throw new PayBotApiError(
        'AP2 envelope credentialSubject is not a settleable payment slice',
        'INVALID_AP2_MANDATE',
        400,
        { reason: 'credentialSubject missing settlement fields' },
      );
    }

    const receipt = await this.settle(slice, {
      paymentEndpoint: opts.paymentEndpoint,
      authToken: opts.authToken,
    });
    return {
      ...receipt,
      mandateVerification: verified ? 'verified' : 'not-performed',
    };
  }
}
