/**
 * @module tests/x402-v2
 *
 * Unit tests for `X402Handler.signPayment` and its new private dispatch helpers
 * `signX402` and `signMPP` (Story 14 — Option C refactor).
 *
 * These tests:
 *   1. Lock the existing x402 + MPP signing behavior byte-for-byte (regression shield).
 *   2. Prove the dual-mode case produces a REAL MPP cryptographic signature, not
 *      inert metadata (the bug Story 14 fixes — see lines 251+ of pre-refactor
 *      `src/x402-v2.ts`, where the `else if (protocol === 'dual')` branch was
 *      unreachable dead code).
 *   3. Verify the dispatcher's `default` arm throws `PayBotApiError` with
 *      `UNSUPPORTED_PROTOCOL` for any unknown protocol value.
 *   4. Verify the wallet-key precondition still throws `MISSING_WALLET_KEY`.
 *
 * Determinism:
 *   - vitest's `useFakeTimers` + `setSystemTime` freezes `Date.now()`.
 *   - `generateEIP3009Nonce` is mocked to return a fixed bytes32 so signatures
 *     are byte-identical across runs (Story 14, Test Strategy).
 *
 * Test naming convention: `[UNIT] methodName — should [behavior] when [condition]`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recoverTypedDataAddress, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { X402Handler } from '../src/x402-v2.js';
import { PayBotApiError } from '../src/errors.js';
import type {
  PaymentPayload,
  PaymentIntent,
  PaymentRequirements,
} from '../src/types.js';
import { EIP712_DOMAINS, EIP3009_TYPES } from '../src/networks.js';

// ---------------------------------------------------------------------------
// Deterministic test fixtures
// ---------------------------------------------------------------------------

/**
 * Fixed test private key (NEVER use for anything real).
 * Account address derived from this key: see TEST_ACCOUNT_ADDRESS below.
 */
const TEST_PRIVATE_KEY =
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as const;

const TEST_ACCOUNT_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY).address;

/** Fixed system time for deterministic `nowSeconds + 3600` calculations. */
const FIXED_NOW = new Date('2026-05-22T12:00:00Z');

/** Fixed bytes32 nonce — replaces `randomBytes(32)` for byte-identical sigs. */
const FIXED_NONCE =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`;

// Mock the crypto module so `generateEIP3009Nonce()` is deterministic.
vi.mock('../src/crypto.js', () => ({
  generateEIP3009Nonce: vi.fn(() => FIXED_NONCE),
}));

/** Build a `PaymentRequirements` with sensible defaults; override per test. */
function buildRequirements(
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '1000000', // 1 USDC (6 decimals)
    payTo: '0x000000000000000000000000000000000000bEEF',
    maxTimeoutSeconds: 300,
    ...overrides,
  };
}

/** Build a `PaymentPayload` with a given protocol + requirements. */
function buildPayload(
  protocol: PaymentIntent['protocol'],
  requirements: PaymentRequirements = buildRequirements(),
  intentId: string | undefined = 'intent_test_123',
): PaymentPayload {
  const paymentIntent: PaymentIntent = {
    intentId: intentId as string, // PaymentIntent typing requires a string; tests pass 'unknown' branch via overrides below
    protocol,
    requirements,
    version: '2.0',
    createdAt: FIXED_NOW.toISOString(),
    expiresAt: new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
  };
  return {
    paymentIntent,
    requirements,
  };
}

/** Construct the MPP EIP-712 domain that `signMPP` uses internally. */
function buildMppDomain(payTo: string) {
  return {
    name: 'Machine Payments Protocol',
    version: '1.0',
    chainId: 1,
    verifyingContract: payTo as `0x${string}`,
  };
}

/** Construct the MPP types object that `signMPP` uses internally. */
const MPP_TYPES = {
  PaymentAuthorization: [
    { name: 'payer', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expires', type: 'uint256' },
    { name: 'paymentIntent', type: 'string' },
  ],
} as const;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  // Note: do NOT call vi.restoreAllMocks() here — that would restore the
  // generateEIP3009Nonce module mock, which we WANT to keep in place for
  // every test in this file.
});

// ===========================================================================
// Test 1: signX402 — happy path
// ===========================================================================

describe('[UNIT] signX402 (via signPayment protocol=x402)', () => {
  it('[UNIT] signX402 — should produce a verifiable EIP-3009 TransferWithAuthorization signature with typical inputs', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const payload = buildPayload('x402');

    const signed = await handler.signPayment(payload);

    expect(signed.protocol).toBe('x402');
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);

    const sd = signed.signedData as Record<string, unknown>;
    const nowSec = BigInt(Math.floor(FIXED_NOW.getTime() / 1000));

    // Recover signer from the EIP-712 signature → must match test account.
    const recovered = await recoverTypedDataAddress({
      domain: EIP712_DOMAINS['eip155:8453'],
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: TEST_ACCOUNT_ADDRESS,
        to: payload.requirements.payTo as `0x${string}`,
        value: BigInt(payload.requirements.amount),
        validAfter: 0n,
        validBefore: nowSec + 3600n,
        nonce: FIXED_NONCE,
      },
      signature: signed.signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ACCOUNT_ADDRESS.toLowerCase());

    // signedData shape (verbatim from current branch — see Test 13).
    expect(sd.from).toBe(TEST_ACCOUNT_ADDRESS);
    expect(sd.to).toBe(payload.requirements.payTo);
    expect(sd.value).toBe(payload.requirements.amount);
    expect(sd.validAfter).toBe('0');
    expect(sd.validBefore).toBe((nowSec + 3600n).toString());
    expect(sd.nonce).toBe(FIXED_NONCE);
    expect(sd.signature).toBe(signed.signature);
  });

  // -------------------------------------------------------------------------
  // Test 2: signX402 — error path
  // -------------------------------------------------------------------------

  it('[UNIT] signX402 — should throw UNSUPPORTED_NETWORK PayBotApiError when network has no EIP-712 domain', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const payload = buildPayload(
      'x402',
      buildRequirements({ network: 'eip155:999999' }),
    );

    await expect(handler.signPayment(payload)).rejects.toMatchObject({
      name: 'PayBotApiError',
      code: 'UNSUPPORTED_NETWORK',
      statusCode: 402,
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: signX402 — edge case
  // -------------------------------------------------------------------------

  it('[UNIT] signX402 — should handle max-uint256 amount without overflow and produce a valid signature', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const MAX_UINT256 =
      '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    const payload = buildPayload(
      'x402',
      buildRequirements({ amount: MAX_UINT256 }),
    );

    const signed = await handler.signPayment(payload);

    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect((signed.signedData as Record<string, unknown>).value).toBe(
      MAX_UINT256,
    );

    // Round-trip the signature through verifyTypedData with the same uint256.
    const ok = await verifyTypedData({
      address: TEST_ACCOUNT_ADDRESS,
      domain: EIP712_DOMAINS['eip155:8453'],
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: TEST_ACCOUNT_ADDRESS,
        to: payload.requirements.payTo as `0x${string}`,
        value: BigInt(MAX_UINT256),
        validAfter: 0n,
        validBefore: BigInt(Math.floor(FIXED_NOW.getTime() / 1000)) + 3600n,
        nonce: FIXED_NONCE,
      },
      signature: signed.signature as `0x${string}`,
    });
    expect(ok).toBe(true);
  });
});

// ===========================================================================
// Test 4: signMPP — happy path
// ===========================================================================

describe('[UNIT] signMPP (via signPayment protocol=mpp)', () => {
  it('[UNIT] signMPP — should produce a valid PaymentAuthorization signature with typical inputs and intentId', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const payload = buildPayload('mpp');

    const signed = await handler.signPayment(payload);

    expect(signed.protocol).toBe('mpp');
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);

    const nowSec = BigInt(Math.floor(FIXED_NOW.getTime() / 1000));

    // Recover signer from the MPP-typed signature → must match test account.
    const recovered = await recoverTypedDataAddress({
      domain: buildMppDomain(payload.requirements.payTo),
      types: MPP_TYPES,
      primaryType: 'PaymentAuthorization',
      message: {
        payer: TEST_ACCOUNT_ADDRESS,
        recipient: payload.requirements.payTo as `0x${string}`,
        amount: BigInt(payload.requirements.amount),
        nonce: FIXED_NONCE,
        expires: nowSec + 3600n,
        paymentIntent: payload.paymentIntent.intentId,
      },
      signature: signed.signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ACCOUNT_ADDRESS.toLowerCase());

    const sd = signed.signedData as Record<string, unknown>;
    expect(sd.payer).toBe(TEST_ACCOUNT_ADDRESS);
    expect(sd.recipient).toBe(payload.requirements.payTo);
    expect(sd.amount).toBe(payload.requirements.amount);
    expect(sd.nonce).toBe(FIXED_NONCE);
    expect(sd.paymentIntent).toBe(payload.paymentIntent.intentId);
    expect(sd.signature).toBe(signed.signature);
  });

  // -------------------------------------------------------------------------
  // Test 5: signMPP — graceful fallback when intentId is missing
  // -------------------------------------------------------------------------

  it("[UNIT] signMPP — should handle missing intentId by defaulting paymentIntent field to 'unknown'", async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    // Override intentId to an empty string so the `|| 'unknown'` fallback fires.
    const payload = buildPayload('mpp', buildRequirements(), '');

    const signed = await handler.signPayment(payload);

    // Recovery against `paymentIntent: 'unknown'` must succeed; recovery
    // against any other string must fail. This proves the fallback fired.
    const nowSec = BigInt(Math.floor(FIXED_NOW.getTime() / 1000));
    const ok = await verifyTypedData({
      address: TEST_ACCOUNT_ADDRESS,
      domain: buildMppDomain(payload.requirements.payTo),
      types: MPP_TYPES,
      primaryType: 'PaymentAuthorization',
      message: {
        payer: TEST_ACCOUNT_ADDRESS,
        recipient: payload.requirements.payTo as `0x${string}`,
        amount: BigInt(payload.requirements.amount),
        nonce: FIXED_NONCE,
        expires: nowSec + 3600n,
        paymentIntent: 'unknown',
      },
      signature: signed.signature as `0x${string}`,
    });
    expect(ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 6: signMPP — different typed-data ≠ signX402 output
  // -------------------------------------------------------------------------

  it('[UNIT] signMPP — should produce a different signature than signX402 for identical inputs (proves it uses different typed-data)', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const requirements = buildRequirements();

    const x402Signed = await handler.signPayment(buildPayload('x402', requirements));
    const mppSigned = await handler.signPayment(buildPayload('mpp', requirements));

    expect(x402Signed.signature).not.toBe(mppSigned.signature);
    expect(x402Signed.protocol).toBe('x402');
    expect(mppSigned.protocol).toBe('mpp');
  });
});

// ===========================================================================
// Tests 7-13: signPayment dispatcher, errors, and dual-mode regression
// ===========================================================================

describe('[UNIT] signPayment dispatcher', () => {
  // -------------------------------------------------------------------------
  // Test 7: dispatcher → signX402
  // -------------------------------------------------------------------------

  it("[UNIT] signPayment — should dispatch to signX402 only when protocol is 'x402' and return identical shape to legacy behavior", async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const payload = buildPayload('x402');

    const signed = await handler.signPayment(payload);

    expect(signed.protocol).toBe('x402');
    const sd = signed.signedData as Record<string, unknown>;
    // x402-shaped keys present.
    expect(sd).toHaveProperty('from');
    expect(sd).toHaveProperty('to');
    expect(sd).toHaveProperty('value');
    expect(sd).toHaveProperty('validAfter');
    expect(sd).toHaveProperty('validBefore');
    expect(sd).toHaveProperty('nonce');
    // MPP-shaped keys absent.
    expect(sd).not.toHaveProperty('payer');
    expect(sd).not.toHaveProperty('recipient');
    expect(sd).not.toHaveProperty('expires');
    // Dual-shaped keys absent.
    expect(sd).not.toHaveProperty('x402');
    expect(sd).not.toHaveProperty('mpp');
  });

  // -------------------------------------------------------------------------
  // Test 8: dispatcher → signMPP
  // -------------------------------------------------------------------------

  it("[UNIT] signPayment — should dispatch to signMPP only when protocol is 'mpp' and return identical shape to legacy behavior", async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const payload = buildPayload('mpp');

    const signed = await handler.signPayment(payload);

    expect(signed.protocol).toBe('mpp');
    const sd = signed.signedData as Record<string, unknown>;
    // MPP-shaped keys present.
    expect(sd).toHaveProperty('payer');
    expect(sd).toHaveProperty('recipient');
    expect(sd).toHaveProperty('amount');
    expect(sd).toHaveProperty('nonce');
    expect(sd).toHaveProperty('expires');
    expect(sd).toHaveProperty('paymentIntent');
    // x402-shaped keys absent.
    expect(sd).not.toHaveProperty('from');
    expect(sd).not.toHaveProperty('validAfter');
    expect(sd).not.toHaveProperty('validBefore');
    // Dual-shaped keys absent.
    expect(sd).not.toHaveProperty('x402');
    expect(sd).not.toHaveProperty('mpp');
  });

  // -------------------------------------------------------------------------
  // Test 9: dispatcher → dual (BOTH helpers, packed signedData)
  // -------------------------------------------------------------------------

  it("[UNIT] signPayment — should call BOTH signX402 and signMPP when protocol is 'dual' and pack signedData as { x402, mpp } with x402 signature as primary", async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const payload = buildPayload('dual');

    const signed = await handler.signPayment(payload);

    expect(signed.protocol).toBe('dual');
    const sd = signed.signedData as Record<string, unknown>;
    expect(sd).toHaveProperty('x402');
    expect(sd).toHaveProperty('mpp');

    const x402Block = sd.x402 as Record<string, unknown>;
    const mppBlock = sd.mpp as Record<string, unknown>;

    // x402 block carries x402-shape; mpp block carries mpp-shape.
    expect(x402Block).toHaveProperty('from');
    expect(x402Block).toHaveProperty('signature');
    expect(mppBlock).toHaveProperty('payer');
    expect(mppBlock).toHaveProperty('signature');

    // Primary signature = the x402 signature.
    expect(signed.signature).toBe(x402Block.signature);

    // The two inner signatures MUST differ (different typed-data).
    expect(x402Block.signature).not.toBe(mppBlock.signature);
  });

  // -------------------------------------------------------------------------
  // Test 10: dispatcher → unsupported protocol throws
  // -------------------------------------------------------------------------

  it('[UNIT] signPayment — should throw PayBotApiError with code UNSUPPORTED_PROTOCOL and status 402 for unknown protocol values', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    // Cast through `unknown` to bypass the TS union; we are testing the
    // runtime default arm.
    const payload = buildPayload(
      'not-a-real-protocol' as unknown as PaymentIntent['protocol'],
    );

    await expect(handler.signPayment(payload)).rejects.toBeInstanceOf(
      PayBotApiError,
    );
    await expect(handler.signPayment(payload)).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROTOCOL',
      statusCode: 402,
    });
    await expect(handler.signPayment(payload)).rejects.toThrow(
      /not-a-real-protocol/,
    );
  });

  // -------------------------------------------------------------------------
  // Test 11: dispatcher → MISSING_WALLET_KEY when no key configured
  // -------------------------------------------------------------------------

  it('[UNIT] signPayment — should throw PayBotApiError with code MISSING_WALLET_KEY when walletPrivateKey is not configured', async () => {
    const handler = new X402Handler(); // no key
    const payload = buildPayload('x402');

    await expect(handler.signPayment(payload)).rejects.toMatchObject({
      name: 'PayBotApiError',
      code: 'MISSING_WALLET_KEY',
      statusCode: 402,
    });
  });

  // -------------------------------------------------------------------------
  // Test 12: REGRESSION — dual-mode MPP must be a real cryptographic signature
  // -------------------------------------------------------------------------

  it('[UNIT] signPayment — dual-mode mpp signature should be a real cryptographic signature, not metadata (proves dead-code bug is fixed)', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const payload = buildPayload('dual');

    const signed = await handler.signPayment(payload);
    const sd = signed.signedData as Record<string, unknown>;
    const mppBlock = sd.mpp as Record<string, unknown>;

    expect(mppBlock.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);

    // The single MOST IMPORTANT assertion in this story:
    // run EIP-712 signature recovery against the MPP typed-data
    // structure, with the FIXED nonce + FIXED timestamp, and confirm the
    // recovered address matches the test private key's account.
    //
    // If `signedData.mpp.signature` were inert metadata (the pre-refactor
    // bug), this recovery would either fail or recover a wrong address.
    const nowSec = BigInt(Math.floor(FIXED_NOW.getTime() / 1000));
    const recovered = await recoverTypedDataAddress({
      domain: buildMppDomain(payload.requirements.payTo),
      types: MPP_TYPES,
      primaryType: 'PaymentAuthorization',
      message: {
        payer: TEST_ACCOUNT_ADDRESS,
        recipient: payload.requirements.payTo as `0x${string}`,
        amount: BigInt(payload.requirements.amount),
        nonce: FIXED_NONCE,
        expires: nowSec + 3600n,
        paymentIntent: payload.paymentIntent.intentId,
      },
      signature: mppBlock.signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ACCOUNT_ADDRESS.toLowerCase());
  });

  // -------------------------------------------------------------------------
  // Test 13: REGRESSION — dual-mode x402 signature == x402-only signature
  // -------------------------------------------------------------------------

  it('[UNIT] signPayment — dual-mode x402 signature byte-for-byte equals x402-only signature for the same inputs (proves refactor is non-breaking)', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const requirements = buildRequirements();

    // Same inputs (same nonce, same timestamp, same private key) — the x402
    // signature MUST be byte-for-byte identical whether it was produced by
    // `protocol=x402` or by the `protocol=dual` extracted helper.
    const x402Only = await handler.signPayment(buildPayload('x402', requirements));
    const dual = await handler.signPayment(buildPayload('dual', requirements));

    const dualSd = dual.signedData as Record<string, unknown>;
    const dualX402Block = dualSd.x402 as Record<string, unknown>;

    expect(dualX402Block.signature).toBe(x402Only.signature);
    expect(dual.signature).toBe(x402Only.signature); // primary == x402
    // The complete x402-shaped sub-object must match the standalone output.
    expect(dualX402Block).toEqual(x402Only.signedData);
  });
});

// ===========================================================================
// Story 15 — Track A — Tests 14-26
//
// Extend x402-v2 coverage to ≥80% by exercising the remaining public surface:
//   - on402Response          (parses 402 responses, threads through private
//                             extractPaymentIntentHeader + parsePaymentIntent
//                             + parsePaymentResponseBody helpers)
//   - submitPayment          (POSTs signed payment via global fetch, parses
//                             Receipt, threads through private encodeSignedPayment)
//   - verifyReceipt          (POSTs receipt for verification, NEVER throws —
//                             returns boolean)
//   - createPaymentIntentHeader (static — base64-encodes a PaymentIntent)
//   - negotiatePaymentIntent    (static — currently always returns protocol='dual'
//                                with a TODO to honor _supportedProtocols)
//
// Determinism: fake-timers + frozen Math.random for `intent_<ts>_<rnd>` IDs.
// Network: global `fetch` is stubbed via `vi.stubGlobal` per test — no real I/O.
// ===========================================================================

/** Build a minimal valid PaymentRequiredResponse for on402Response tests. */
function build402Response(overrides?: {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const intent: PaymentIntent = {
    intentId: 'intent_test_402',
    protocol: 'dual',
    requirements: buildRequirements(),
    version: '2.0',
    createdAt: FIXED_NOW.toISOString(),
    expiresAt: new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
  };
  const encoded = Buffer.from(JSON.stringify(intent)).toString('base64');
  return {
    status: (overrides?.status ?? 402) as 402,
    headers: overrides?.headers ?? { 'Payment-Intent': `x402:v2:${encoded}` },
    body: overrides?.body ?? { requirements: buildRequirements() },
  };
}

describe('[UNIT] on402Response', () => {
  // -------------------------------------------------------------------------
  // Test 14: on402Response — happy path
  // -------------------------------------------------------------------------

  it('[UNIT] on402Response — should parse a valid 402 PaymentRequiredResponse with x402 v2 header into a PaymentPayload', () => {
    const handler = new X402Handler();
    const response = build402Response();

    const payload = handler.on402Response(response);

    expect(payload.paymentIntent.intentId).toBe('intent_test_402');
    expect(payload.paymentIntent.protocol).toBe('dual');
    expect(payload.requirements.amount).toBe('1000000');
    expect(payload.requirements.network).toBe('eip155:8453');
  });

  // -------------------------------------------------------------------------
  // Test 15: on402Response — error path (non-402 status)
  // -------------------------------------------------------------------------

  it('[UNIT] on402Response — should throw PayBotApiError when response.status !== 402', () => {
    const handler = new X402Handler();
    // Cast to 402 to bypass the `status: 402` literal-type guard — we want
    // the runtime guard at line 47 to fire.
    const response = build402Response({ status: 500 as unknown as 402 });

    expect(() => handler.on402Response(response)).toThrow(PayBotApiError);
    expect(() => handler.on402Response(response)).toThrow(/Expected HTTP 402/);
  });

  // -------------------------------------------------------------------------
  // Test 16: on402Response — edge case (missing/malformed header)
  // -------------------------------------------------------------------------

  it('[UNIT] on402Response — should throw PayBotApiError when payment-intent header is missing or malformed', () => {
    const handler = new X402Handler();

    // Case A: header missing entirely.
    const noHeader = build402Response({ headers: {} });
    expect(() => handler.on402Response(noHeader)).toThrow(PayBotApiError);
    expect(() => handler.on402Response(noHeader)).toThrow(
      /Payment-Intent header missing/,
    );

    // Case B: header present but malformed (not in `x402:v2:<b64>` form).
    const badHeader = build402Response({
      headers: { 'Payment-Intent': 'totally-not-a-valid-header' },
    });
    expect(() => handler.on402Response(badHeader)).toThrow(PayBotApiError);
    expect(() => handler.on402Response(badHeader)).toThrow(
      /Failed to parse Payment-Intent/,
    );
  });
});

describe('[UNIT] submitPayment', () => {
  // Build a minimal SignedPayment fixture for submitPayment tests. We do NOT
  // re-derive a real signature here — we only need the encodeSignedPayment
  // round-trip to produce a header, then assert the fetch call shape.
  function buildSignedPayment(): import('../src/types.js').SignedPayment {
    return {
      protocol: 'x402',
      signedData: {
        from: TEST_ACCOUNT_ADDRESS,
        to: '0x000000000000000000000000000000000000bEEF',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: FIXED_NONCE,
        signature:
          '0x' + 'a'.repeat(130), // fake signature, opaque to submitPayment
      },
      signature: '0x' + 'a'.repeat(130),
      timestamp: FIXED_NOW.getTime(),
    };
  }

  // -------------------------------------------------------------------------
  // Test 17: submitPayment — happy path
  // -------------------------------------------------------------------------

  it('[UNIT] submitPayment — should POST signed payment, encode header correctly, and return Receipt on 200 OK', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const signed = buildSignedPayment();
    const fakeReceipt = {
      receiptId: 'rcpt_abc',
      transactionId: '0xdeadbeef',
      status: 'confirmed',
      confirmedAt: '2026-05-22T12:00:00Z',
      amount: '1000000',
      network: 'eip155:8453',
      blockNumber: 42,
      gasUsed: '21000',
    };

    // WHY: stub the global fetch to assert: (a) request shape — URL, method,
    // headers including Payment-Intent-Authorization, (b) body has protocol +
    // spread signedData, (c) response is parsed into a typed Receipt.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fakeReceipt,
    });
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await handler.submitPayment(
      signed,
      'https://example.com/pay',
      'bearer-token-xyz',
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/pay');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Authorization']).toBe('Bearer bearer-token-xyz');
    expect(init.headers['Payment-Intent-Authorization']).toMatch(/^x402:v2:/);

    // Receipt parsed correctly.
    expect(receipt.receiptId).toBe('rcpt_abc');
    expect(receipt.transactionId).toBe('0xdeadbeef');
    expect(receipt.status).toBe('confirmed');
    expect(receipt.confirmedAt).toBeInstanceOf(Date);
    expect(receipt.amount).toBe('1000000');
    expect(receipt.network).toBe('eip155:8453');
    expect(receipt.blockNumber).toBe(42);
    expect(receipt.gasUsed).toBe('21000');

    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Test 18: submitPayment — error path (non-OK response)
  // -------------------------------------------------------------------------

  it('[UNIT] submitPayment — should throw PayBotApiError when fetch response is !ok (non-2xx)', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const signed = buildSignedPayment();

    // Server returns 400 with a structured error body — code/message/details
    // should propagate into the thrown PayBotApiError.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'Insufficient funds',
        code: 'INSUFFICIENT_FUNDS',
        details: { available: '0', required: '1000000' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      handler.submitPayment(signed, 'https://example.com/pay'),
    ).rejects.toMatchObject({
      name: 'PayBotApiError',
      code: 'INSUFFICIENT_FUNDS',
      statusCode: 400,
    });

    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Test 19: submitPayment — error path (network error rewrap)
  // -------------------------------------------------------------------------

  it('[UNIT] submitPayment — should rewrap network errors as PayBotApiError preserving the original message', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const signed = buildSignedPayment();

    // Simulate a network-layer failure (e.g. DNS, TCP reset) — fetch itself
    // throws. The handler must catch + rewrap, preserving the cause message.
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      handler.submitPayment(signed, 'https://example.com/pay'),
    ).rejects.toMatchObject({
      name: 'PayBotApiError',
      code: 'PAYMENT_SUBMISSION_ERROR',
      statusCode: 0,
    });
    await expect(
      handler.submitPayment(signed, 'https://example.com/pay'),
    ).rejects.toThrow(/ECONNREFUSED/);

    vi.unstubAllGlobals();
  });
});

describe('[UNIT] verifyReceipt', () => {
  function buildReceipt(): import('../src/types.js').Receipt {
    return {
      receiptId: 'rcpt_abc',
      transactionId: '0xdeadbeef',
      status: 'confirmed',
      amount: '1000000',
      network: 'eip155:8453',
    };
  }

  // -------------------------------------------------------------------------
  // Test 20: verifyReceipt — happy path
  // -------------------------------------------------------------------------

  it('[UNIT] verifyReceipt — should POST receipt to verification endpoint and return true on 200 OK with { verified: true }', async () => {
    const handler = new X402Handler();
    const receipt = buildReceipt();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler.verifyReceipt(
      receipt,
      'https://example.com/verify',
    );

    expect(result).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/verify');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.receiptId).toBe('rcpt_abc');
    expect(body.transactionId).toBe('0xdeadbeef');

    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Test 21: verifyReceipt — error path (non-2xx)
  // -------------------------------------------------------------------------

  it('[UNIT] verifyReceipt — should return false when verification endpoint returns non-2xx', async () => {
    const handler = new X402Handler();
    const receipt = buildReceipt();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler.verifyReceipt(
      receipt,
      'https://example.com/verify',
    );
    expect(result).toBe(false);

    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Test 22: verifyReceipt — edge case (network error, must NOT throw)
  // -------------------------------------------------------------------------

  it('[UNIT] verifyReceipt — should return false on network errors without throwing', async () => {
    const handler = new X402Handler();
    const receipt = buildReceipt();

    // WHY: verifyReceipt's contract differs from submitPayment — it catches
    // and returns false instead of throwing. Lock this in (line 488-490).
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler.verifyReceipt(
      receipt,
      'https://example.com/verify',
    );
    expect(result).toBe(false);

    vi.unstubAllGlobals();
  });
});

describe('[UNIT] createPaymentIntentHeader', () => {
  // -------------------------------------------------------------------------
  // Test 23: createPaymentIntentHeader — happy path
  // -------------------------------------------------------------------------

  it('[UNIT] createPaymentIntentHeader — should serialize PaymentIntent to x402 v2 header format', () => {
    const intent: PaymentIntent = {
      intentId: 'intent_test_create',
      protocol: 'x402',
      requirements: buildRequirements(),
      version: '2.0',
      createdAt: FIXED_NOW.toISOString(),
      expiresAt: new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
    };

    const header = X402Handler.createPaymentIntentHeader(intent);

    expect(header.startsWith('x402:v2:')).toBe(true);

    // Round-trip: decode the base64 payload and verify it matches the input.
    const b64 = header.slice('x402:v2:'.length);
    const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    expect(decoded.intentId).toBe('intent_test_create');
    expect(decoded.protocol).toBe('x402');
    expect(decoded.requirements.amount).toBe('1000000');
  });

  // -------------------------------------------------------------------------
  // Test 24: createPaymentIntentHeader — edge case (optional fields undefined)
  // -------------------------------------------------------------------------

  it('[UNIT] createPaymentIntentHeader — should handle PaymentIntent with optional merchant/meta fields undefined', () => {
    const intent: PaymentIntent = {
      intentId: 'intent_minimal',
      protocol: 'mpp',
      requirements: buildRequirements(),
      // merchant + meta intentionally omitted
      version: '2.0',
      createdAt: FIXED_NOW.toISOString(),
      expiresAt: new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
    };

    const header = X402Handler.createPaymentIntentHeader(intent);
    expect(header.startsWith('x402:v2:')).toBe(true);

    const b64 = header.slice('x402:v2:'.length);
    const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    expect(decoded.merchant).toBeUndefined();
    expect(decoded.meta).toBeUndefined();
    expect(decoded.intentId).toBe('intent_minimal');
  });
});

describe('[UNIT] negotiatePaymentIntent', () => {
  // -------------------------------------------------------------------------
  // Test 25: negotiatePaymentIntent — happy path
  // -------------------------------------------------------------------------

  it("[UNIT] negotiatePaymentIntent — should return a PaymentIntent with protocol='dual' and a properly formatted intentId when called with default supportedProtocols", () => {
    // Mock Math.random for deterministic intentId suffix.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const requirements = buildRequirements();
    const intent = X402Handler.negotiatePaymentIntent(requirements);

    expect(intent.protocol).toBe('dual');
    expect(intent.requirements).toEqual(requirements);
    expect(intent.version).toBe('2.0');
    expect(intent.intentId).toMatch(/^intent_\d+_[0-9a-z]+$/);

    // createdAt is now (fake timer); expiresAt is +5 min.
    expect(new Date(intent.createdAt).getTime()).toBe(FIXED_NOW.getTime());
    expect(new Date(intent.expiresAt).getTime()).toBe(
      FIXED_NOW.getTime() + 300_000,
    );

    randomSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 26: negotiatePaymentIntent — edge case (TODO branch)
  // -------------------------------------------------------------------------

  it("[UNIT] negotiatePaymentIntent — should currently ignore supportedProtocols arg and always return protocol='dual' (covers the documented TODO branch from Story 14 QA)", () => {
    // WHY: Story 14 QA flagged that line 512 has a TODO to honor
    // _supportedProtocols. Current behavior: ignore the arg, always 'dual'.
    // This test LOCKS the current behavior — if a future story honors the
    // arg, this test must be updated (and the TODO removed) at the same time.
    const requirements = buildRequirements();

    const onlyX402 = X402Handler.negotiatePaymentIntent(requirements, ['x402']);
    const onlyMpp = X402Handler.negotiatePaymentIntent(requirements, ['mpp']);
    const both = X402Handler.negotiatePaymentIntent(requirements, [
      'x402',
      'mpp',
    ]);

    // Despite different "supportedProtocols" inputs, all return 'dual' today.
    expect(onlyX402.protocol).toBe('dual');
    expect(onlyMpp.protocol).toBe('dual');
    expect(both.protocol).toBe('dual');
  });
});
