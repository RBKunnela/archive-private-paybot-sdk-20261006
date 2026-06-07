/**
 * A5b — SDK pending-approval (HITL) support.
 *
 * Covers the three new units (contract §3, story AC1–AC12):
 *  - the core-envelope → PaymentResult mapper (`mapPendingEnvelope`),
 *  - `client.pay()` mapping a /verify pending envelope (non-throwing),
 *  - `client.waitForApproval()` poll loop (settled/denied/expired/timeout/error),
 *  - the x402 auto-handler pending pass-through (non-blocking, distinct from the
 *    over-ceiling throw).
 *
 * All HTTP is mocked via a stubbed global fetch (no network).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayBotClient, mapPendingEnvelope, amountToBaseUnitsUsd } from '../src/client.js';
import { createX402Handler } from '../src/x402-handler.js';

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

const PAYEE = '0x0000000000000000000000000000000000000001';

// ── amountToBaseUnitsUsd (helper) ───────────────────────────────────────────
describe('amountToBaseUnitsUsd', () => {
  it('[UNIT] should convert a whole-dollar USD number to USDC base units (happy)', () => {
    expect(amountToBaseUnitsUsd(500)).toBe('500000000');
  });

  it('[UNIT] should return "0" for a missing/non-finite input (error)', () => {
    expect(amountToBaseUnitsUsd(undefined)).toBe('0');
    expect(amountToBaseUnitsUsd('not-a-number')).toBe('0');
    expect(amountToBaseUnitsUsd(-5)).toBe('0');
  });

  it('[UNIT] should round fractional cents without float drift (edge)', () => {
    expect(amountToBaseUnitsUsd(0.1)).toBe('100000');
    expect(amountToBaseUnitsUsd('1.234567')).toBe('1234567');
  });
});

// ── mapPendingEnvelope (mapper) ─────────────────────────────────────────────
describe('mapPendingEnvelope', () => {
  const envelope = {
    status: 'pending_approval',
    approval_id: 'ap_123',
    poll_url: '/approvals/ap_123',
    expires_at: '2026-06-08T12:15:00.000Z',
    amount_usd: 500,
    reason: 'Amount $500 in approval band ($100–$1000) — operator decision required',
  };

  it('[UNIT] should map a full envelope to a pending PaymentResult (happy)', () => {
    const r = mapPendingEnvelope(envelope, '500');
    expect(r.success).toBe(false);
    expect(r.status).toBe('pending_approval');
    expect(r.approvalId).toBe('ap_123');
    expect(r.pollUrl).toBe('/approvals/ap_123');
    expect(r.expiresAt).toBe('2026-06-08T12:15:00.000Z');
    // REQUIRED money fields populated per the existing pattern (gross/net = amount).
    expect(r.grossAmount).toBe('500000000');
    expect(r.netAmount).toBe('500000000');
    expect(r.commissionAmount).toBe('0');
    expect(r.commissionRate).toBe(0);
  });

  it('[UNIT] should fall back to the requested amount when amount_usd is absent (error)', () => {
    const { amount_usd: _omit, ...noAmount } = envelope;
    const r = mapPendingEnvelope(noAmount, '12.50');
    expect(r.grossAmount).toBe('12500000');
    expect(r.netAmount).toBe('12500000');
    expect(r.status).toBe('pending_approval');
  });

  it('[UNIT] should tolerate a minimal envelope with missing optional fields (edge)', () => {
    const r = mapPendingEnvelope({ status: 'pending_approval' }, '1');
    expect(r.success).toBe(false);
    expect(r.status).toBe('pending_approval');
    expect(r.approvalId).toBeUndefined();
    expect(r.pollUrl).toBeUndefined();
    expect(r.error).toBeUndefined();
    // Money fields still REQUIRED → fall back to the requested amount.
    expect(r.grossAmount).toBe('1000000');
  });
});

// ── client.pay() — /verify pending mapping ──────────────────────────────────
describe('PayBotClient.pay() pending mapping (AC2, AC3, AC11)', () => {
  let client: PayBotClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PayBotClient({ apiKey: 'pb_test', botId: 'test-bot', facilitatorUrl: 'https://api.test.com' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('[UNIT] should return a pending result (never throw) when /verify is pending_approval (happy)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: 'pending_approval',
        approval_id: 'ap_777',
        poll_url: '/approvals/ap_777',
        expires_at: '2026-06-08T12:30:00.000Z',
        amount_usd: 500,
        reason: 'in approval band',
      })
    );

    const r = await client.pay({ resource: 'https://x/data', amount: '500', payTo: PAYEE });

    expect(r.success).toBe(false);
    expect(r.status).toBe('pending_approval');
    expect(r.approvalId).toBe('ap_777');
    expect(r.pollUrl).toBe('/approvals/ap_777');
    expect(r.expiresAt).toBe('2026-06-08T12:30:00.000Z');
    // It must NOT have proceeded to /settle — exactly one fetch (the /verify).
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('[UNIT] should degrade safely: a status-ignoring consumer sees success:false (edge)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: 'pending_approval', approval_id: 'ap_1', poll_url: '/approvals/ap_1' })
    );
    const r = await client.pay({ resource: 'https://x', amount: '500', payTo: PAYEE });
    // A consumer reading only `success` treats it as "not done yet" — no crash.
    expect(r.success).toBe(false);
    expect(typeof r.grossAmount).toBe('string'); // required field present
  });

  it('[UNIT] should still settle normally when /verify is NOT pending (error/regression guard)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        valid: true,
        settlementToken: 'st_abc',
        commission: { grossAmount: '51250', netAmount: '50000', commissionAmount: '1250', commissionRate: 0.025 },
      })
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, transaction: '0xTx', network: 'eip155:84532' }));

    const r = await client.pay({ resource: 'https://x', amount: '0.05', payTo: PAYEE });
    expect(r.success).toBe(true);
    expect(r.status).toBeUndefined(); // non-pending path unchanged
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── client.waitForApproval() ────────────────────────────────────────────────
describe('PayBotClient.waitForApproval() (AC4–AC8, AC11)', () => {
  let client: PayBotClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PayBotClient({ apiKey: 'pb_test', botId: 'test-bot', facilitatorUrl: 'https://api.test.com' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('[UNIT] should resolve to a settled result when core transitions to APPROVED/SETTLED (happy, AC4)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approval_id: 'ap_1',
        decision: 'APPROVED',
        state: 'SETTLED',
        tx_hash: '0xDEADBEEF',
        amount_usd: 500,
      })
    );

    const r = await client.waitForApproval('ap_1', { intervalMs: 1 });
    expect(r.success).toBe(true);
    expect(r.status).toBe('settled');
    expect(r.txHash).toBe('0xDEADBEEF');
    expect(r.grossAmount).toBe('500000000');
  });

  it('[UNIT] should poll across PENDING until terminal (edge: multi-iteration)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ approval_id: 'ap_2', decision: 'PENDING', expires_at: 'z' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ approval_id: 'ap_2', decision: 'PENDING', expires_at: 'z' }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ approval_id: 'ap_2', decision: 'APPROVED', state: 'SETTLED', tx_hash: '0xAB', amount_usd: 10 })
    );

    const r = await client.waitForApproval('ap_2', { intervalMs: 1 });
    expect(r.success).toBe(true);
    expect(r.status).toBe('settled');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('[UNIT] should resolve to a denied result when core DENIES (AC5)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ approval_id: 'ap_3', decision: 'DENIED', error: 'policy', amount_usd: 500 })
    );
    const r = await client.waitForApproval('ap_3', { intervalMs: 1 });
    expect(r.success).toBe(false);
    expect(r.status).toBe('denied');
    expect(r.errorCode).toBe('APPROVAL_DENIED');
  });

  it('[UNIT] should map EXPIRED to an expired-as-denied terminal (AC6)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ approval_id: 'ap_4', decision: 'EXPIRED', amount_usd: 500 }));
    const r = await client.waitForApproval('ap_4', { intervalMs: 1 });
    expect(r.success).toBe(false);
    expect(r.status).toBe('denied');
    expect(r.errorCode).toBe('APPROVAL_EXPIRED');
  });

  it('[UNIT] should map APPROVED+SETTLE_FAILED to a fail-closed denied result (edge)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ approval_id: 'ap_5', decision: 'APPROVED', state: 'SETTLE_FAILED', error: 'rpc down' })
    );
    const r = await client.waitForApproval('ap_5', { intervalMs: 1 });
    expect(r.success).toBe(false);
    expect(r.status).toBe('denied');
    expect(r.errorCode).toBe('APPROVAL_SETTLE_FAILED');
    expect(r.error).toContain('rpc down');
  });

  it('[UNIT] should return pending (never throw) on local timeout — core stays live (AC7)', async () => {
    // Always PENDING; timeoutMs:0 → one poll then immediate deadline.
    mockFetch.mockResolvedValue(
      jsonResponse({ approval_id: 'ap_6', decision: 'PENDING', expires_at: '2026-06-08T13:00:00.000Z' })
    );
    const r = await client.waitForApproval('ap_6', { timeoutMs: 0, intervalMs: 1 });
    expect(r.success).toBe(false);
    expect(r.status).toBe('pending_approval'); // NOT settled/denied — record still live
    expect(r.approvalId).toBe('ap_6');
    expect(r.expiresAt).toBe('2026-06-08T13:00:00.000Z');
  });

  it('[UNIT] should never throw on poll error — returns a result (AC8)', async () => {
    // Poll endpoint unreachable on every attempt (initial + retry), then deadline.
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await client.waitForApproval('ap_7', { timeoutMs: 0, intervalMs: 1 });
    expect(r.success).toBe(false);
    expect(r.status).toBe('pending_approval');
    expect(r.errorCode).toBe('APPROVAL_POLL_TIMEOUT');
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('[UNIT] should return a non-throwing failure for an empty approvalId (defensive)', async () => {
    const r = await client.waitForApproval('', { intervalMs: 1 });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('INVALID_APPROVAL_ID');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── x402 auto-handler pending pass-through ───────────────────────────────────
describe('createX402Handler pending pass-through (AC9, AC10, AC11)', () => {
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
  afterEach(() => vi.restoreAllMocks());

  it('[UNIT] should return a 202 pending response without blocking (happy, AC9)', async () => {
    // 402 with $2 (under the $5 ceiling) → server places it in the approval band.
    mockFetch.mockResolvedValueOnce(jsonResponse({ amount: '2000000', payTo: '0x1234' }, 402));
    // client.pay → /verify returns pending.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: 'pending_approval', approval_id: 'ap_x', poll_url: '/approvals/ap_x', amount_usd: 2 })
    );

    const res = await handler.fetch('https://api.example.com/paid');
    expect(res.status).toBe(202);
    expect(res.headers.get('X-Payment-Status')).toBe('pending_approval');
    expect(res.headers.get('X-Payment-Approval-Id')).toBe('ap_x');
    const body = await res.json();
    expect(body.status).toBe('pending_approval');
    expect(body.approvalId).toBe('ap_x');
    // Non-blocking: no implicit waitForApproval poll happened.
    // Calls: original 402 + /verify only.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('[UNIT] should STILL throw for an amount over the client ceiling — distinct path (AC10)', async () => {
    // 402 with $10 (over the $5 ceiling) → over-ceiling throw, never pending.
    mockFetch.mockResolvedValueOnce(jsonResponse({ amount: '10000000', payTo: '0x1234' }, 402));
    await expect(handler.fetch('https://api.example.com/expensive')).rejects.toThrow(/exceeds auto-pay limit/);
    // It threw BEFORE calling /verify — only the original 402 fetch happened.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('[UNIT] should still throw on a real payment failure (edge: pending ≠ failure)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ amount: '1000000', payTo: '0x1234' }, 402));
    // /verify hard-fails (403) → client.pay returns success:false, status undefined.
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Trust violation', code: 'TRUST_VIOLATION' }, 403));
    await expect(handler.fetch('https://api.example.com/paid')).rejects.toThrow(/Payment failed/);
  });
});
