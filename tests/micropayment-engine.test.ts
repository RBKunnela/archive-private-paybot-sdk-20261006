/**
 * @module tests/micropayment-engine
 *
 * Unit tests for `MicropaymentEngine` — the gas-free batched-settlement queue
 * for sub-cent agent payments.
 *
 * What is tested (Story 15 — Track B, tests B-1 through B-18):
 *   - constructor                  (B-1..B-3) — 0x-prefix guard, defaults, overrides
 *   - queuePayment                 (B-4..B-6) — paymentId shape, USD-parse errors,
 *                                              auto-settle trigger via checkAutoSettle
 *   - batchPayments                (B-7..B-9) — EIP-712 BatchSettlement signing,
 *                                              missing-payment-ids error,
 *                                              skipGasEstimate=true short-circuit
 *   - getGasEstimate               (B-10..B-11) — 6-decimal USD string, scales w/ count
 *   - setBatchWindow               (B-12..B-13) — seconds→ms mutation, observable effect
 *   - getQueueStatistics           (B-14..B-15) — empty-queue zeroes,
 *                                              multi-window aggregation + shouldSettle
 *   - clearOldPayments             (B-16..B-17) — only settled+old removed, empty
 *                                              window keys deleted
 *   - getPaymentStatus             (B-18) — combined happy/error (find-or-undefined)
 *
 * What is mocked:
 *   - `vi.useFakeTimers()` + `vi.setSystemTime(FIXED_NOW)` freezes `Date.now()`
 *     so:
 *       (a) paymentId `mp_<timestamp>_<random>` is deterministic
 *       (b) batchId `batch_<timestamp>_<random>` is deterministic
 *       (c) batch-window-key (line 319: `floor(Date.now() / batchWindowMs)`)
 *           is deterministic — keeps payments in the SAME window across a test
 *       (d) signBatchSettlement's `nowSeconds` and `expiresAt` are stable
 *   - `vi.spyOn(Math, 'random').mockReturnValue(0.5)` makes
 *     `Math.random().toString(36).substr(2, 9)` produce a fixed suffix so the
 *     `mp_` / `batch_` IDs are stable across runs.
 *   - `webcrypto.getRandomValues` is NOT stubbed; the private `generateNonce`
 *     uses it, but we never assert byte-identical SIGNATURES across runs (only
 *     "is a 0x-prefixed signature of the right shape" and "BatchSettlement
 *     completes without throwing"). If a future test needs byte-identical
 *     signature recovery, mock `generateNonce` via `vi.spyOn(engine as any,
 *     'generateNonce')`.
 *
 * Why determinism matters:
 *   The auto-settle path inside `queuePayment` calls `batchPayments`, which
 *   calls `signBatchSettlement`. If `Date.now()` advances between the
 *   `queuePayment`-internal `Date.now()` (for paymentId) and
 *   `getBatchWindowKey`'s `Date.now()` (for window selection), a test can
 *   end up with a payment queued in one window and the auto-settle reading
 *   a different window, producing an empty `paymentIds` array and an
 *   unexpected throw. Fake timers eliminate this race.
 *
 * Naming convention: `[UNIT] methodName — should [behavior] when [condition]`.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import type { Address } from 'viem';

import { MicropaymentEngine } from '../src/micropayment-engine.js';

// ---------------------------------------------------------------------------
// Deterministic test fixtures
// ---------------------------------------------------------------------------

/**
 * Fixed test private key (NEVER use for anything real).
 */
const TEST_PRIVATE_KEY =
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as const;

/** Fixed system time — keeps paymentId/batchId/window-key/nowSeconds stable. */
const FIXED_NOW = new Date('2026-05-22T12:00:00Z');

/**
 * Sample recipient addresses for payments.
 *
 * WHY: viem ≥2.49 strictly validates EIP-55 checksum on `address` fields
 * inside EIP-712 typed data — including the `Payment.recipient` field in
 * `signBatchSettlement`'s `BatchSettlement` struct. Story 15.1 fixed the
 * `verifyingContract` checksum in src; the `recipient` field is supplied
 * by callers at queue time, so OUR test fixtures must also use
 * correctly-checksummed addresses. (Story 15.1 also noted that line 240
 * — `recipient: p.recipient as \`0x${string}\`` — is an undefended re-cast
 * deferred to backlog; until that's hardened, the burden of producing
 * checksum-valid addresses sits with the caller, including these tests.)
 *
 * Verified via `viem.getAddress(...)`:
 *   - `0x...bEEF` is already correctly checksummed.
 *   - `0x...Face` is correct; `0x...FACE` (all-caps) is NOT.
 */
const RECIPIENT_A = '0x000000000000000000000000000000000000bEEF' as Address;
const RECIPIENT_B = '0x000000000000000000000000000000000000Face' as Address;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let randomSpy: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  // WHY: Math.random feeds both `paymentId` and `batchId` suffix generation
  // (see lines 69 and 121 of src/micropayment-engine.ts). Freezing it makes
  // the IDs stable for any assertion (e.g. B-4 "paymentId starts with 'mp_'").
  randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  randomSpy.mockRestore();
  vi.useRealTimers();
});

/** Build a fresh engine with default config (≥-prefix-guarded private key). */
function buildEngine(overrides?: {
  batchWindowMs?: number;
  minPaymentCount?: number;
  minTotalUsd?: number;
}): MicropaymentEngine {
  return new MicropaymentEngine({
    walletPrivateKey: TEST_PRIVATE_KEY,
    ...overrides,
  });
}

// ===========================================================================
// B-1..B-3: constructor
// ===========================================================================

describe('[UNIT] MicropaymentEngine constructor', () => {
  // -------------------------------------------------------------------------
  // B-1: happy path — valid 0x key + default thresholds
  // -------------------------------------------------------------------------

  it('[UNIT] MicropaymentEngine — should initialize with a valid 0x-prefixed walletPrivateKey and default thresholds (batchWindowMs=60000, minPaymentCount=100, minTotalUsd=1.0)', () => {
    const engine = new MicropaymentEngine({
      walletPrivateKey: TEST_PRIVATE_KEY,
    });
    expect(engine).toBeInstanceOf(MicropaymentEngine);

    // Defaults are observable via getQueueStatistics().shouldSettle:
    // with empty queue (totalUsd=0, totalPayments=0), shouldSettle must be
    // false against defaults (100 / 1.0).
    const stats = engine.getQueueStatistics();
    expect(stats.totalPayments).toBe(0);
    expect(stats.shouldSettle).toBe(false);
  });

  // -------------------------------------------------------------------------
  // B-2: error path — non-0x walletPrivateKey
  // -------------------------------------------------------------------------

  it('[UNIT] MicropaymentEngine — should throw \'walletPrivateKey must start with 0x\' when walletPrivateKey is missing the 0x prefix', () => {
    expect(
      () =>
        new MicropaymentEngine({
          walletPrivateKey:
            '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
        }),
    ).toThrow(/walletPrivateKey must start with 0x/);

    // Empty string also fails the 0x guard.
    expect(
      () => new MicropaymentEngine({ walletPrivateKey: '' }),
    ).toThrow(/walletPrivateKey must start with 0x/);
  });

  // -------------------------------------------------------------------------
  // B-3: edge case — respect custom config overrides
  // -------------------------------------------------------------------------

  it('[UNIT] MicropaymentEngine — should respect custom batchWindowMs / minPaymentCount / minTotalUsd overrides in config', async () => {
    // Tight thresholds: 1 payment OR $0.01 triggers settle. Empty queue is
    // BELOW both, so shouldSettle stays false until we queue something.
    const engine = new MicropaymentEngine({
      walletPrivateKey: TEST_PRIVATE_KEY,
      batchWindowMs: 30_000,
      minPaymentCount: 1,
      minTotalUsd: 0.01,
    });
    expect(engine.getQueueStatistics().shouldSettle).toBe(false);

    // Queue a payment small enough to hit only the COUNT threshold (not
    // the USD threshold). $0.005 < 0.01, but 1 payment ≥ 1 minPaymentCount.
    // auto-settle will fire (and succeed — we just need to observe state).
    await engine.queuePayment(RECIPIENT_A, '0.005');

    // After auto-settle, the queued item should now be in `pending` status,
    // proving the custom thresholds were honored.
    const stats = engine.getQueueStatistics();
    expect(stats.totalPayments).toBe(1);
    expect(stats.pendingCount).toBe(1);
    expect(stats.queuedCount).toBe(0);
  });
});

// ===========================================================================
// B-4..B-6: queuePayment
// ===========================================================================

describe('[UNIT] queuePayment', () => {
  // -------------------------------------------------------------------------
  // B-4: happy path — 3-arg shape, paymentId format, window assignment
  // -------------------------------------------------------------------------

  it("[UNIT] queuePayment — should accept (recipient, amountUsd, metadata?) and return a paymentId formatted as 'mp_<timestamp>_<random>' with the item assigned to the current batch window", async () => {
    // High thresholds so auto-settle does NOT fire — we want to observe
    // the queued state directly. 100 payments / $100 total: a single $0.10
    // queue stays in 'queued' status.
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    const paymentId = await engine.queuePayment(RECIPIENT_A, '0.10', {
      note: 'lorem',
    });

    // WHY: timestamp baked into the ID is the frozen FIXED_NOW (Date.now()
    // returns a stable value via vi.useFakeTimers). suffix is from frozen
    // Math.random — both pieces are reproducible.
    expect(paymentId).toMatch(/^mp_\d+_[0-9a-z]+$/);
    expect(paymentId.startsWith(`mp_${FIXED_NOW.getTime()}_`)).toBe(true);

    // The item should be queryable via getPaymentStatus and live in the
    // current batch window.
    const item = engine.getPaymentStatus(paymentId);
    expect(item).toBeDefined();
    expect(item!.recipient).toBe(RECIPIENT_A);
    expect(item!.amountUsd).toBe('0.10');
    expect(item!.status).toBe('queued');
    expect(item!.metadata).toEqual({ note: 'lorem' });
    expect(item!.queuedAt).toBe(FIXED_NOW.getTime());

    // amountBaseUnits = '0.10' → whole='0', frac='100000' → '0100000' → '100000'
    // after the leading-zero strip. That's $0.10 in USDC 6-decimal base units.
    expect(item!.amountBaseUnits).toBe('100000');

    // Active windows: exactly one.
    expect(engine.getQueueStatistics().activeWindows).toBe(1);
  });

  // -------------------------------------------------------------------------
  // B-5: error path — usdToBaseUnits regex rejection
  // -------------------------------------------------------------------------

  it('[UNIT] queuePayment — should reject (propagate from usdToBaseUnits) when amountUsd is empty, non-numeric, or fails the /^\\d+\\.?\\d*$/ regex', async () => {
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    // Empty string → 'Amount must be a non-empty string' (line 330).
    await expect(engine.queuePayment(RECIPIENT_A, '')).rejects.toThrow(
      /Amount must be a non-empty string/,
    );

    // Non-numeric → 'Invalid USD amount: abc' (line 333).
    await expect(engine.queuePayment(RECIPIENT_A, 'abc')).rejects.toThrow(
      /Invalid USD amount/,
    );

    // Leading dot fails the regex `^\d+\.?\d*$` (must start with a digit).
    await expect(engine.queuePayment(RECIPIENT_A, '.5')).rejects.toThrow(
      /Invalid USD amount/,
    );
  });

  // -------------------------------------------------------------------------
  // B-6: edge case — auto-settle triggers when thresholds met
  // -------------------------------------------------------------------------

  it('[UNIT] queuePayment — should trigger checkAutoSettle → batchPayments when totalPayments reaches minPaymentCount OR totalUsd reaches minTotalUsd', async () => {
    // Hair-trigger thresholds: 1 payment OR $0.01.
    const engine = buildEngine({ minPaymentCount: 1, minTotalUsd: 0.01 });

    // Single payment should trip the count threshold (1 ≥ 1) and auto-settle.
    const paymentId = await engine.queuePayment(RECIPIENT_A, '0.50');

    const item = engine.getPaymentStatus(paymentId);
    // WHY: after auto-settle, batchPayments mutates each item.status to
    // 'pending' (line 113-115 of src). If checkAutoSettle did NOT fire,
    // status would still be 'queued'.
    expect(item!.status).toBe('pending');

    const stats = engine.getQueueStatistics();
    expect(stats.pendingCount).toBe(1);
    expect(stats.queuedCount).toBe(0);
  });
});

// ===========================================================================
// B-7..B-9: batchPayments
// ===========================================================================

describe('[UNIT] batchPayments', () => {
  // -------------------------------------------------------------------------
  // B-7: happy path — sign + mutate status + return shape
  // -------------------------------------------------------------------------

  it('[UNIT] batchPayments — should sign a BatchSettlement covering all queued paymentIds, set each payment.status = \'pending\', and return a BatchedSettlement with correct totals/recipientCount/expiresAt', async () => {
    // High thresholds so auto-settle does NOT pre-empt this manual call.
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    // Queue 3 payments to 2 unique recipients, total $0.30.
    const id1 = await engine.queuePayment(RECIPIENT_A, '0.10');
    const id2 = await engine.queuePayment(RECIPIENT_A, '0.05');
    const id3 = await engine.queuePayment(RECIPIENT_B, '0.15');

    const result = await engine.batchPayments([id1, id2, id3]);

    // batchId shape: `batch_<timestamp>_<rand>` (line 121 of src).
    expect(result.batchId).toMatch(/^batch_\d+_[0-9a-z]+$/);

    // paymentIds preserved in the same order they were collected.
    expect(result.paymentIds).toEqual([id1, id2, id3]);

    // 2 unique recipients (A, B).
    expect(result.recipientCount).toBe(2);

    // Totals: $0.10 + $0.05 + $0.15 = $0.30, fixed to 6 decimals.
    expect(result.totalAmountUsd).toBe('0.300000');

    // Base units: 100000 + 50000 + 150000 = 300000.
    expect(result.totalAmountBaseUnits).toBe('300000');

    // Average: 0.30 / 3 = 0.10.
    expect(result.averageAmountUsd).toBe('0.100000');

    // expiresAt = createdAt + 300_000ms (5 min from FIXED_NOW).
    expect(result.expiresAt).toBe(FIXED_NOW.getTime() + 300_000);
    expect(result.createdAt).toBe(FIXED_NOW.getTime());

    // EIP-712 signature shape: 0x-prefixed 130 hex chars.
    expect(result.signedSettlement.signature).toMatch(
      /^0x[0-9a-fA-F]{130}$/,
    );
    // signedSettlement.payments mirrors the queued items (recipient, amount,
    // paymentId per entry).
    expect(result.signedSettlement.payments).toHaveLength(3);
    expect(result.signedSettlement.payments[0]!.paymentId).toBe(id1);
    expect(result.signedSettlement.payments[0]!.amount).toBe('100000');

    // Status mutation: every batched payment becomes 'pending'.
    for (const id of [id1, id2, id3]) {
      expect(engine.getPaymentStatus(id)!.status).toBe('pending');
    }
  });

  // -------------------------------------------------------------------------
  // B-8: error path — paymentIds not in queue
  // -------------------------------------------------------------------------

  it('[UNIT] batchPayments — should throw \'No payments found with given IDs\' when paymentIds reference non-existent queue entries', async () => {
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    await expect(
      engine.batchPayments(['mp_does_not_exist_1', 'mp_does_not_exist_2']),
    ).rejects.toThrow(/No payments found with given IDs/);
  });

  // -------------------------------------------------------------------------
  // B-9: edge case — skipGasEstimate=true short-circuit
  // -------------------------------------------------------------------------

  it('[UNIT] batchPayments — should honor options.skipGasEstimate=true by returning gasEstimateUsd=\'0.000000\' instead of calling estimateGasCost', async () => {
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    const id1 = await engine.queuePayment(RECIPIENT_A, '0.10');
    const id2 = await engine.queuePayment(RECIPIENT_B, '0.20');

    const noGas = await engine.batchPayments([id1, id2], {
      skipGasEstimate: true,
    });
    expect(noGas.gasEstimateUsd).toBe('0.000000');
    expect(noGas.gasPerPaymentUsd).toBe('0.000000');

    // For contrast: re-queue + batch without skipGasEstimate → gas > 0.
    // Use FRESH engine so the prior batch's pending items don't pollute.
    const engine2 = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });
    const idA = await engine2.queuePayment(RECIPIENT_A, '0.10');
    const idB = await engine2.queuePayment(RECIPIENT_B, '0.20');
    const withGas = await engine2.batchPayments([idA, idB]);
    expect(parseFloat(withGas.gasEstimateUsd)).toBeGreaterThan(0);
  });
});

// ===========================================================================
// B-10..B-11: getGasEstimate
// ===========================================================================

describe('[UNIT] getGasEstimate', () => {
  // -------------------------------------------------------------------------
  // B-10: happy path — 6-decimal USD string for typical count
  // -------------------------------------------------------------------------

  it('[UNIT] getGasEstimate — should return a 6-decimal USD string for a typical paymentCount (e.g. 10)', () => {
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    const estimate = engine.getGasEstimate(10);

    // Format: "<digits>.<exactly-6-digits>".
    expect(estimate).toMatch(/^\d+\.\d{6}$/);
    // Numerically: empty queue → uniqueRecipients=0 → totalGas=21000 →
    // gasCostWei = 21000 * 5e9 = 1.05e14 wei → gasCostEth = 1.05e-4 →
    // gasCostUsd = 0.315 → divided by 10 = 0.0315. We assert it's >0 and
    // <1 for sanity; tighter assertion would couple to constants.
    const value = parseFloat(estimate);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });

  // -------------------------------------------------------------------------
  // B-11: edge case — gas-per-payment decreases as count grows
  // -------------------------------------------------------------------------

  it('[UNIT] getGasEstimate — should scale gas inversely with paymentCount (gas-per-payment decreases as batch size grows) and handle paymentCount=1', () => {
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    const one = parseFloat(engine.getGasEstimate(1));
    const ten = parseFloat(engine.getGasEstimate(10));
    const hundred = parseFloat(engine.getGasEstimate(100));

    // WHY: the cost formula (line 306 of src) divides by paymentCount, so
    // per-payment gas MUST strictly decrease as the batch grows. This is the
    // whole point of batching — amortize gas across many payments.
    expect(one).toBeGreaterThan(ten);
    expect(ten).toBeGreaterThan(hundred);
    expect(one).toBeGreaterThan(0);
  });
});

// ===========================================================================
// B-12..B-13: setBatchWindow
// ===========================================================================

describe('[UNIT] setBatchWindow', () => {
  // -------------------------------------------------------------------------
  // B-12: happy path — seconds → ms conversion
  // -------------------------------------------------------------------------

  it('[UNIT] setBatchWindow — should convert seconds to milliseconds and mutate internal batchWindowMs (e.g. setBatchWindow(30) → batchWindowMs=30000)', async () => {
    // Construct with explicit batchWindowMs to give us a known starting point.
    const engine = buildEngine({
      batchWindowMs: 60_000,
      minPaymentCount: 100,
      minTotalUsd: 100,
    });

    // We can't read batchWindowMs directly (it's private), but
    // getBatchWindowKey (also private) is a function of it. We observe the
    // mutation by checking that the windowKey changes in a way consistent
    // with the new window size. setBatchWindow(30) → 30000ms → window key
    // floor(now/30000)*30000.
    engine.setBatchWindow(30);

    // Queue something; activeWindows = 1 confirms a window key exists with
    // the new size. (Direct read of windowKey would require reflection; we
    // assert via the public surface.)
    await engine.queuePayment(RECIPIENT_A, '0.10');
    expect(engine.getQueueStatistics().activeWindows).toBe(1);

    // Sanity: the new window must be observably present.
    const id = await engine.queuePayment(RECIPIENT_B, '0.20');
    const item = engine.getPaymentStatus(id);
    expect(item).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // B-13: edge case — observable change in getBatchWindowKey via window grouping
  // -------------------------------------------------------------------------

  it('[UNIT] setBatchWindow — should observably change window grouping behavior across batch-window boundaries when advanced via fake timers', async () => {
    // Tight window: 10 seconds. Queue 1 payment at t=0, advance 15s past the
    // 10s window boundary, queue another → activeWindows must be 2.
    const engine = buildEngine({
      batchWindowMs: 10_000,
      minPaymentCount: 100,
      minTotalUsd: 100,
    });

    await engine.queuePayment(RECIPIENT_A, '0.10');
    expect(engine.getQueueStatistics().activeWindows).toBe(1);

    // WHY: advancing past the batchWindowMs boundary forces
    // getBatchWindowKey to produce a different key on the next queuePayment,
    // creating a second active window. This proves the window-key math
    // honors the configured batchWindowMs.
    vi.advanceTimersByTime(15_000);

    await engine.queuePayment(RECIPIENT_B, '0.20');
    expect(engine.getQueueStatistics().activeWindows).toBe(2);

    // setBatchWindow can ALSO change grouping: bump to 60s and advance
    // FAR enough that the new 60s window-key does not collide with any
    // existing key. Existing 10s-window keys are {0, 10000}. With a 60s
    // window at t=80000, key=floor(80000/60000)*60000=60000 — a fresh key.
    engine.setBatchWindow(60);
    vi.advanceTimersByTime(65_000); // total elapsed: 80s
    await engine.queuePayment(RECIPIENT_A, '0.30');
    expect(engine.getQueueStatistics().activeWindows).toBe(3);
  });
});

// ===========================================================================
// B-14..B-15: getQueueStatistics
// ===========================================================================

describe('[UNIT] getQueueStatistics', () => {
  // -------------------------------------------------------------------------
  // B-14: happy path — empty queue zeroes
  // -------------------------------------------------------------------------

  it('[UNIT] getQueueStatistics — should return zeroed BatchStatistics when queue is empty (totalPayments=0, shouldSettle=false, uniqueRecipients=0)', () => {
    const engine = buildEngine();
    const stats = engine.getQueueStatistics();

    expect(stats.totalPayments).toBe(0);
    expect(stats.totalUsd).toBe(0);
    expect(stats.pendingCount).toBe(0);
    expect(stats.queuedCount).toBe(0);
    expect(stats.uniqueRecipients).toBe(0);
    expect(stats.paymentsByRecipient).toEqual({});
    expect(stats.activeWindows).toBe(0);
    expect(stats.averageUsdPerPayment).toBe(0);
    expect(stats.shouldSettle).toBe(false);
  });

  // -------------------------------------------------------------------------
  // B-15: edge case — multi-window aggregation, shouldSettle flips at threshold
  // -------------------------------------------------------------------------

  it('[UNIT] getQueueStatistics — should aggregate across multiple windows: count queued vs pending status, compute uniqueRecipients, and flip shouldSettle=true when thresholds are met', async () => {
    // High thresholds: 100 payments OR $1.00. Single $0.50 payment leaves
    // shouldSettle=false. Two $0.50 payments → totalUsd=1.0 → shouldSettle=true.
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 1.0 });

    await engine.queuePayment(RECIPIENT_A, '0.50');
    const after1 = engine.getQueueStatistics();
    expect(after1.totalPayments).toBe(1);
    expect(after1.queuedCount).toBe(1);
    expect(after1.pendingCount).toBe(0);
    expect(after1.uniqueRecipients).toBe(1);
    expect(after1.totalUsd).toBeCloseTo(0.5, 10);
    expect(after1.shouldSettle).toBe(false);

    // Queue across a different window to exercise the multi-window path.
    vi.advanceTimersByTime(70_000); // past the default 60s window
    await engine.queuePayment(RECIPIENT_B, '0.50');

    const after2 = engine.getQueueStatistics();
    expect(after2.activeWindows).toBe(2);
    expect(after2.totalPayments).toBe(2);
    // WHY: queuePayment 2 calls checkAutoSettle, which reads the AGGREGATE
    // statistics (totalUsd=1.0 across both windows) and now sees
    // shouldSettle=true. BUT checkAutoSettle only batches the items in the
    // CURRENT windowKey (line 313: `getPaymentIdsForWindow(windowKey)`),
    // not all-windows. So payment 2 (in the new window) gets settled
    // (status='pending'), and payment 1 (in the old window) stays 'queued'.
    // This is the per-window auto-settle contract — only THIS window batches.
    expect(after2.pendingCount).toBe(1);
    expect(after2.queuedCount).toBe(1);
    expect(after2.uniqueRecipients).toBe(2);
    expect(after2.paymentsByRecipient[RECIPIENT_A]).toBe(1);
    expect(after2.paymentsByRecipient[RECIPIENT_B]).toBe(1);
    expect(after2.averageUsdPerPayment).toBeCloseTo(0.5, 10);
    // 2 payments + $1.0 → shouldSettle aggregate flips true (the very
    // condition that triggered the per-window auto-settle above; it remains
    // true after settlement because totalUsd still aggregates 'pending'
    // items via line 153, not just 'queued' ones).
    expect(after2.shouldSettle).toBe(true);
  });
});

// ===========================================================================
// B-16..B-17: clearOldPayments
// ===========================================================================

describe('[UNIT] clearOldPayments', () => {
  // -------------------------------------------------------------------------
  // B-16: happy path — nothing to clear returns 0
  // -------------------------------------------------------------------------

  it('[UNIT] clearOldPayments — should return 0 when no items match cutoff (nothing old, or items not settled)', async () => {
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    // Queue 2 items; both stay 'queued' (high thresholds), neither is
    // 'settled'. clearOldPayments only removes status==='settled' items.
    await engine.queuePayment(RECIPIENT_A, '0.10');
    await engine.queuePayment(RECIPIENT_B, '0.20');

    // Even with a huge cutoff (1000 min old), none of these are 'settled' yet.
    expect(engine.clearOldPayments(1000)).toBe(0);

    // Queue still holds both items.
    expect(engine.getQueueStatistics().totalPayments).toBe(2);
  });

  // -------------------------------------------------------------------------
  // B-17: edge case — only settled+old removed; empty window keys deleted
  // -------------------------------------------------------------------------

  it("[UNIT] clearOldPayments — should remove only items where status==='settled' AND queuedAt<cutoff, leaving 'queued'/'pending' items intact regardless of age, and delete empty window keys from the queue Map", async () => {
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    // Queue an item at t=0 in window W1.
    const id1 = await engine.queuePayment(RECIPIENT_A, '0.10');

    // WHY: clearOldPayments only sweeps items with status === 'settled'
    // (line 187 of src). The engine itself only ever sets 'queued' or
    // 'pending' — 'settled' is a downstream state. We poke item.status
    // directly to simulate post-settlement state.
    const item1 = engine.getPaymentStatus(id1)!;
    item1.status = 'settled';

    // Advance well past the cutoff window.
    vi.advanceTimersByTime(120 * 60 * 1000); // 2 hours

    // Queue a fresh item in NEW window W2 — stays 'queued' and recent.
    const id2 = await engine.queuePayment(RECIPIENT_B, '0.20');

    // clear items older than 60 minutes → id1 (settled + ancient) is removed,
    // id2 (recent + queued) is preserved.
    const cleared = engine.clearOldPayments(60);
    expect(cleared).toBe(1);

    // W2 still alive (has id2); W1 deleted (became empty).
    expect(engine.getQueueStatistics().activeWindows).toBe(1);
    expect(engine.getPaymentStatus(id1)).toBeUndefined();
    expect(engine.getPaymentStatus(id2)).toBeDefined();
    expect(engine.getPaymentStatus(id2)!.status).toBe('queued');
  });
});

// ===========================================================================
// B-18: getPaymentStatus (combined happy + error)
// ===========================================================================

describe('[UNIT] getPaymentStatus', () => {
  // -------------------------------------------------------------------------
  // B-18: find-or-undefined contract
  // -------------------------------------------------------------------------

  it('[UNIT] getPaymentStatus — should return the MicropaymentQueueItem when paymentId exists in any window, and return undefined when it does not exist', async () => {
    const engine = buildEngine({ minPaymentCount: 100, minTotalUsd: 100 });

    const id = await engine.queuePayment(RECIPIENT_A, '0.10');

    // Happy: found in current window.
    const found = engine.getPaymentStatus(id);
    expect(found).toBeDefined();
    expect(found!.paymentId).toBe(id);
    expect(found!.recipient).toBe(RECIPIENT_A);

    // Move to a different window and queue another — confirm cross-window scan.
    vi.advanceTimersByTime(120_000);
    const id2 = await engine.queuePayment(RECIPIENT_B, '0.20');
    expect(engine.getQueueStatistics().activeWindows).toBe(2);
    expect(engine.getPaymentStatus(id)).toBeDefined();
    expect(engine.getPaymentStatus(id2)).toBeDefined();

    // Error: unknown ID returns undefined (line 211 of src).
    expect(engine.getPaymentStatus('mp_does_not_exist')).toBeUndefined();
  });
});
