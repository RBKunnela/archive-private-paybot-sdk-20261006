import { createHmac, timingSafeEqual } from 'crypto';

/**
 * @module webhook
 *
 * Webhook signature verification and signing for PayBot webhooks.
 *
 * Mirrors the Python SDK's `paybot_sdk/webhook.py` byte-for-byte so a webhook
 * signed by the PayBot server verifies identically in TypeScript and Python.
 *
 * Header convention (the value of a `Paybot-Signature` header):
 *
 *     Paybot-Signature: t=<unix_ts>,v1=<hex>
 *
 * where `<hex>` is `HMAC-SHA256(secret, `${t}.${payload}`)` rendered as
 * lowercase hex. The signing string is the timestamp, a literal `.`, then the
 * raw request body. A replay guard rejects timestamps outside `tolerance`
 * seconds of now.
 *
 * Dependencies: Node built-in `crypto` (no external dependency).
 * Used by: webhook receivers/servers that need to authenticate PayBot deliveries.
 *
 * @example
 * import { verifyWebhookSignature, signWebhookPayload } from 'paybot-sdk';
 */

/**
 * Options for {@link verifyWebhookSignature}.
 */
export interface VerifyWebhookSignatureOptions {
  /** Raw webhook request body (the exact bytes/text the server signed). Buffers are decoded as UTF-8. */
  payload: string | Buffer;
  /** Value of the `Paybot-Signature` header, of the form `t=<unix_ts>,v1=<hex>`. */
  signature: string;
  /** Shared webhook signing secret. */
  secret: string;
  /** Maximum allowed age (and future skew) of the timestamp in seconds. Defaults to 300. */
  tolerance?: number;
}

/**
 * Options for {@link signWebhookPayload}.
 */
export interface SignWebhookPayloadOptions {
  /** Raw webhook request body to sign. Buffers are decoded as UTF-8. */
  payload: string | Buffer;
  /** Shared webhook signing secret. */
  secret: string;
  /** Unix timestamp (seconds) to embed. Defaults to the current time. */
  timestamp?: number;
}

/**
 * Parse a `Paybot-Signature` header value into its `t` and `v1` parts.
 *
 * Splits on commas, trims each `key=value` segment, and extracts the `t`
 * (timestamp) and `v1` (hex signature) fields. The timestamp is returned as the
 * raw string so the signing string can reproduce the server's bytes exactly.
 *
 * @param {string} header - Raw header value, e.g. `t=1700000000,v1=abc123`.
 * @returns {{ timestamp: string; v1: string } | null} Parsed parts, or `null` if
 *   the header is malformed or missing either field.
 *
 * @example
 * parseSignatureHeader('t=1700000000,v1=abc');
 * // { timestamp: '1700000000', v1: 'abc' }
 */
function parseSignatureHeader(
  header: string
): { timestamp: string; v1: string } | null {
  if (typeof header !== 'string' || header.length === 0) {
    return null;
  }

  let timestamp: string | null = null;
  let v1: string | null = null;

  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) {
      // A segment without `key=value` shape is malformed.
      return null;
    }
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      v1 = value;
    }
  }

  if (!timestamp || !v1) {
    return null;
  }
  return { timestamp, v1 };
}

/**
 * Compute the lowercase-hex `HMAC-SHA256(secret, signingString)`.
 *
 * Factored out so signing and verification share one code path and can never
 * drift apart.
 *
 * @param {string} secret - Shared webhook signing secret.
 * @param {string} signingString - The `${t}.${payload}` string to sign.
 * @returns {string} Lowercase hex digest.
 */
function computeHmacHex(secret: string, signingString: string): string {
  return createHmac('sha256', secret).update(signingString, 'utf8').digest('hex');
}

/**
 * Normalize a payload to a UTF-8 string. Buffers are decoded as UTF-8 so that a
 * raw request body verifies identically whether passed as a string or a Buffer.
 *
 * @param {string | Buffer} payload - Raw payload.
 * @returns {string} The payload as a UTF-8 string.
 */
function payloadToString(payload: string | Buffer): string {
  return Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
}

/**
 * Verify a PayBot webhook signature.
 *
 * Recomputes `HMAC-SHA256(secret, `${t}.${payload}`)` and compares it against
 * the `v1` value carried in the `signature` header using a constant-time
 * comparison (`crypto.timingSafeEqual`). The timestamp `t` must be within
 * `tolerance` seconds of the current time, which guards against replayed
 * deliveries.
 *
 * The signing string (`${t}.${payload}`) and header format match the Python
 * SDK's `verify_webhook_signature` exactly, so a signature produced by the
 * server verifies identically across both runtimes.
 *
 * Never throws on malformed input — a bad header, non-integer timestamp, or
 * missing `v1` returns `false`.
 *
 * @param {VerifyWebhookSignatureOptions} opts - Verification options.
 * @returns {boolean} `true` if the signature is valid and fresh, `false` otherwise.
 *
 * @example
 * const ok = verifyWebhookSignature({
 *   payload: rawBody,
 *   signature: req.headers['paybot-signature'],
 *   secret: 'whsec_x',
 * });
 */
export function verifyWebhookSignature(
  opts: VerifyWebhookSignatureOptions
): boolean {
  const { payload, signature, secret } = opts;
  const tolerance = opts.tolerance ?? 300;

  const parsed = parseSignatureHeader(signature);
  if (parsed === null) {
    return false;
  }

  const { timestamp, v1 } = parsed;

  // Replay guard: timestamp must be a valid integer within tolerance of now.
  // Use a strict integer regex so values like "12abc" or "" are rejected
  // (Number('') === 0, parseInt('12abc') === 12 — both would be unsafe here).
  if (!/^-?\d+$/.test(timestamp)) {
    return false;
  }
  const tsInt = Number(timestamp);
  if (!Number.isSafeInteger(tsInt)) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - tsInt) > tolerance) {
    return false;
  }

  const signingString = `${timestamp}.${payloadToString(payload)}`;
  const expectedV1 = computeHmacHex(secret, signingString);

  // Constant-time comparison. timingSafeEqual throws if the buffers differ in
  // length, so guard the length first and return false on mismatch.
  const expectedBuf = Buffer.from(expectedV1, 'utf8');
  const providedBuf = Buffer.from(v1, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Produce a `Paybot-Signature` header value for a payload.
 *
 * Signs with the identical algorithm used by {@link verifyWebhookSignature}, so
 * the output verifies in both the TS and Python SDKs. Useful for tests and for
 * servers written in TypeScript.
 *
 * @param {SignWebhookPayloadOptions} opts - Signing options.
 * @returns {string} A header value of the form `t=<unix_ts>,v1=<hex>`.
 *
 * @example
 * const header = signWebhookPayload({ payload: body, secret: 'whsec_x' });
 * // 't=1700000000,v1=12be6cc2...'
 */
export function signWebhookPayload(opts: SignWebhookPayloadOptions): string {
  const { payload, secret } = opts;
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signingString = `${timestamp}.${payloadToString(payload)}`;
  const v1 = computeHmacHex(secret, signingString);
  return `t=${timestamp},v1=${v1}`;
}
