/**
 * PayBot error taxonomy.
 *
 * Hierarchy (all subclasses of {@link PayBotApiError} stay `instanceof
 * PayBotApiError` for back-compat):
 *
 * ```
 * Error
 *  └─ PayBotError          (abstract root: code + optional details)
 *      └─ PayBotApiError   (message, code, statusCode, details?)  ← back-compat anchor
 *          ├─ PayBotNetworkError     (connection/DNS/refused)
 *          ├─ PayBotTimeoutError     (request timeout)
 *          ├─ PayBotAuthError        (401/403)
 *          ├─ PayBotPolicyError      (trust/AML/limit)
 *          ├─ PayBotSignatureError   (EIP-3009/EIP-712 signing)
 *          └─ PayBotSettlementError  (chain rejected the tx)
 * ```
 */

/**
 * Abstract root of the PayBot error taxonomy.
 *
 * Carries a machine-readable {@link code} and optional structured
 * {@link details}. Not thrown directly — concrete subclasses extend
 * {@link PayBotApiError}.
 */
export abstract class PayBotError extends Error {
  /** Machine-readable error code (e.g. 'NETWORK_ERROR', 'TRUST_VIOLATION'). */
  readonly code: string;
  /** Optional structured error context from the server or client. */
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PayBotError';
    this.code = code;
    this.details = details;
  }
}

/**
 * SDK-facing error thrown by PayBotClient methods on non-2xx HTTP responses.
 *
 * This is the back-compat anchor: all specialized error subtypes extend this
 * class, so `instanceof PayBotApiError` and reads of `.code` / `.statusCode` /
 * `.details` keep working unchanged.
 *
 * @param message - Human-readable error message.
 * @param code - Machine-readable error code.
 * @param statusCode - HTTP status code (0 for transport-level errors).
 * @param details - Optional structured error context.
 */
export class PayBotApiError extends PayBotError {
  readonly statusCode: number;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    details?: Record<string, unknown>
  ) {
    super(message, code, details);
    this.name = 'PayBotApiError';
    this.statusCode = statusCode;
  }
}

/**
 * Connection-level failure (DNS resolution, connection refused, socket reset).
 *
 * @param message - Human-readable error message.
 * @param code - Machine-readable code (default 'NETWORK_ERROR').
 * @param statusCode - HTTP status (default 0 — no HTTP response was received).
 * @param details - Optional structured error context.
 */
export class PayBotNetworkError extends PayBotApiError {
  constructor(
    message: string,
    code: string = 'NETWORK_ERROR',
    statusCode: number = 0,
    details?: Record<string, unknown>
  ) {
    super(message, code, statusCode, details);
    this.name = 'PayBotNetworkError';
  }
}

/**
 * Request exceeded the configured timeout and was aborted.
 *
 * @param message - Human-readable error message.
 * @param code - Machine-readable code (default 'TIMEOUT').
 * @param statusCode - HTTP status (default 0 — request never completed).
 * @param details - Optional structured error context.
 */
export class PayBotTimeoutError extends PayBotApiError {
  constructor(
    message: string,
    code: string = 'TIMEOUT',
    statusCode: number = 0,
    details?: Record<string, unknown>
  ) {
    super(message, code, statusCode, details);
    this.name = 'PayBotTimeoutError';
  }
}

/**
 * Authentication / authorization failure (HTTP 401 or 403).
 *
 * @param message - Human-readable error message.
 * @param code - Machine-readable code (default 'AUTHENTICATION_FAILED').
 * @param statusCode - HTTP status (default 401).
 * @param details - Optional structured error context.
 */
export class PayBotAuthError extends PayBotApiError {
  constructor(
    message: string,
    code: string = 'AUTHENTICATION_FAILED',
    statusCode: number = 401,
    details?: Record<string, unknown>
  ) {
    super(message, code, statusCode, details);
    this.name = 'PayBotAuthError';
  }
}

/**
 * Policy rejection — trust violation, AML block, spending limit, or envelope
 * breach. The server-provided `code` is preserved (e.g. 'TRUST_VIOLATION').
 *
 * @param message - Human-readable error message.
 * @param code - Server policy code (preserved; default 'POLICY_VIOLATION').
 * @param statusCode - HTTP status (default 403).
 * @param details - Optional structured error context.
 */
export class PayBotPolicyError extends PayBotApiError {
  constructor(
    message: string,
    code: string = 'POLICY_VIOLATION',
    statusCode: number = 403,
    details?: Record<string, unknown>
  ) {
    super(message, code, statusCode, details);
    this.name = 'PayBotPolicyError';
  }
}

/**
 * EIP-3009 / EIP-712 signing failed (bad key, malformed domain, signer error).
 *
 * @param message - Human-readable error message.
 * @param code - Machine-readable code (default 'SIGNATURE_FAILED').
 * @param statusCode - HTTP status (default 0 — failure is local, pre-network).
 * @param details - Optional structured error context.
 */
export class PayBotSignatureError extends PayBotApiError {
  constructor(
    message: string,
    code: string = 'SIGNATURE_FAILED',
    statusCode: number = 0,
    details?: Record<string, unknown>
  ) {
    super(message, code, statusCode, details);
    this.name = 'PayBotSignatureError';
  }
}

/**
 * On-chain settlement failure — the chain rejected the transaction.
 *
 * @param message - Human-readable error message.
 * @param code - Machine-readable code (default 'SETTLEMENT_FAILED').
 * @param statusCode - HTTP status (default 502).
 * @param details - Optional structured error context.
 */
export class PayBotSettlementError extends PayBotApiError {
  constructor(
    message: string,
    code: string = 'SETTLEMENT_FAILED',
    statusCode: number = 502,
    details?: Record<string, unknown>
  ) {
    super(message, code, statusCode, details);
    this.name = 'PayBotSettlementError';
  }
}

/**
 * Server policy codes that map to {@link PayBotPolicyError}.
 *
 * Exported so {@link PayBotClient} and tests share a single source of truth.
 */
export const POLICY_ERROR_CODES: ReadonlySet<string> = new Set([
  'TRUST_VIOLATION',
  'AML_BLOCKED',
  'DAILY_LIMIT_EXCEEDED',
  'SPENDING_ENVELOPE',
]);

/**
 * Construct the most specific {@link PayBotApiError} subclass for an HTTP
 * error response, based on status code and server-provided error code.
 *
 * Mapping:
 * - 401/403 → {@link PayBotAuthError}
 * - policy codes (see {@link POLICY_ERROR_CODES}) → {@link PayBotPolicyError}
 * - everything else → {@link PayBotApiError}
 *
 * @param message - Human-readable error message.
 * @param code - Server-provided machine-readable code.
 * @param statusCode - HTTP status code.
 * @param details - Optional structured error context.
 * @returns The most specific matching error instance (always `instanceof
 * PayBotApiError`).
 *
 * @example
 * throw mapHttpError('Trust violation', 'TRUST_VIOLATION', 403);
 * // → PayBotPolicyError (and instanceof PayBotApiError)
 */
export function mapHttpError(
  message: string,
  code: string,
  statusCode: number,
  details?: Record<string, unknown>
): PayBotApiError {
  if (POLICY_ERROR_CODES.has(code)) {
    return new PayBotPolicyError(message, code, statusCode, details);
  }
  if (statusCode === 401 || statusCode === 403) {
    return new PayBotAuthError(message, code, statusCode, details);
  }
  return new PayBotApiError(message, code, statusCode, details);
}

/**
 * Extract error message safely from unknown error values.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
