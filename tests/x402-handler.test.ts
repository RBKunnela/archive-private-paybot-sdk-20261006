import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createX402Handler } from '../src/x402-handler.js';
import { PayBotClient } from '../src/client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers(headers),
    clone: () => jsonResponse(data, status, headers),
  } as unknown as Response;
}

describe('createX402Handler', () => {
  let handler: ReturnType<typeof createX402Handler>;

  beforeEach(() => {
    mockFetch.mockReset();
    handler = createX402Handler({
      apiKey: 'pb_test',
      botId: 'x402-bot',
      facilitatorUrl: 'https://api.test.com',
      maxAutoPay: '5.00',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should expose the underlying PayBotClient', () => {
    expect(handler.client).toBeInstanceOf(PayBotClient);
  });

  it('should pass through non-402 responses unchanged', async () => {
    const okResponse = jsonResponse({ data: 'hello' }, 200);
    mockFetch.mockResolvedValueOnce(okResponse);

    const result = await handler.fetch('https://api.example.com/free');
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should pass through non-402 error responses', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404));

    const result = await handler.fetch('https://api.example.com/missing');
    expect(result.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should auto-pay on 402 with x402 format and retry', async () => {
    // First call: 402 with payment requirements
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        paymentRequirements: { amount: '1000000', payTo: '0x1234' },
      }, 402)
    );
    // PayBot verify call
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        valid: true,
        settlementToken: 'st_token',
        commission: { grossAmount: '1025000', netAmount: '1000000', commissionAmount: '25000', commissionRate: 0.025 },
      })
    );
    // PayBot settle call
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, transaction: '0xTx', network: 'eip155:84532' })
    );
    // Retry original request (now with payment proof)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: 'paid content' }, 200)
    );

    const result = await handler.fetch('https://api.example.com/paid');
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.data).toBe('paid content');

    // 4 total fetch calls: original 402, verify, settle, retry
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('should throw when amount exceeds maxAutoPay', async () => {
    // 402 with $10 payment (limit is $5)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        paymentRequirements: { amount: '10000000', payTo: '0x1234' },
      }, 402)
    );

    await expect(handler.fetch('https://api.example.com/expensive')).rejects.toThrow(
      /exceeds auto-pay limit/
    );
  });

  it('should throw when payment fails', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ amount: '100000', payTo: '0x1234' }, 402)
    );
    // Verify fails
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'Trust violation', code: 'TRUST_VIOLATION' }, 403)
    );

    await expect(handler.fetch('https://api.example.com/paid')).rejects.toThrow(
      /Payment failed/
    );
  });

  it('should return original 402 if requirements cannot be parsed', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ unrelated: 'data' }, 402)
    );

    const result = await handler.fetch('https://api.example.com/weird');
    expect(result.status).toBe(402);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should parse simplified 402 format (amount + payTo at root)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ amount: '500000', payTo: '0xABCD' }, 402)
    );
    // verify
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ valid: true, settlementToken: 'st_x', commission: {} })
    );
    // settle
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, transaction: '0xTx' })
    );
    // retry
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

    const result = await handler.fetch('https://api.example.com/paid');
    expect(result.status).toBe(200);
  });

  it('should default maxAutoPay to $1.00', () => {
    const h = createX402Handler({
      apiKey: 'pb_test',
      botId: 'bot',
      facilitatorUrl: 'https://api.test.com',
    });

    // Internally maxAutoPay defaults to '1.00' — tested via behavior:
    // $2 payment should exceed limit
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ paymentRequirements: { amount: '2000000', payTo: '0x1' } }, 402)
    );

    expect(h.fetch('https://example.com')).rejects.toThrow(/exceeds auto-pay limit/);
  });

  it('should parse header-based 402 format (X-Payment-Amount + X-Payment-Address)', async () => {
    // 402 with payment info in headers only
    mockFetch.mockResolvedValueOnce(
      jsonResponse({}, 402, {
        'X-Payment-Amount': '500000',
        'X-Payment-Address': '0xHeaderAddr',
      })
    );
    // verify
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ valid: true, settlementToken: 'st_h', commission: {} })
    );
    // settle
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, transaction: '0xTxH' })
    );
    // retry
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

    const result = await handler.fetch('https://api.example.com/header-pay');
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});
