import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PayBotError,
  PayBotApiError,
  PayBotNetworkError,
  PayBotTimeoutError,
  PayBotAuthError,
  PayBotPolicyError,
  PayBotSignatureError,
  PayBotSettlementError,
  mapHttpError,
  POLICY_ERROR_CODES,
} from '../src/errors.js';
import { PayBotClient } from '../src/client.js';

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

describe('Error taxonomy — hierarchy & back-compat', () => {
  it('PayBotApiError extends PayBotError and Error, keeping its constructor', () => {
    const err = new PayBotApiError('Not found', 'NOT_FOUND', 404, { botId: 'x' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PayBotError);
    expect(err).toBeInstanceOf(PayBotApiError);
    expect(err.message).toBe('Not found');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.details).toEqual({ botId: 'x' });
    expect(err.name).toBe('PayBotApiError');
  });

  it('PayBotError is abstract (cannot be the direct instance type of subclasses other than via inheritance)', () => {
    // PayBotError carries code + details; subclasses populate it.
    const err = new PayBotApiError('m', 'C', 500);
    expect(err.code).toBe('C');
    expect((err as PayBotError).details).toBeUndefined();
  });

  // --- Each subclass: instanceof PayBotError AND PayBotApiError, name/code/statusCode ---

  describe('PayBotNetworkError', () => {
    it('is instanceof PayBotError and PayBotApiError with defaults', () => {
      const err = new PayBotNetworkError('connection refused');
      expect(err).toBeInstanceOf(PayBotError);
      expect(err).toBeInstanceOf(PayBotApiError);
      expect(err).toBeInstanceOf(PayBotNetworkError);
      expect(err.name).toBe('PayBotNetworkError');
      expect(err.code).toBe('NETWORK_ERROR');
      expect(err.statusCode).toBe(0);
    });

    it('allows overriding code/statusCode/details', () => {
      const err = new PayBotNetworkError('dns', 'DNS_FAIL', 0, { host: 'x' });
      expect(err.code).toBe('DNS_FAIL');
      expect(err.details).toEqual({ host: 'x' });
    });

    it('preserves the message', () => {
      expect(new PayBotNetworkError('boom').message).toBe('boom');
    });
  });

  describe('PayBotTimeoutError', () => {
    it('is instanceof PayBotError and PayBotApiError with defaults', () => {
      const err = new PayBotTimeoutError('timed out');
      expect(err).toBeInstanceOf(PayBotError);
      expect(err).toBeInstanceOf(PayBotApiError);
      expect(err.name).toBe('PayBotTimeoutError');
      expect(err.code).toBe('TIMEOUT');
      expect(err.statusCode).toBe(0);
    });

    it('allows overriding the code', () => {
      expect(new PayBotTimeoutError('t', 'SLOW').code).toBe('SLOW');
    });

    it('preserves the message', () => {
      expect(new PayBotTimeoutError('late').message).toBe('late');
    });
  });

  describe('PayBotAuthError', () => {
    it('is instanceof PayBotError and PayBotApiError with defaults', () => {
      const err = new PayBotAuthError('unauthorized');
      expect(err).toBeInstanceOf(PayBotError);
      expect(err).toBeInstanceOf(PayBotApiError);
      expect(err.name).toBe('PayBotAuthError');
      expect(err.code).toBe('AUTHENTICATION_FAILED');
      expect(err.statusCode).toBe(401);
    });

    it('allows 403 statusCode and a server code', () => {
      const err = new PayBotAuthError('forbidden', 'FORBIDDEN', 403);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('FORBIDDEN');
    });

    it('preserves the message', () => {
      expect(new PayBotAuthError('nope').message).toBe('nope');
    });
  });

  describe('PayBotPolicyError', () => {
    it('is instanceof PayBotError and PayBotApiError with defaults', () => {
      const err = new PayBotPolicyError('trust violation', 'TRUST_VIOLATION');
      expect(err).toBeInstanceOf(PayBotError);
      expect(err).toBeInstanceOf(PayBotApiError);
      expect(err.name).toBe('PayBotPolicyError');
      expect(err.code).toBe('TRUST_VIOLATION');
      expect(err.statusCode).toBe(403);
    });

    it('preserves the server code (does not overwrite it)', () => {
      const err = new PayBotPolicyError('blocked', 'AML_BLOCKED', 403);
      expect(err.code).toBe('AML_BLOCKED');
    });

    it('falls back to POLICY_VIOLATION when no code given', () => {
      expect(new PayBotPolicyError('p').code).toBe('POLICY_VIOLATION');
    });
  });

  describe('PayBotSignatureError', () => {
    it('is instanceof PayBotError and PayBotApiError with defaults', () => {
      const err = new PayBotSignatureError('sign failed');
      expect(err).toBeInstanceOf(PayBotError);
      expect(err).toBeInstanceOf(PayBotApiError);
      expect(err.name).toBe('PayBotSignatureError');
      expect(err.code).toBe('SIGNATURE_FAILED');
      expect(err.statusCode).toBe(0);
    });

    it('allows overriding the code', () => {
      expect(new PayBotSignatureError('s', 'BAD_KEY').code).toBe('BAD_KEY');
    });

    it('preserves the message', () => {
      expect(new PayBotSignatureError('bad domain').message).toBe('bad domain');
    });
  });

  describe('PayBotSettlementError', () => {
    it('is instanceof PayBotError and PayBotApiError with defaults', () => {
      const err = new PayBotSettlementError('chain rejected');
      expect(err).toBeInstanceOf(PayBotError);
      expect(err).toBeInstanceOf(PayBotApiError);
      expect(err.name).toBe('PayBotSettlementError');
      expect(err.code).toBe('SETTLEMENT_FAILED');
      expect(err.statusCode).toBe(502);
    });

    it('allows overriding code/statusCode', () => {
      const err = new PayBotSettlementError('reverted', 'REVERTED', 500);
      expect(err.code).toBe('REVERTED');
      expect(err.statusCode).toBe(500);
    });

    it('preserves the message', () => {
      expect(new PayBotSettlementError('nope').message).toBe('nope');
    });
  });
});

describe('mapHttpError', () => {
  it('maps policy codes to PayBotPolicyError preserving the code', () => {
    for (const code of POLICY_ERROR_CODES) {
      const err = mapHttpError('policy', code, 403);
      expect(err).toBeInstanceOf(PayBotPolicyError);
      expect(err).toBeInstanceOf(PayBotApiError);
      expect(err.code).toBe(code);
    }
  });

  it('maps 401 to PayBotAuthError', () => {
    const err = mapHttpError('unauthorized', 'UNAUTHORIZED', 401);
    expect(err).toBeInstanceOf(PayBotAuthError);
    expect(err.statusCode).toBe(401);
  });

  it('maps 403 (non-policy code) to PayBotAuthError', () => {
    const err = mapHttpError('forbidden', 'FORBIDDEN', 403);
    expect(err).toBeInstanceOf(PayBotAuthError);
    expect(err.statusCode).toBe(403);
  });

  it('maps everything else to plain PayBotApiError', () => {
    const err = mapHttpError('not found', 'NOT_FOUND', 404);
    expect(err).toBeInstanceOf(PayBotApiError);
    expect(err).not.toBeInstanceOf(PayBotAuthError);
    expect(err).not.toBeInstanceOf(PayBotPolicyError);
    expect(err.statusCode).toBe(404);
  });

  it('policy code wins even at a non-403 status', () => {
    const err = mapHttpError('limit', 'DAILY_LIMIT_EXCEEDED', 429);
    expect(err).toBeInstanceOf(PayBotPolicyError);
    expect(err.statusCode).toBe(429);
  });
});

describe('_request mapping via client (mocked fetch)', () => {
  let client: PayBotClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PayBotClient({
      apiKey: 'pb_test_key',
      botId: 'test-bot',
      facilitatorUrl: 'https://api.test.com',
      maxRetries: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws PayBotAuthError on 401', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    );
    await expect(client.balance()).rejects.toBeInstanceOf(PayBotAuthError);
  });

  it('throws PayBotAuthError on 403 (non-policy)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'Forbidden', code: 'FORBIDDEN' }, 403)
    );
    await expect(client.balance()).rejects.toBeInstanceOf(PayBotAuthError);
  });

  it('throws PayBotPolicyError for each server policy code', async () => {
    for (const code of POLICY_ERROR_CODES) {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'policy', code }, 403)
      );
      const caught = await client.balance().catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(PayBotPolicyError);
      expect((caught as PayBotPolicyError).code).toBe(code);
    }
  });

  it('throws plain PayBotApiError on a generic 404', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, 404)
    );
    const caught = await client.balance().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PayBotApiError);
    expect(caught).not.toBeInstanceOf(PayBotAuthError);
    expect(caught).not.toBeInstanceOf(PayBotPolicyError);
  });

  it('throws PayBotNetworkError when retries are exhausted on a transport failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const caught = await client.balance().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PayBotNetworkError);
    expect(caught).toBeInstanceOf(PayBotApiError);
    expect((caught as PayBotNetworkError).code).toBe('NETWORK_ERROR');
  });

  it('throws PayBotTimeoutError when fetch aborts (timeout)', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortErr);
    const caught = await client.balance().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PayBotTimeoutError);
    expect(caught).toBeInstanceOf(PayBotApiError);
    expect((caught as PayBotTimeoutError).code).toBe('TIMEOUT');
  });

  it('keeps instanceof PayBotApiError + .code on policy errors (back-compat)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'Trust violation', code: 'TRUST_VIOLATION' }, 403)
    );
    const caught = await client.balance().catch((e: unknown) => e);
    // Old callers do `instanceof PayBotApiError` + read `.code` — still works.
    expect(caught).toBeInstanceOf(PayBotApiError);
    expect((caught as PayBotApiError).code).toBe('TRUST_VIOLATION');
    expect((caught as PayBotApiError).statusCode).toBe(403);
  });
});
