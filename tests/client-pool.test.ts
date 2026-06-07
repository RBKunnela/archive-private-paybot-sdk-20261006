import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayBotClientPool } from '../src/client-pool.js';
import { PayBotClient } from '../src/client.js';

// Mock global fetch (mirrors tests/client.test.ts)
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

/** Queue a verify + settle pair for a successful pay(). */
function mockSuccessfulPay(): void {
  mockFetch.mockResolvedValueOnce(
    jsonResponse({
      valid: true,
      settlementToken: 'st_abc123',
      commission: {
        grossAmount: '50000',
        netAmount: '50000',
        commissionAmount: '0',
        commissionRate: 0,
      },
    })
  );
  mockFetch.mockResolvedValueOnce(
    jsonResponse({ success: true, transaction: '0xTxHash', network: 'eip155:84532' })
  );
}

const PK_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const PK_B = '0x2222222222222222222222222222222222222222222222222222222222222222';

describe('PayBotClientPool', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should throw on empty apiKey', () => {
      // @ts-expect-error testing runtime validation
      expect(() => new PayBotClientPool({})).toThrow('apiKey is required');
    });

    it('should throw on negative sharedDailyLimitUsd', () => {
      expect(() => new PayBotClientPool({ apiKey: 'k', sharedDailyLimitUsd: -1 })).toThrow(
        'sharedDailyLimitUsd'
      );
    });

    it('should construct with just an apiKey', () => {
      const pool = new PayBotClientPool({ apiKey: 'pb_test' });
      expect(pool.size).toBe(0);
      expect(pool.remainingTreasuryUsd()).toBeNull();
    });
  });

  describe('bot lifecycle', () => {
    let pool: PayBotClientPool;

    beforeEach(() => {
      pool = new PayBotClientPool({ apiKey: 'pb_test', facilitatorUrl: 'https://api.test.com' });
    });

    it('addBot should return a PayBotClient and register it', () => {
      const client = pool.addBot({ botId: 'bot-a' });
      expect(client).toBeInstanceOf(PayBotClient);
      expect(pool.hasBot('bot-a')).toBe(true);
      expect(pool.size).toBe(1);
      expect(pool.botIds()).toEqual(['bot-a']);
    });

    it('getBot should return the same client instance that addBot returned', () => {
      const added = pool.addBot({ botId: 'bot-a' });
      expect(pool.getBot('bot-a')).toBe(added);
    });

    it('addBot should throw on duplicate botId', () => {
      pool.addBot({ botId: 'bot-a' });
      expect(() => pool.addBot({ botId: 'bot-a' })).toThrow('already added: bot-a');
    });

    it('getBot should throw on unknown botId', () => {
      expect(() => pool.getBot('nope')).toThrow('unknown bot: nope');
    });

    it('removeBot should drop the bot and return true, false when absent', () => {
      pool.addBot({ botId: 'bot-a' });
      expect(pool.removeBot('bot-a')).toBe(true);
      expect(pool.hasBot('bot-a')).toBe(false);
      expect(pool.size).toBe(0);
      expect(pool.removeBot('bot-a')).toBe(false);
    });

    it('botIds should reflect multiple bots in insertion order', () => {
      pool.addBot({ botId: 'bot-a' });
      pool.addBot({ botId: 'bot-b' });
      expect(pool.botIds()).toEqual(['bot-a', 'bot-b']);
      expect(pool.size).toBe(2);
    });
  });

  describe('per-bot signing isolation', () => {
    it('each bot retains its own walletPrivateKey (no cross-contamination)', async () => {
      const pool = new PayBotClientPool({ apiKey: 'pb_test', facilitatorUrl: 'https://api.test.com' });
      pool.addBot({ botId: 'bot-a', walletPrivateKey: PK_A });
      pool.addBot({ botId: 'bot-b', walletPrivateKey: PK_B });

      // bot-a signs and pays; capture the EIP-3009 `from` address it signed with.
      mockSuccessfulPay();
      await pool.getBot('bot-a').pay({
        resource: 'https://api.example.com/data',
        amount: '0.05',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      const verifyBodyA = JSON.parse(mockFetch.mock.calls[0][1].body);
      const signedFromA = JSON.parse(verifyBodyA.payload.payload).from;

      mockFetch.mockReset();

      // bot-b signs and pays; its `from` must differ from bot-a's.
      mockSuccessfulPay();
      await pool.getBot('bot-b').pay({
        resource: 'https://api.example.com/data',
        amount: '0.05',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      const verifyBodyB = JSON.parse(mockFetch.mock.calls[0][1].body);
      const signedFromB = JSON.parse(verifyBodyB.payload.payload).from;

      expect(signedFromA).not.toBe(signedFromB);
      // Each verify body also carries the bot's own id.
      expect(verifyBodyB.botId).toBe('bot-b');
    });
  });

  describe('shared treasury', () => {
    it('remainingTreasuryUsd is null without a shared limit, canSpend always true', () => {
      const pool = new PayBotClientPool({ apiKey: 'pb_test' });
      pool.addBot({ botId: 'bot-a' });
      expect(pool.remainingTreasuryUsd()).toBeNull();
      expect(pool.canSpend(1_000_000)).toBe(true);
    });

    it('canSpend is true under the limit and false over it', () => {
      const pool = new PayBotClientPool({ apiKey: 'pb_test', sharedDailyLimitUsd: 100 });
      pool.addBot({ botId: 'bot-a' });
      expect(pool.canSpend(50)).toBe(true);
      expect(pool.canSpend(100)).toBe(true);
      expect(pool.canSpend(100.01)).toBe(false);
    });

    it('recordSpend decrements the remaining treasury', () => {
      const pool = new PayBotClientPool({ apiKey: 'pb_test', sharedDailyLimitUsd: 100 });
      pool.addBot({ botId: 'bot-a' });
      pool.recordSpend('bot-a', 30);
      expect(pool.remainingTreasuryUsd()).toBe(70);
      pool.recordSpend('bot-a', 70);
      expect(pool.remainingTreasuryUsd()).toBe(0);
      expect(pool.canSpend(0.01)).toBe(false);
    });

    it('canSpend treats non-finite / negative amounts as zero-cost under a limit', () => {
      const pool = new PayBotClientPool({ apiKey: 'pb_test', sharedDailyLimitUsd: 100 });
      pool.addBot({ botId: 'bot-a' });
      pool.recordSpend('bot-a', 100); // treasury fully drained
      expect(pool.remainingTreasuryUsd()).toBe(0);
      // A zero-cost spend always fits, even at an exhausted treasury.
      expect(pool.canSpend(NaN)).toBe(true);
      expect(pool.canSpend(-5)).toBe(true);
    });

    it('recordSpend ignores negative / non-finite amounts', () => {
      const pool = new PayBotClientPool({ apiKey: 'pb_test', sharedDailyLimitUsd: 100 });
      pool.addBot({ botId: 'bot-a' });
      pool.recordSpend('bot-a', -50);
      pool.recordSpend('bot-a', NaN);
      expect(pool.remainingTreasuryUsd()).toBe(100);
    });
  });

  describe('payAs', () => {
    let pool: PayBotClientPool;

    beforeEach(() => {
      pool = new PayBotClientPool({
        apiKey: 'pb_test',
        facilitatorUrl: 'https://api.test.com',
        sharedDailyLimitUsd: 100,
      });
      pool.addBot({ botId: 'bot-a' });
    });

    it('blocks an over-limit spend with TREASURY_EXCEEDED and makes NO network call', async () => {
      pool.recordSpend('bot-a', 99); // remaining 1 USD
      const result = await pool.payAs('bot-a', {
        resource: 'https://api.example.com/data',
        amount: '5',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('TREASURY_EXCEEDED');
      expect(mockFetch).not.toHaveBeenCalled();
      // Blocked spend must not be recorded.
      expect(pool.remainingTreasuryUsd()).toBe(1);
    });

    it('records spend on success and decrements remaining', async () => {
      mockSuccessfulPay();
      const result = await pool.payAs('bot-a', {
        resource: 'https://api.example.com/data',
        amount: '10',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      expect(result.success).toBe(true);
      expect(pool.remainingTreasuryUsd()).toBe(90);
      expect(pool.botStats('bot-a')).toEqual({ dailySpentUsd: 10, dailyTxCount: 1 });
    });

    it('does NOT record spend when the underlying pay fails', async () => {
      // verify returns a 4xx → pay() resolves success:false (no throw)
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Trust violation', code: 'TRUST_VIOLATION' }, 403)
      );
      const result = await pool.payAs('bot-a', {
        resource: 'https://api.example.com/data',
        amount: '10',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      expect(result.success).toBe(false);
      expect(pool.remainingTreasuryUsd()).toBe(100);
      expect(pool.botStats('bot-a')).toEqual({ dailySpentUsd: 0, dailyTxCount: 0 });
    });

    it('throws when paying as an unknown bot', async () => {
      await expect(
        pool.payAs('ghost', {
          resource: 'https://api.example.com/data',
          amount: '1',
          payTo: '0x0000000000000000000000000000000000000001',
        })
      ).rejects.toThrow('unknown bot: ghost');
    });

    it('pays normally when no shared limit is configured', async () => {
      const unlimited = new PayBotClientPool({
        apiKey: 'pb_test',
        facilitatorUrl: 'https://api.test.com',
      });
      unlimited.addBot({ botId: 'bot-a' });
      mockSuccessfulPay();
      const result = await unlimited.payAs('bot-a', {
        resource: 'https://api.example.com/data',
        amount: '10',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      expect(result.success).toBe(true);
      expect(unlimited.botStats('bot-a')).toEqual({ dailySpentUsd: 10, dailyTxCount: 1 });
    });

    // ── CodeRabbit #3: reject non-finite/unparseable/negative amounts ──────
    it.each(['nan', 'inf', '-inf', 'abc', '-5', '1abc', ''])(
      'rejects amount %j with INVALID_AMOUNT before any treasury math or network call',
      async (badAmount) => {
        // CodeRabbit #3: nan/inf/unparseable/negative amounts were coerced via
        // parseFloat → NaN and treated as zero-cost, sailing past the treasury
        // without ever being debited. They must be rejected pre-network.
        const result = await pool.payAs('bot-a', {
          resource: 'https://api.example.com/data',
          amount: badAmount,
          payTo: '0x0000000000000000000000000000000000000001',
        });
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('INVALID_AMOUNT');
        expect(mockFetch).not.toHaveBeenCalled();
        expect(pool.remainingTreasuryUsd()).toBe(100); // treasury untouched
      },
    );

    it('rejects a non-finite amount even when unbounded (no shared limit)', async () => {
      const unlimited = new PayBotClientPool({
        apiKey: 'pb_test',
        facilitatorUrl: 'https://api.test.com',
      });
      unlimited.addBot({ botId: 'bot-a' });
      const result = await unlimited.payAs('bot-a', {
        resource: 'https://api.example.com/data',
        amount: 'inf',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      expect(result.errorCode).toBe('INVALID_AMOUNT');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── CodeRabbit #4: treasury concurrency (reserve/commit/refund) ──────────
  describe('payAs concurrency', () => {
    /** A success PaymentResult, mirroring Python's _ok_result(). */
    function okResult() {
      return {
        success: true,
        grossAmount: '0',
        netAmount: '0',
        commissionAmount: '0',
        commissionRate: 0,
      };
    }

    it('never overruns the shared limit under concurrent payAs (CodeRabbit #4)', async () => {
      // Limit admits exactly 5 of 10 concurrent $10 spends. Each stubbed pay()
      // awaits a tick so all promises interleave between the limit check and the
      // spend record — the exact window the synchronous reservation must close.
      // Without reserve-before-await, every caller would pass the check and the
      // treasury would overrun.
      const pool = new PayBotClientPool({
        apiKey: 'pb_test',
        facilitatorUrl: 'https://api.test.com',
        sharedDailyLimitUsd: 50,
      });
      const client = pool.addBot({ botId: 'bot-a' });

      // Yielding async stub: forces interleaving before the result resolves.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).pay = async () => {
        await new Promise((r) => setTimeout(r, 0));
        return okResult();
      };

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          pool.payAs('bot-a', {
            resource: 'r',
            amount: '10',
            payTo: '0x0000000000000000000000000000000000000001',
          }),
        ),
      );

      const successes = results.filter((r) => r.success);
      const rejections = results.filter((r) => !r.success);
      expect(successes).toHaveLength(5);
      expect(rejections.every((r) => r.errorCode === 'TREASURY_EXCEEDED')).toBe(true);
      expect(pool.remainingTreasuryUsd()).toBe(0); // never exceeded the cap
      expect(pool.botStats('bot-a').dailyTxCount).toBe(5);
    });

    it('refunds the reservation when pay() throws (CodeRabbit #4)', async () => {
      // An exception from pay() must refund the reservation so the treasury is
      // not permanently debited for a payment that never happened.
      const pool = new PayBotClientPool({
        apiKey: 'pb_test',
        facilitatorUrl: 'https://api.test.com',
        sharedDailyLimitUsd: 100,
      });
      const client = pool.addBot({ botId: 'bot-a' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).pay = async () => {
        await new Promise((r) => setTimeout(r, 0));
        throw new Error('network exploded');
      };

      await expect(
        pool.payAs('bot-a', {
          resource: 'r',
          amount: '30',
          payTo: '0x0000000000000000000000000000000000000001',
        }),
      ).rejects.toThrow('network exploded');
      expect(pool.remainingTreasuryUsd()).toBe(100); // reservation refunded
    });
  });

  describe('botStats', () => {
    it('counts spend and tx per bot independently', async () => {
      const pool = new PayBotClientPool({ apiKey: 'pb_test', facilitatorUrl: 'https://api.test.com' });
      pool.addBot({ botId: 'bot-a' });
      pool.addBot({ botId: 'bot-b' });

      mockSuccessfulPay();
      await pool.payAs('bot-a', {
        resource: 'r',
        amount: '4',
        payTo: '0x0000000000000000000000000000000000000001',
      });
      mockSuccessfulPay();
      await pool.payAs('bot-a', {
        resource: 'r',
        amount: '6',
        payTo: '0x0000000000000000000000000000000000000001',
      });

      expect(pool.botStats('bot-a')).toEqual({ dailySpentUsd: 10, dailyTxCount: 2 });
      expect(pool.botStats('bot-b')).toEqual({ dailySpentUsd: 0, dailyTxCount: 0 });
    });

    it('throws on unknown bot', () => {
      const pool = new PayBotClientPool({ apiKey: 'pb_test' });
      expect(() => pool.botStats('nope')).toThrow('unknown bot: nope');
    });
  });

  describe('day rollover', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('resets shared treasury and per-bot counters when the UTC day changes', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));

      const pool = new PayBotClientPool({ apiKey: 'pb_test', sharedDailyLimitUsd: 100 });
      pool.addBot({ botId: 'bot-a' });
      pool.recordSpend('bot-a', 60);
      expect(pool.remainingTreasuryUsd()).toBe(40);
      expect(pool.botStats('bot-a')).toEqual({ dailySpentUsd: 60, dailyTxCount: 1 });

      // Advance into the next UTC day.
      vi.setSystemTime(new Date('2026-06-02T00:00:01Z'));
      expect(pool.remainingTreasuryUsd()).toBe(100);
      expect(pool.canSpend(100)).toBe(true);
      expect(pool.botStats('bot-a')).toEqual({ dailySpentUsd: 0, dailyTxCount: 0 });
    });
  });
});
