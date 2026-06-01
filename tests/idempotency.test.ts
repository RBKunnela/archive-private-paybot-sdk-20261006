import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

/** Queue a successful verify+settle pair (one full pay() round-trip = 2 fetches). */
function mockSuccessfulPay(txHash = '0xTxHash'): void {
  mockFetch.mockResolvedValueOnce(
    jsonResponse({
      valid: true,
      settlementToken: 'st_abc',
      commission: { grossAmount: '51250', netAmount: '50000', commissionAmount: '1250', commissionRate: 0.025 },
    })
  );
  mockFetch.mockResolvedValueOnce(
    jsonResponse({ success: true, transaction: txHash, network: 'eip155:84532' })
  );
}

const payReq = (overrides: Record<string, unknown> = {}) => ({
  resource: 'https://api.example.com/data',
  amount: '0.05',
  payTo: '0x0000000000000000000000000000000000000001',
  ...overrides,
});

describe('Idempotency — pay()', () => {
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

  it('returns the cached result on a repeat call with the same key (no second round-trip)', async () => {
    mockSuccessfulPay('0xFIRST');

    const first = await client.pay(payReq({ idempotencyKey: 'key-1' }));
    expect(first.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2); // verify + settle

    // Second call: no new mocks queued, so any network access would reject.
    const second = await client.pay(payReq({ idempotencyKey: 'key-1' }));
    expect(second).toEqual(first);
    expect(second.txHash).toBe('0xFIRST');
    expect(mockFetch).toHaveBeenCalledTimes(2); // still only the first round-trip
  });

  it('makes two round-trips for two different keys', async () => {
    mockSuccessfulPay('0xA');
    mockSuccessfulPay('0xB');

    const a = await client.pay(payReq({ idempotencyKey: 'key-a' }));
    const b = await client.pay(payReq({ idempotencyKey: 'key-b' }));

    expect(a.txHash).toBe('0xA');
    expect(b.txHash).toBe('0xB');
    expect(mockFetch).toHaveBeenCalledTimes(4); // 2 round-trips × 2 fetches
  });

  it('does not cache a failed pay() (failure → retry actually hits the network)', async () => {
    // First attempt: verify fails with a 4xx → PaymentResult success:false
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'Trust violation', code: 'TRUST_VIOLATION' }, 403)
    );

    const failed = await client.pay(payReq({ idempotencyKey: 'key-fail' }));
    expect(failed.success).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1); // verify only

    // Retry with the same key must NOT short-circuit — it hits the network again.
    mockSuccessfulPay('0xRECOVERED');
    const recovered = await client.pay(payReq({ idempotencyKey: 'key-fail' }));
    expect(recovered.success).toBe(true);
    expect(recovered.txHash).toBe('0xRECOVERED');
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 failed verify + 1 verify + 1 settle
  });

  it('sends the X-Idempotency-Key header on the /verify request', async () => {
    mockSuccessfulPay();
    await client.pay(payReq({ idempotencyKey: 'wire-key' }));

    const verifyCall = mockFetch.mock.calls[0];
    const url = verifyCall[0] as string;
    const opts = verifyCall[1] as RequestInit;
    expect(url).toContain('/verify');
    expect((opts.headers as Record<string, string>)['X-Idempotency-Key']).toBe('wire-key');
  });

  it('does not send the header when no key is provided', async () => {
    mockSuccessfulPay();
    await client.pay(payReq());

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)['X-Idempotency-Key']).toBeUndefined();
  });

  it('caches are per-instance (a second client does not see the first client cache)', async () => {
    mockSuccessfulPay('0xClientA');
    const a = await client.pay(payReq({ idempotencyKey: 'shared-key' }));
    expect(a.txHash).toBe('0xClientA');

    const otherClient = new PayBotClient({
      apiKey: 'pb_test_key',
      botId: 'other-bot',
      facilitatorUrl: 'https://api.test.com',
      maxRetries: 0,
    });
    mockSuccessfulPay('0xClientB');
    const b = await otherClient.pay(payReq({ idempotencyKey: 'shared-key' }));
    // Different instance → own cache → real round-trip → different tx.
    expect(b.txHash).toBe('0xClientB');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

describe('Idempotency — register()', () => {
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

  it('returns cached result on repeat call with same key', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, botId: 'test-bot', trustLevel: 2 })
    );

    const first = await client.register(2, 'reg-key');
    expect(first.trustLevel).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const second = await client.register(2, 'reg-key');
    expect(second).toEqual(first);
    expect(mockFetch).toHaveBeenCalledTimes(1); // no second round-trip
  });

  it('makes two calls for two different keys', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, botId: 'b', trustLevel: 1 }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, botId: 'b', trustLevel: 1 }));

    await client.register(1, 'k1');
    await client.register(1, 'k2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed register (throws, then retry hits the network)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'Already registered', code: 'ALREADY_EXISTS' }, 409)
    );
    await expect(client.register(1, 'reg-fail')).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, botId: 'b', trustLevel: 1 }));
    const ok = await client.register(1, 'reg-fail');
    expect(ok.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2); // retry actually went to the network
  });

  it('sends X-Idempotency-Key header on the /bots request', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, botId: 'b', trustLevel: 1 }));
    await client.register(1, 'reg-wire');

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)['X-Idempotency-Key']).toBe('reg-wire');
  });

  it('omits the header when no key is provided (back-compat)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, botId: 'b', trustLevel: 1 }));
    await client.register();

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)['X-Idempotency-Key']).toBeUndefined();
  });
});

describe('Idempotency — LRU eviction at cap', () => {
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

  it('evicts the oldest key once the cache exceeds its cap of 256', async () => {
    // Fill the register cache with 256 distinct keys.
    for (let i = 0; i < 256; i++) {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, botId: 'b', trustLevel: 1 }));
      await client.register(1, `cap-key-${i}`);
    }
    expect(mockFetch).toHaveBeenCalledTimes(256);

    // key-0 is still cached → repeat is a cache hit (no new fetch).
    await client.register(1, 'cap-key-0');
    expect(mockFetch).toHaveBeenCalledTimes(256);

    // Insert one more NEW key (257th distinct). With key-0 just refreshed by the
    // hit above, the oldest entry is now key-1 — it should be evicted.
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, botId: 'b', trustLevel: 1 }));
    await client.register(1, 'cap-key-256');
    expect(mockFetch).toHaveBeenCalledTimes(257);

    // key-1 was evicted → repeat must hit the network again.
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, botId: 'b', trustLevel: 1 }));
    await client.register(1, 'cap-key-1');
    expect(mockFetch).toHaveBeenCalledTimes(258);

    // key-0 (recently used) is still cached → no fetch.
    await client.register(1, 'cap-key-0');
    expect(mockFetch).toHaveBeenCalledTimes(258);
  });
});
