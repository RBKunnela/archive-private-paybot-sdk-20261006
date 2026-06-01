/**
 * @module telemetry
 *
 * Optional, dependency-free OpenTelemetry hooks for the PayBot SDK.
 *
 * The SDK does NOT depend on `@opentelemetry/api`. Instead it defines a minimal
 * structural interface ({@link PayBotTracer} / {@link PayBotSpan}) that is
 * duck-compatible with a real OTel `Tracer`/`Span`. Callers who want tracing
 * inject their own tracer (e.g. `trace.getTracer('my-bot')` from
 * `@opentelemetry/api`); callers who do not pass a tracer pay zero overhead —
 * {@link withSpan} runs the wrapped function directly with no span allocation.
 *
 * Dependencies: none (structural typing only).
 * Used by: `src/client.ts` (PayBotClient.pay instrumentation).
 *
 * @example
 * import { trace, SpanStatusCode } from '@opentelemetry/api';
 * const client = new PayBotClient({
 *   apiKey: 'pb_test_...',
 *   botId: 'my-bot',
 *   telemetry: { tracer: trace.getTracer('my-bot') },
 * });
 */

/**
 * Minimal structural span, duck-compatible with an OpenTelemetry `Span`.
 *
 * Only the methods the SDK actually calls are declared, so a real OTel span
 * (which has a superset of this surface) satisfies the interface directly.
 */
export interface PayBotSpan {
  /**
   * Attach a single attribute to the span.
   *
   * @param {string} key - Attribute name (already prefix-qualified by the SDK).
   * @param {string | number | boolean} value - Attribute value.
   */
  setAttribute(key: string, value: string | number | boolean): void;

  /**
   * Set the span status.
   *
   * @param {{ code: number; message?: string }} status - OTel-style status.
   *   `code` follows `SpanStatusCode`: 0=UNSET, 1=OK, 2=ERROR.
   */
  setStatus(status: { code: number; message?: string }): void;

  /**
   * Record an exception on the span.
   *
   * @param {unknown} err - The thrown error/exception to record.
   */
  recordException(err: unknown): void;

  /** End the span. Must always be called exactly once. */
  end(): void;
}

/**
 * Minimal structural tracer, duck-compatible with an OpenTelemetry `Tracer`.
 */
export interface PayBotTracer {
  /**
   * Start a new span.
   *
   * @param {string} name - Span name (already prefix-qualified by the SDK).
   * @param {unknown} [options] - Optional, opaque OTel span options (ignored by the SDK).
   * @returns {PayBotSpan} The started span.
   */
  startSpan(name: string, options?: unknown): PayBotSpan;
}

/**
 * Telemetry configuration accepted by `PayBotConfig.telemetry`.
 */
export interface TelemetryConfig {
  /** The tracer the SDK emits spans on. Injected by the caller. */
  tracer: PayBotTracer;
  /** Span-name prefix (default: `'paybot.'`). */
  prefix?: string;
}

/** OpenTelemetry `SpanStatusCode.OK`. */
const STATUS_OK = 1;
/** OpenTelemetry `SpanStatusCode.ERROR`. */
const STATUS_ERROR = 2;

/** Default span-name prefix when {@link TelemetryConfig.prefix} is omitted. */
const DEFAULT_PREFIX = 'paybot.';

/**
 * Run `fn` inside a telemetry span, if telemetry is configured.
 *
 * When `telemetry` is `undefined`, `fn` is invoked directly with NO span
 * allocation and zero overhead (the no-op path). When configured, a span named
 * `${prefix}${name}` is started, the supplied `attrs` are attached, and:
 *  - on success the span status is set to OK and the resolved value returned;
 *  - on a thrown error the exception is recorded, status is set to ERROR, and
 *    the error is re-thrown (control flow is preserved exactly);
 *  - the span is always ended in a `finally` block (no leaks).
 *
 * A returned value is never inspected — a function that resolves with a
 * "failure" object (e.g. PaymentResult with `success: false`) still produces an
 * OK span, because nothing was thrown. Only thrown errors mark the span ERROR.
 *
 * @template T
 * @param {TelemetryConfig | undefined} telemetry - Telemetry config, or undefined for no-op.
 * @param {string} name - Unprefixed span name (e.g. `'client.pay'`).
 * @param {Record<string, string | number | boolean>} attrs - Attributes to set on the span.
 * @param {(span: PayBotSpan | undefined) => Promise<T>} fn - The async body to run.
 *   Receives the span (or `undefined` on the no-op path) so callers can attach
 *   late attributes such as `tx_hash`/`success`.
 * @returns {Promise<T>} Whatever `fn` resolves to.
 * @throws Re-throws any error thrown by `fn` after recording it on the span.
 *
 * @example
 * await withSpan(telemetry, 'client.pay', { network }, async (span) => {
 *   const result = await doWork();
 *   span?.setAttribute('success', result.success);
 *   return result;
 * });
 */
export async function withSpan<T>(
  telemetry: TelemetryConfig | undefined,
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: PayBotSpan | undefined) => Promise<T>
): Promise<T> {
  if (!telemetry) {
    // No-op path: zero overhead, no span allocated.
    return fn(undefined);
  }

  const prefix = telemetry.prefix ?? DEFAULT_PREFIX;
  const span = telemetry.tracer.startSpan(`${prefix}${name}`);
  for (const [key, value] of Object.entries(attrs)) {
    span.setAttribute(key, value);
  }

  try {
    const result = await fn(span);
    span.setStatus({ code: STATUS_OK });
    return result;
  } catch (error: unknown) {
    span.recordException(error);
    span.setStatus({ code: STATUS_ERROR, message: errorMessage(error) });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * @param {unknown} error - The thrown value.
 * @returns {string} A best-effort message string.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
