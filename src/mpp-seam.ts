/**
 * @module mpp-seam
 *
 * Thin **MPP (Merchant/Machine Payments Protocol — Stripe/Tempo) capability
 * seam**. This is deliberately NOT a client.
 *
 * WHY a seam and not a client:
 *   At time of writing, Stripe/Tempo MPP is still in PREVIEW: version-pinned and
 *   bound to the Tempo L1, and it shares NO signing code with our EIP-3009 core.
 *   Our x402 signing path (EIP-3009 `TransferWithAuthorization` over EVM) does
 *   not transfer to MPP — MPP uses a different challenge/credential model. So
 *   building a full MPP client now would mean committing to a moving,
 *   preview-stage target with a separate crypto stack.
 *
 *   Instead, this module provides the *shape* of MPP support: it can DETECT
 *   whether a server advertises MPP (so a caller can negotiate/route), and it
 *   exposes a `settle` entry point that LOUDLY throws `MPP_NOT_IMPLEMENTED`.
 *   When MPP exits preview, the real settlement path slots in behind this seam
 *   without changing the public surface.
 *
 * Dependencies: ./errors (PayBotApiError).
 * Used by: routing/negotiation code that wants to know "can this endpoint do MPP
 * yet?" without paying for it.
 */

import { PayBotApiError } from './errors.js';

/**
 * The result of probing a server for MPP support.
 *
 * - `mode: 'none'`        — no MPP advertisement seen; not supported.
 * - `mode: 'detect-only'` — MPP advertised; we can detect/route but NOT settle.
 * - `mode: 'preview'`     — reserved for a future preview-grade settlement path.
 */
export interface MppCapability {
  /** Whether any MPP advertisement was detected. */
  supported: boolean;
  /** Capability mode. Today only `'none'` and `'detect-only'` are produced. */
  mode: 'none' | 'detect-only' | 'preview';
  /** The advertised spec/version string, when the server provided one. */
  specVersion?: string;
  /** Human-readable reason, populated when `supported` is `false`. */
  reason?: string;
}

/**
 * Header names that, when present, indicate a server advertises MPP. Compared
 * case-insensitively. `WWW-Authenticate` only counts when its value mentions a
 * payment challenge (see {@link detectMppCapability}).
 */
const MPP_VERSION_HEADERS = ['mpp-version', 'stripe-version'] as const;

/**
 * Read a header value by name, case-insensitively, from a plain record.
 *
 * @param headers - The header record.
 * @param name - Header name to look up (any casing).
 * @returns The value, or `undefined` when absent.
 */
function readHeaderCaseInsensitive(
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
 * Detect whether response headers advertise MPP support.
 *
 * Detection is purely passive — this NEVER signs or settles. It inspects, case
 * insensitively, for either:
 *   - an `MPP-Version` / `Stripe-Version` header (value becomes `specVersion`), or
 *   - a `WWW-Authenticate` challenge whose value mentions `Payment` (an MPP-style
 *     402 challenge), in which case the challenge value becomes `specVersion`.
 *
 * @param serverHeaders - Response headers to inspect. Omitted/empty → not supported.
 * @returns `{ supported: true, mode: 'detect-only', specVersion }` when MPP is
 *          advertised; otherwise `{ supported: false, mode: 'none', reason }`.
 *
 * @example
 *   detectMppCapability({ 'MPP-Version': '2024-09-preview' });
 *   // { supported: true, mode: 'detect-only', specVersion: '2024-09-preview' }
 *   detectMppCapability({});
 *   // { supported: false, mode: 'none', reason: 'no MPP advertisement' }
 */
export function detectMppCapability(
  serverHeaders?: Record<string, string>,
): MppCapability {
  if (!serverHeaders || Object.keys(serverHeaders).length === 0) {
    return { supported: false, mode: 'none', reason: 'no MPP advertisement' };
  }

  for (const headerName of MPP_VERSION_HEADERS) {
    const value = readHeaderCaseInsensitive(serverHeaders, headerName);
    if (value && value.length > 0) {
      return { supported: true, mode: 'detect-only', specVersion: value };
    }
  }

  // WWW-Authenticate: Payment ... → MPP-style 402 challenge.
  const challenge = readHeaderCaseInsensitive(serverHeaders, 'www-authenticate');
  if (challenge && /payment/i.test(challenge)) {
    return { supported: true, mode: 'detect-only', specVersion: challenge };
  }

  return { supported: false, mode: 'none', reason: 'no MPP advertisement' };
}

/**
 * The shape of an MPP adapter. `detect` is real; `settle` is intentionally a
 * dead-end (`never`) until MPP exits preview — see {@link createMppSeam}.
 */
export interface MppAdapter {
  /** Detect MPP support from response headers. */
  detect(headers?: Record<string, string>): MppCapability;
  /**
   * Settle via MPP. NOT implemented — always throws `MPP_NOT_IMPLEMENTED`. The
   * signature is `(...args) => never` so the unbuilt path is loud and typed.
   */
  settle(...args: unknown[]): never;
}

/**
 * Create the MPP capability seam.
 *
 * The returned adapter can DETECT MPP advertisements but cannot settle: its
 * `settle` throws {@link PayBotApiError} `MPP_NOT_IMPLEMENTED` (HTTP 501) with a
 * message pointing to the deferral rationale. This keeps the seam's shape real
 * and testable while keeping the unbuilt settlement path loud rather than
 * silently broken.
 *
 * @returns An {@link MppAdapter} whose `settle` always throws.
 *
 * @example
 *   const seam = createMppSeam();
 *   seam.detect({ 'MPP-Version': 'x' }).supported; // true
 *   seam.settle();                                 // throws MPP_NOT_IMPLEMENTED (501)
 */
export function createMppSeam(): MppAdapter {
  return {
    detect(headers?: Record<string, string>): MppCapability {
      return detectMppCapability(headers);
    },
    settle(..._args: unknown[]): never {
      throw new PayBotApiError(
        'MPP settlement is not implemented: full MPP support is deferred until ' +
          'MPP exits preview. The EIP-3009 signing path does not transfer to ' +
          'MPP (different challenge/credential model); this seam exists to ' +
          'detect and route, not to pay.',
        'MPP_NOT_IMPLEMENTED',
        501,
      );
    },
  };
}
