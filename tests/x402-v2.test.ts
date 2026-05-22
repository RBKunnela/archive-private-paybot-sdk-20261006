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
