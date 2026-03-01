import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayBotClient } from '../src/client.js';
import { PayBotApiError } from '../src/errors.js';

// Mock global fetch
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

describe('PayBotClient', () => {
  let client: PayBotClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PayBotClient({
      apiKey: 'pb_test_key',
      botId: 'test-bot',
      facilitatorUrl: 'https://api.test.com',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor defaults', () => {
    it('should default facilitatorUrl to api.paybotcore.com', async () => {
      const c = new PayBotClient({ apiKey: 'key', botId: 'bot' });
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
      await c.health();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.paybotcore.com/health'),
        expect.anything()
      );
    });
  });

  describe('constructor validation', () => {
    it('should throw on empty apiKey', () => {
      expect(() => new PayBotClient({ apiKey: '', botId: 'bot' })).toThrow('apiKey is required');
    });

    it('should throw on empty botId', () => {
      expect(() => new PayBotClient({ apiKey: 'key', botId: '' })).toThrow('botId is required');
    });

    it('should throw on invalid facilitatorUrl', () => {
      expect(() => new PayBotClient({ apiKey: 'key', botId: 'bot', facilitatorUrl: 'not-a-url' })).toThrow('not a valid URL');
    });

    it('should throw on walletPrivateKey without 0x prefix', () => {
      expect(() => new PayBotClient({ apiKey: 'key', botId: 'bot', walletPrivateKey: 'abc123' })).toThrow('must start with 0x');
    });

    it('should accept valid walletPrivateKey with 0x prefix', () => {
      expect(() => new PayBotClient({ apiKey: 'key', botId: 'bot', walletPrivateKey: '0xabc123' })).not.toThrow();
    });

    it('should accept valid facilitatorUrl', () => {
      expect(() => new PayBotClient({ apiKey: 'key', botId: 'bot', facilitatorUrl: 'https://example.com' })).not.toThrow();
    });
  });

  describe('health()', () => {
    it('should return health data on success', async () => {
      const data = { status: 'ok', version: '0.2.0', uptime: 100, timestamp: '2026-01-01' };
      mockFetch.mockResolvedValueOnce(jsonResponse(data));
      const result = await client.health();
      expect(result).toEqual(data);
    });

    it('should call GET /health with API key header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
      await client.health();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/health',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ 'X-API-Key': 'pb_test_key' }),
        })
      );
    });

    it('should throw PayBotApiError on non-2xx', async () => {
      // Mock 500 twice (initial + 1 retry)
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Server error', code: 'INTERNAL' }, 500)
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Server error', code: 'INTERNAL' }, 500)
      );
      await expect(client.health()).rejects.toThrow(PayBotApiError);

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Server error', code: 'INTERNAL' }, 500)
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Server error', code: 'INTERNAL' }, 500)
      );
      await expect(
        client.health().catch((e: PayBotApiError) => {
          expect(e.statusCode).toBe(500);
          throw e;
        })
      ).rejects.toThrow();
    });

    it('should throw PayBotApiError on 4xx without retry', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, 404)
      );
      try {
        await client.health();
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(PayBotApiError);
        expect((e as PayBotApiError).statusCode).toBe(404);
        expect((e as PayBotApiError).code).toBe('NOT_FOUND');
      }
      // Only 1 fetch call (no retry on 4xx)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw PayBotApiError on network failure', async () => {
      // Mock rejection twice (initial + 1 retry)
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      try {
        await client.health();
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(PayBotApiError);
        expect((e as PayBotApiError).code).toBe('NETWORK_ERROR');
        expect((e as PayBotApiError).message).toContain('Connection refused');
      }
    });

    it('should retry on 5xx and succeed on second attempt', async () => {
      // First attempt: 500
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Server error' }, 500)
      );
      // Retry: 200
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: 'ok', version: '0.2.0', uptime: 100, timestamp: '2026-01-01' })
      );
      const result = await client.health();
      expect(result.status).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('balance()', () => {
    it('should return balance data with botId query param', async () => {
      const data = {
        botId: 'test-bot',
        trustLevel: 2,
        trustLevelName: 'Verified',
        dailySpentUsd: 5,
        dailyLimitUsd: 100,
        dailyRemainingUsd: 95,
        hourlyTransactions: 3,
        hourlyLimit: 50,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(data));
      const result = await client.balance();
      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('botId=test-bot'),
        expect.anything()
      );
    });

    it('should throw PayBotApiError on 404', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Bot not found', code: 'NOT_FOUND' }, 404)
      );
      await expect(client.balance()).rejects.toThrow(PayBotApiError);
    });
  });

  describe('history()', () => {
    it('should return array of events', async () => {
      const data = [{ eventId: '1', timestamp: '2026-01-01', eventType: 'PAYMENT', action: 'paid', details: {} }];
      mockFetch.mockResolvedValueOnce(jsonResponse(data));
      const result = await client.history();
      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=50'),
        expect.anything()
      );
    });

    it('should pass custom limit', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await client.history(5);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=5'),
        expect.anything()
      );
    });
  });

  describe('register()', () => {
    it('should POST to /bots and return result', async () => {
      const data = { success: true, botId: 'test-bot', trustLevel: 1 };
      mockFetch.mockResolvedValueOnce(jsonResponse(data));
      const result = await client.register();
      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/bots',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"trustLevel":1'),
        })
      );
    });

    it('should pass custom trust level', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, botId: 'test-bot', trustLevel: 3 }));
      await client.register(3);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining('"trustLevel":3'),
        })
      );
    });

    it('should throw PayBotApiError on 409 (already registered)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Bot already registered', code: 'ALREADY_EXISTS' }, 409)
      );
      try {
        await client.register();
      } catch (e) {
        expect(e).toBeInstanceOf(PayBotApiError);
        expect((e as PayBotApiError).statusCode).toBe(409);
        expect((e as PayBotApiError).code).toBe('ALREADY_EXISTS');
      }
    });
  });

  describe('setLimits()', () => {
    it('should PUT to /limits with bot ID and limits', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
      await client.setLimits({ maxTransactionUsd: 5, maxDailySpendUsd: 50 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/limits',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"botId":"test-bot"'),
        })
      );
    });

    it('should throw on non-existent bot', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Bot not found', code: 'NOT_FOUND' }, 404)
      );
      await expect(client.setLimits({ maxTransactionUsd: 5 })).rejects.toThrow(PayBotApiError);
    });
  });

  describe('pay()', () => {
    it('should return success result after verify + settle', async () => {
      // Verify response
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          valid: true,
          settlementToken: 'st_abc123',
          modifiedRequirements: { scheme: 'exact', amount: '51250' },
          commission: { grossAmount: '51250', netAmount: '50000', commissionAmount: '1250', commissionRate: 0.025 },
        })
      );
      // Settle response
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, transaction: '0xTxHash', network: 'eip155:84532' })
      );

      const result = await client.pay({
        resource: 'https://api.example.com/data',
        amount: '0.05',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      expect(result.success).toBe(true);
      expect(result.txHash).toBe('0xTxHash');
      expect(result.grossAmount).toBe('51250');
      expect(result.commissionRate).toBe(0.025);
    });

    it('should return failure result (not throw) when verify fails', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Trust violation', code: 'TRUST_VIOLATION' }, 403)
      );

      const result = await client.pay({
        resource: 'https://api.example.com/data',
        amount: '100.00',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Trust violation');
      expect(result.errorCode).toBe('TRUST_VIOLATION');
    });

    it('should return failure when verify response has no settlement token', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ valid: true }) // no settlementToken
      );

      const result = await client.pay({
        resource: 'https://api.example.com/data',
        amount: '0.05',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('settlement token');
    });

    it('should return failure result (not throw) when settle fails', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          valid: true,
          settlementToken: 'st_abc',
          commission: { grossAmount: '51250', netAmount: '50000', commissionAmount: '1250', commissionRate: 0.025 },
        })
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Intent mismatch', code: 'VERIFICATION_FAILED' }, 400)
      );

      const result = await client.pay({
        resource: 'https://example.com',
        amount: '0.05',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Intent mismatch');
    });

    it('should return failure on network error (never throws)', async () => {
      // Mock rejection twice (initial + 1 retry)
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await client.pay({
        resource: 'https://example.com',
        amount: '0.05',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('should use mock payload format when no walletPrivateKey', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ valid: true, settlementToken: 'st_x', commission: {} })
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.pay({
        resource: 'https://example.com',
        amount: '1.00',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(verifyCall.payload.payload).toBe('payer:test-bot');
    });

    it('should convert USD amount to USDC base units correctly', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ valid: true, settlementToken: 'st_x', commission: {} })
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.pay({
        resource: 'https://example.com',
        amount: '0.05',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(verifyCall.requirements.amount).toBe('50000');
    });

    it('should convert whole dollar amounts correctly', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ valid: true, settlementToken: 'st_x', commission: {} })
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.pay({
        resource: 'https://example.com',
        amount: '10',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(verifyCall.requirements.amount).toBe('10000000');
    });

    it('should return failure on negative amount', async () => {
      const result = await client.pay({
        resource: 'https://example.com',
        amount: '-1',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid USD amount');
    });

    it('should return failure on non-numeric amount', async () => {
      const result = await client.pay({
        resource: 'https://example.com',
        amount: 'abc',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid USD amount');
    });

    it('should return failure on empty amount', async () => {
      const result = await client.pay({
        resource: 'https://example.com',
        amount: '',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Amount must be a non-empty string');
    });

    it('should pass custom network and tokenContract through', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ valid: true, settlementToken: 'st_custom', commission: {} })
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.pay({
        resource: 'https://example.com',
        amount: '1.00',
        payTo: '0x0000000000000000000000000000000000000001',
        network: 'eip155:8453',
        tokenContract: '0xCustomToken',
      });

      const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(verifyCall.requirements.network).toBe('eip155:8453');
      expect(verifyCall.requirements.asset).toBe('eip155:8453/erc20:0xCustomToken');
    });

    it('should use USDC address from NETWORKS config when no tokenContract specified', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ valid: true, settlementToken: 'st_net', commission: {} })
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.pay({
        resource: 'https://example.com',
        amount: '1.00',
        payTo: '0x0000000000000000000000000000000000000001',
        network: 'eip155:8453',
      });

      const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      // Should use Base Mainnet USDC address from networks.ts
      expect(verifyCall.requirements.asset).toContain('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    });

    it('should convert fractional-only amounts correctly', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ valid: true, settlementToken: 'st_f', commission: {} })
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.pay({
        resource: 'https://example.com',
        amount: '0.000001',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(verifyCall.requirements.amount).toBe('1');
    });
  });

  describe('EIP-3009 signing', () => {
    it('should produce signed payload with valid structure when walletPrivateKey is set', async () => {
      const signingClient = new PayBotClient({
        apiKey: 'pb_test_key',
        botId: 'sign-bot',
        facilitatorUrl: 'https://api.test.com',
        walletPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        maxRetries: 0,
      });

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ valid: true, settlementToken: 'st_sign', commission: {} })
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, transaction: '0xSignedTx' })
      );

      const result = await signingClient.pay({
        resource: 'https://example.com',
        amount: '0.01',
        payTo: '0x0000000000000000000000000000000000000001',
        network: 'eip155:84532',
      });

      expect(result.success).toBe(true);

      // Verify the payload sent to verify endpoint contains signed EIP-3009 data
      const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      const signedPayload = JSON.parse(verifyCall.payload.payload);

      expect(signedPayload.from).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(signedPayload.to).toBe('0x0000000000000000000000000000000000000001');
      expect(signedPayload.value).toBe('10000');
      expect(signedPayload.signature).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(signedPayload.nonce).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(signedPayload.validAfter).toBe('0');
      expect(Number(signedPayload.validBefore)).toBeGreaterThan(0);
    });
  });
});
