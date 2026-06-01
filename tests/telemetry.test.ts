import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayBotClient } from '../src/client.js';
import {
  withSpan,
  type PayBotTracer,
  type PayBotSpan,
  type TelemetryConfig,
} from '../src/telemetry.js';

// OTel SpanStatusCode mirror (1=OK, 2=ERROR).
const STATUS_OK = 1;
const STATUS_ERROR = 2;

// --- Mock tracer / span recording every interaction ---

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: number; message?: string };
  exceptions: unknown[];
  ended: boolean;
}

class MockSpan implements PayBotSpan {
  constructor(public readonly recorded: RecordedSpan) {}

  setAttribute(key: string, value: string | number | boolean): void {
    this.recorded.attributes[key] = value;
  }

  setStatus(status: { code: number; message?: string }): void {
    this.recorded.status = status;
  }

  recordException(err: unknown): void {
    this.recorded.exceptions.push(err);
  }

  end(): void {
    this.recorded.ended = true;
  }
}

class MockTracer implements PayBotTracer {
  public readonly spans: RecordedSpan[] = [];

  startSpan(name: string): PayBotSpan {
    const recorded: RecordedSpan = {
      name,
      attributes: {},
      exceptions: [],
      ended: false,
    };
    this.spans.push(recorded);
    return new MockSpan(recorded);
  }

  byName(name: string): RecordedSpan | undefined {
    return this.spans.find((s) => s.name === name);
  }
}

// --- fetch mock (mirrors tests/client.test.ts) ---

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

function happyVerify(): Response {
  return jsonResponse({
    valid: true,
    settlementToken: 'st_abc123',
    modifiedRequirements: { scheme: 'exact', amount: '50000' },
    commission: {
      grossAmount: '51250',
      netAmount: '50000',
      commissionAmount: '1250',
      commissionRate: 0.025,
    },
  });
}

function happySettle(): Response {
  return jsonResponse({ success: true, transaction: '0xTxHash', network: 'eip155:84532' });
}

const PAY_REQUEST = {
  resource: 'https://api.example.com/data',
  amount: '0.05',
  payTo: '0x0000000000000000000000000000000000000001',
};

describe('withSpan (unit)', () => {
  it('[UNIT] withSpan — OK path: starts prefixed span, sets attrs, OK status, ends', async () => {
    const tracer = new MockTracer();
    const telemetry: TelemetryConfig = { tracer };

    const result = await withSpan(telemetry, 'demo.op', { foo: 'bar', n: 7 }, async (span) => {
      expect(span).toBeDefined();
      return 'done';
    });

    expect(result).toBe('done');
    const span = tracer.byName('paybot.demo.op');
    expect(span).toBeDefined();
    expect(span?.attributes).toEqual({ foo: 'bar', n: 7 });
    expect(span?.status).toEqual({ code: STATUS_OK });
    expect(span?.exceptions).toHaveLength(0);
    expect(span?.ended).toBe(true);
  });

  it('[UNIT] withSpan — throw path: records exception, ERROR status, ends, rethrows', async () => {
    const tracer = new MockTracer();
    const telemetry: TelemetryConfig = { tracer };
    const boom = new Error('boom');

    await expect(
      withSpan(telemetry, 'demo.fail', {}, async () => {
        throw boom;
      })
    ).rejects.toThrow('boom');

    const span = tracer.byName('paybot.demo.fail');
    expect(span?.exceptions).toEqual([boom]);
    expect(span?.status).toEqual({ code: STATUS_ERROR, message: 'boom' });
    expect(span?.ended).toBe(true);
  });

  it('[UNIT] withSpan — no telemetry: runs fn directly, no span allocated', async () => {
    let receivedSpan: PayBotSpan | undefined = {} as PayBotSpan;
    const result = await withSpan(undefined, 'demo.noop', { x: 1 }, async (span) => {
      receivedSpan = span;
      return 42;
    });

    expect(result).toBe(42);
    // On the no-op path fn receives undefined (no span allocation).
    expect(receivedSpan).toBeUndefined();
  });

  it('[UNIT] withSpan — honors custom prefix', async () => {
    const tracer = new MockTracer();
    await withSpan({ tracer, prefix: 'mybot.' }, 'op', {}, async () => undefined);
    expect(tracer.byName('mybot.op')).toBeDefined();
    expect(tracer.byName('paybot.op')).toBeUndefined();
  });

  it('[UNIT] withSpan — non-Error throw recorded and stringified in status', async () => {
    const tracer = new MockTracer();
    await expect(
      withSpan({ tracer }, 'op', {}, async () => {
        throw 'string-error';
      })
    ).rejects.toBe('string-error');
    const span = tracer.byName('paybot.op');
    expect(span?.exceptions).toEqual(['string-error']);
    expect(span?.status).toEqual({ code: STATUS_ERROR, message: 'string-error' });
    expect(span?.ended).toBe(true);
  });
});

describe('PayBotClient telemetry integration', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('no-op path (telemetry undefined)', () => {
    it('[INTEGRATION] pay() — works and emits zero spans with identical result', async () => {
      const tracer = new MockTracer();
      const client = new PayBotClient({
        apiKey: 'pb_test_key',
        botId: 'test-bot',
        facilitatorUrl: 'https://api.test.com',
      });

      mockFetch.mockResolvedValueOnce(happyVerify());
      mockFetch.mockResolvedValueOnce(happySettle());

      const result = await client.pay(PAY_REQUEST);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe('0xTxHash');
      expect(result.commissionRate).toBe(0.025);
      // No tracer was passed → nothing recorded anywhere.
      expect(tracer.spans).toHaveLength(0);
    });
  });

  describe('happy path (telemetry set)', () => {
    let tracer: MockTracer;
    let client: PayBotClient;

    beforeEach(() => {
      tracer = new MockTracer();
      client = new PayBotClient({
        apiKey: 'pb_test_key',
        botId: 'test-bot',
        facilitatorUrl: 'https://api.test.com',
        telemetry: { tracer },
      });
      mockFetch.mockResolvedValueOnce(happyVerify());
      mockFetch.mockResolvedValueOnce(happySettle());
    });

    it('[INTEGRATION] pay() — emits client.pay + sign + challenge + settle spans', async () => {
      await client.pay(PAY_REQUEST);
      const names = tracer.spans.map((s) => s.name).sort();
      expect(names).toEqual(
        [
          'paybot.client.pay',
          'paybot.x402.challenge',
          'paybot.x402.settle',
          'paybot.x402.sign',
        ].sort()
      );
    });

    it('[INTEGRATION] pay() — sets network/amount/bot_id/success/tx_hash on client.pay span', async () => {
      await client.pay(PAY_REQUEST);
      const span = tracer.byName('paybot.client.pay');
      expect(span?.attributes).toMatchObject({
        network: 'eip155:84532',
        amount: '0.05',
        bot_id: 'test-bot',
        success: true,
        tx_hash: '0xTxHash',
      });
      expect(span?.status).toEqual({ code: STATUS_OK });
    });

    it('[INTEGRATION] pay() — sign span carries network attribute', async () => {
      await client.pay(PAY_REQUEST);
      expect(tracer.byName('paybot.x402.sign')?.attributes).toMatchObject({
        network: 'eip155:84532',
      });
    });

    it('[INTEGRATION] pay() — every started span is ended (no leaks)', async () => {
      await client.pay(PAY_REQUEST);
      expect(tracer.spans.length).toBeGreaterThan(0);
      for (const span of tracer.spans) {
        expect(span.ended).toBe(true);
      }
    });

    it('[INTEGRATION] pay() — no exceptions recorded on the happy path', async () => {
      await client.pay(PAY_REQUEST);
      for (const span of tracer.spans) {
        expect(span.exceptions).toHaveLength(0);
        expect(span.status?.code).toBe(STATUS_OK);
      }
    });
  });

  describe('custom prefix', () => {
    it('[INTEGRATION] pay() — honors custom telemetry prefix', async () => {
      const tracer = new MockTracer();
      const client = new PayBotClient({
        apiKey: 'pb_test_key',
        botId: 'test-bot',
        facilitatorUrl: 'https://api.test.com',
        telemetry: { tracer, prefix: 'acme.' },
      });
      mockFetch.mockResolvedValueOnce(happyVerify());
      mockFetch.mockResolvedValueOnce(happySettle());

      await client.pay(PAY_REQUEST);
      const names = tracer.spans.map((s) => s.name);
      expect(names).toContain('acme.client.pay');
      expect(names).toContain('acme.x402.sign');
      expect(names.every((n) => n.startsWith('acme.'))).toBe(true);
    });
  });

  describe('returned failure (mock facilitator 4xx)', () => {
    it('[INTEGRATION] pay() — client.pay span ended with success=false, NOT recordException', async () => {
      const tracer = new MockTracer();
      const client = new PayBotClient({
        apiKey: 'pb_test_key',
        botId: 'test-bot',
        facilitatorUrl: 'https://api.test.com',
        telemetry: { tracer },
      });
      // Verify returns a 4xx → PayBotApiError → caught → failure PaymentResult.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Trust violation', code: 'TRUST_VIOLATION' }, 403)
      );

      const result = await client.pay(PAY_REQUEST);

      // Behavior unchanged: returns failure, never throws.
      expect(result.success).toBe(false);
      expect(result.error).toBe('Trust violation');

      const paySpan = tracer.byName('paybot.client.pay');
      expect(paySpan?.attributes.success).toBe(false);
      // A returned failure is NOT a thrown exception at the client.pay level.
      expect(paySpan?.exceptions).toHaveLength(0);
      expect(paySpan?.status).toEqual({ code: STATUS_OK });
      expect(paySpan?.ended).toBe(true);

      // The challenge sub-span DID see the underlying thrown PayBotApiError.
      const challengeSpan = tracer.byName('paybot.x402.challenge');
      expect(challengeSpan?.exceptions).toHaveLength(1);
      expect(challengeSpan?.status?.code).toBe(STATUS_ERROR);
      expect(challengeSpan?.ended).toBe(true);
    });

    it('[INTEGRATION] pay() — no settle span emitted when verify fails', async () => {
      const tracer = new MockTracer();
      const client = new PayBotClient({
        apiKey: 'pb_test_key',
        botId: 'test-bot',
        facilitatorUrl: 'https://api.test.com',
        telemetry: { tracer },
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'bad', code: 'X' }, 400)
      );

      await client.pay(PAY_REQUEST);
      expect(tracer.byName('paybot.x402.settle')).toBeUndefined();
      // Every span that WAS started is still ended.
      for (const span of tracer.spans) {
        expect(span.ended).toBe(true);
      }
    });
  });

  describe('thrown error path', () => {
    it('[INTEGRATION] pay() — a thrown (non-PayBotApiError) marks sub-span ERROR + records exception; pay() still returns failure', async () => {
      const tracer = new MockTracer();
      const client = new PayBotClient({
        apiKey: 'pb_test_key',
        botId: 'test-bot',
        facilitatorUrl: 'https://api.test.com',
        telemetry: { tracer },
      });
      // fetch throws a raw (non-PayBotApiError, non-Abort) error inside the
      // challenge span. _request retries once then wraps into a NETWORK_ERROR
      // PayBotApiError, which the challenge handler converts to a failure
      // result — so client.pay resolves OK with success=false, while the
      // challenge span recorded the wrapped error.
      mockFetch.mockRejectedValue(new TypeError('socket hang up'));

      const result = await client.pay(PAY_REQUEST);

      // pay() never throws.
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('NETWORK_ERROR');

      const challengeSpan = tracer.byName('paybot.x402.challenge');
      expect(challengeSpan?.exceptions).toHaveLength(1);
      expect(challengeSpan?.status?.code).toBe(STATUS_ERROR);
      expect(challengeSpan?.ended).toBe(true);

      const paySpan = tracer.byName('paybot.client.pay');
      expect(paySpan?.attributes.success).toBe(false);
      expect(paySpan?.status).toEqual({ code: STATUS_OK });
      expect(paySpan?.ended).toBe(true);
    });

    it('[UNIT] withSpan — thrown error inside fn becomes ERROR span + recordException + rethrow', async () => {
      // Direct simulation of a span wrapping a path that throws (the generic
      // contract the pay() sub-spans rely on): exception recorded, ERROR
      // status, span ended, error rethrown to the caller.
      const tracer = new MockTracer();
      const failure = new Error('settle exploded');

      await expect(
        withSpan({ tracer }, 'x402.settle', { network: 'eip155:84532' }, async () => {
          throw failure;
        })
      ).rejects.toBe(failure);

      const span = tracer.byName('paybot.x402.settle');
      expect(span?.attributes).toMatchObject({ network: 'eip155:84532' });
      expect(span?.exceptions).toEqual([failure]);
      expect(span?.status?.code).toBe(STATUS_ERROR);
      expect(span?.ended).toBe(true);
    });
  });
});
