/**
 * @module tests/x402-v2-conformance
 *
 * x402 v2 conformance pass. Exercises the ADDITIVE, backward-compatible surface
 * added to bring paybot-sdk in line with the current x402 spec
 * (`x402-foundation/x402`, Linux Foundation):
 *
 *   1. `upto` scheme — metered/usage billing. Signs an EIP-3009 authorization
 *      for the MAXIMUM amount (`signUpto`) + `validateUptoCapture` guard.
 *   2. x402 v2 PAYMENT-* headers — `PAYMENT-REQUIRED` parsing in `on402Response`,
 *      `PAYMENT-SIGNATURE` emission in `submitPayment`, and the static
 *      `parsePaymentResponseHeader` (`PAYMENT-RESPONSE`).
 *   3. CAIP-2 validation — `parseCaip2` / `isSupportedCaip2`, and the
 *      `INVALID_CAIP2` error wired into the signing path.
 *
 * Determinism mirrors `tests/x402-v2.test.ts`: fake timers + a fixed nonce so
 * EIP-712 signatures are byte-identical across runs.
 *
 * Test naming convention: `[UNIT] subject — should [behavior] when [condition]`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { X402Handler } from '../src/x402-v2.js';
import { PayBotApiError } from '../src/errors.js';
import {
  parseCaip2,
  isSupportedCaip2,
  EIP712_DOMAINS,
  EIP3009_TYPES,
} from '../src/networks.js';
import type {
  PaymentIntent,
  PaymentPayload,
  PaymentRequirements,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Deterministic fixtures (shared with x402-v2.test.ts conventions)
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as const;
const TEST_ACCOUNT_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY).address;

const FIXED_NOW = new Date('2026-05-22T12:00:00Z');
const FIXED_NONCE =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`;

vi.mock('../src/crypto.js', () => ({
  generateEIP3009Nonce: vi.fn(() => FIXED_NONCE),
}));

function buildRequirements(
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '1000000',
    payTo: '0x000000000000000000000000000000000000bEEF',
    maxTimeoutSeconds: 300,
    ...overrides,
  };
}

function buildPayload(
  requirements: PaymentRequirements = buildRequirements(),
  protocol: PaymentIntent['protocol'] = 'x402',
): PaymentPayload {
  const paymentIntent: PaymentIntent = {
    intentId: 'intent_conf_123',
    protocol,
    requirements,
    version: '2.0',
    createdAt: FIXED_NOW.toISOString(),
    expiresAt: new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
  };
  return { paymentIntent, requirements };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  // Intentionally NOT restoring mocks — keep the crypto module mock in place.
});

// ===========================================================================
// Deliverable 1 — `upto` scheme: signUpto
// ===========================================================================

describe('[UNIT] signUpto (upto / metered scheme)', () => {
  it('[UNIT] signUpto — should sign for maxAmount and mark scheme=upto when maxAmount is present', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const requirements = buildRequirements({
      scheme: 'upto',
      amount: '1000000',
      maxAmount: '5000000',
    });

    const signed = await handler.signPayment(buildPayload(requirements));

    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    const sd = signed.signedData as Record<string, unknown>;
    expect(sd.scheme).toBe('upto');
    expect(sd.maxAmount).toBe('5000000');
    // Critically: the signed value is the MAX, not the requested amount.
    expect(sd.value).toBe('5000000');

    // The signature must verify against the MAX value (proves it signs the cap).
    const nowSec = BigInt(Math.floor(FIXED_NOW.getTime() / 1000));
    const recovered = await recoverTypedDataAddress({
      domain: EIP712_DOMAINS['eip155:8453'],
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: TEST_ACCOUNT_ADDRESS,
        to: requirements.payTo as `0x${string}`,
        value: 5000000n,
        validAfter: 0n,
        validBefore: nowSec + 3600n,
        nonce: FIXED_NONCE,
      },
      signature: signed.signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ACCOUNT_ADDRESS.toLowerCase());
  });

  it('[UNIT] signUpto — should fall back to amount as the cap when maxAmount is absent', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const requirements = buildRequirements({ scheme: 'upto', amount: '2500000' });
    // no maxAmount

    const signed = await handler.signPayment(buildPayload(requirements));

    const sd = signed.signedData as Record<string, unknown>;
    expect(sd.value).toBe('2500000');
    expect(sd.maxAmount).toBe('2500000');
    expect(sd.scheme).toBe('upto');
  });

  it('[UNIT] signUpto — should throw INVALID_CAIP2 when the upto network is malformed', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const requirements = buildRequirements({
      scheme: 'upto',
      network: 'not-a-network',
      maxAmount: '5000000',
    });

    await expect(
      handler.signPayment(buildPayload(requirements)),
    ).rejects.toMatchObject({
      name: 'PayBotApiError',
      code: 'INVALID_CAIP2',
      statusCode: 400,
    });
  });

  it('[UNIT] signUpto — should throw UNSUPPORTED_NETWORK for a well-formed but unknown upto network', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const requirements = buildRequirements({
      scheme: 'upto',
      network: 'eip155:999999',
      maxAmount: '5000000',
    });

    await expect(
      handler.signPayment(buildPayload(requirements)),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK', statusCode: 402 });
  });

  it('[UNIT] signPayment — should keep existing exact-scheme x402 behavior unchanged (upto dispatch is additive)', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const signed = await handler.signPayment(buildPayload(buildRequirements()));
    const sd = signed.signedData as Record<string, unknown>;
    // exact path: x402-shaped, no upto markers.
    expect(sd).toHaveProperty('from');
    expect(sd).not.toHaveProperty('scheme');
    expect(sd).not.toHaveProperty('maxAmount');
  });
});

// ===========================================================================
// Deliverable 1 — `upto` scheme: validateUptoCapture
// ===========================================================================

describe('[UNIT] validateUptoCapture', () => {
  it('[UNIT] validateUptoCapture — should return the captured amount when below the authorized max', () => {
    expect(X402Handler.validateUptoCapture('5000000', '3000000')).toBe(
      '3000000',
    );
  });

  it('[UNIT] validateUptoCapture — should allow a capture exactly equal to the authorized max (boundary)', () => {
    expect(X402Handler.validateUptoCapture('5000000', '5000000')).toBe(
      '5000000',
    );
  });

  it('[UNIT] validateUptoCapture — should throw UPTO_OVERCHARGE when captured exceeds the authorized max', () => {
    expect(() =>
      X402Handler.validateUptoCapture('5000000', '6000000'),
    ).toThrow(PayBotApiError);
    try {
      X402Handler.validateUptoCapture('5000000', '6000000');
    } catch (e) {
      const err = e as PayBotApiError;
      expect(err.code).toBe('UPTO_OVERCHARGE');
      expect(err.statusCode).toBe(402);
      expect(err.details).toMatchObject({
        authorizedMax: '5000000',
        captured: '6000000',
      });
    }
  });

  it('[UNIT] validateUptoCapture — should throw INVALID_AMOUNT for non-integer inputs', () => {
    expect(() => X402Handler.validateUptoCapture('5000000', '1.5')).toThrow(
      PayBotApiError,
    );
    try {
      X402Handler.validateUptoCapture('5000000', 'abc');
    } catch (e) {
      expect((e as PayBotApiError).code).toBe('INVALID_AMOUNT');
      expect((e as PayBotApiError).statusCode).toBe(400);
    }
    // Large values must compare correctly via BigInt (no float precision loss).
    const big = '90000000000000000000';
    expect(X402Handler.validateUptoCapture(big, big)).toBe(big);
  });
});

// ===========================================================================
// Deliverable 2 — PAYMENT-REQUIRED parsing in on402Response
// ===========================================================================

describe('[UNIT] on402Response — PAYMENT-REQUIRED (v2 header)', () => {
  it('[UNIT] on402Response — should parse a v2 PAYMENT-REQUIRED header carrying a full PaymentIntent', () => {
    const handler = new X402Handler();
    const intent: PaymentIntent = {
      intentId: 'intent_v2',
      protocol: 'x402',
      requirements: buildRequirements(),
      version: '2.0',
      createdAt: FIXED_NOW.toISOString(),
      expiresAt: new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
    };
    const encoded = Buffer.from(JSON.stringify(intent)).toString('base64');

    const payload = handler.on402Response({
      status: 402,
      headers: { 'PAYMENT-REQUIRED': encoded },
      body: { requirements: buildRequirements() },
    });

    expect(payload.paymentIntent.intentId).toBe('intent_v2');
    expect(payload.requirements.amount).toBe('1000000');
  });

  it('[UNIT] on402Response — should wrap a bare PaymentRequirements PAYMENT-REQUIRED payload into a synthesized PaymentIntent', () => {
    const handler = new X402Handler();
    // v2 header may carry bare requirements (no enclosing intent).
    const bare = buildRequirements({ amount: '750000' });
    const encoded = Buffer.from(JSON.stringify(bare)).toString('base64');

    const payload = handler.on402Response({
      status: 402,
      headers: { 'PAYMENT-REQUIRED': encoded },
      body: { requirements: bare },
    });

    expect(payload.paymentIntent.protocol).toBe('x402');
    expect(payload.paymentIntent.version).toBe('2.0');
    expect(payload.requirements.amount).toBe('750000');
  });

  it('[UNIT] on402Response — should read PAYMENT-REQUIRED case-insensitively', () => {
    const handler = new X402Handler();
    const encoded = Buffer.from(
      JSON.stringify({ requirements: buildRequirements() }),
    ).toString('base64');

    const payload = handler.on402Response({
      status: 402,
      headers: { 'payment-required': encoded },
      body: { requirements: buildRequirements() },
    });

    expect(payload.requirements.amount).toBe('1000000');
  });

  it('[UNIT] on402Response — should prefer PAYMENT-REQUIRED over legacy Payment-Intent when both present', () => {
    const handler = new X402Handler();
    const v2Reqs = buildRequirements({ amount: '111' });
    const v2Encoded = Buffer.from(JSON.stringify(v2Reqs)).toString('base64');

    const legacyIntent: PaymentIntent = {
      intentId: 'legacy',
      protocol: 'dual',
      requirements: buildRequirements({ amount: '999' }),
      version: '2.0',
      createdAt: FIXED_NOW.toISOString(),
      expiresAt: new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
    };
    const legacyEncoded = Buffer.from(
      JSON.stringify(legacyIntent),
    ).toString('base64');

    const payload = handler.on402Response({
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': v2Encoded,
        'Payment-Intent': `x402:v2:${legacyEncoded}`,
      },
      body: { requirements: v2Reqs },
    });

    // v2 wins → amount from the v2 body.
    expect(payload.requirements.amount).toBe('111');
  });

  it('[UNIT] on402Response — should throw INVALID_PAYMENT_INTENT_FORMAT on a malformed PAYMENT-REQUIRED header', () => {
    const handler = new X402Handler();
    expect(() =>
      handler.on402Response({
        status: 402,
        headers: { 'PAYMENT-REQUIRED': '!!!not-base64-json!!!' },
        body: { requirements: buildRequirements() },
      }),
    ).toThrow(/Failed to parse PAYMENT-REQUIRED/);
  });

  it('[UNIT] on402Response — should still parse the legacy Payment-Intent path when no v2 header is present', () => {
    const handler = new X402Handler();
    const intent: PaymentIntent = {
      intentId: 'legacy_only',
      protocol: 'dual',
      requirements: buildRequirements(),
      version: '2.0',
      createdAt: FIXED_NOW.toISOString(),
      expiresAt: new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
    };
    const encoded = Buffer.from(JSON.stringify(intent)).toString('base64');

    const payload = handler.on402Response({
      status: 402,
      headers: { 'Payment-Intent': `x402:v2:${encoded}` },
      body: { requirements: buildRequirements() },
    });

    expect(payload.paymentIntent.intentId).toBe('legacy_only');
  });
});

// ===========================================================================
// Deliverable 2 — PAYMENT-SIGNATURE header in submitPayment
// ===========================================================================

describe('[UNIT] submitPayment — PAYMENT-SIGNATURE (v2 header)', () => {
  function buildSignedPayment(): import('../src/types.js').SignedPayment {
    return {
      protocol: 'x402',
      signedData: {
        from: TEST_ACCOUNT_ADDRESS,
        to: '0x000000000000000000000000000000000000bEEF',
        value: '1000000',
        nonce: FIXED_NONCE,
        signature: '0x' + 'a'.repeat(130),
      },
      signature: '0x' + 'a'.repeat(130),
      timestamp: FIXED_NOW.getTime(),
    };
  }

  it('[UNIT] submitPayment — should set both PAYMENT-SIGNATURE and the legacy Payment-Intent-Authorization header', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        receiptId: 'rcpt_v2',
        status: 'confirmed',
        amount: '1000000',
        network: 'eip155:8453',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await handler.submitPayment(buildSignedPayment(), 'https://example.com/pay');

    const [, init] = fetchMock.mock.calls[0];
    // Legacy header still present (back-compat).
    expect(init.headers['Payment-Intent-Authorization']).toMatch(/^x402:v2:/);
    // v2 header present and is bare base64 (no x402:v2: prefix).
    expect(init.headers['PAYMENT-SIGNATURE']).toBeDefined();
    expect(init.headers['PAYMENT-SIGNATURE']).not.toMatch(/^x402:v2:/);

    // Round-trip the v2 header back to the signed payload.
    const decoded = JSON.parse(
      Buffer.from(init.headers['PAYMENT-SIGNATURE'], 'base64').toString('utf-8'),
    );
    expect(decoded.protocol).toBe('x402');
    expect(decoded.signature).toBe('0x' + 'a'.repeat(130));

    vi.unstubAllGlobals();
  });

  it('[UNIT] encodePaymentSignatureHeader — should produce bare base64 that round-trips to the signed payload', () => {
    const signed = buildSignedPayment();
    const header = X402Handler.encodePaymentSignatureHeader(signed);
    expect(header).not.toMatch(/^x402:v2:/);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    expect(decoded.timestamp).toBe(FIXED_NOW.getTime());
  });
});

// ===========================================================================
// Deliverable 2 — parsePaymentResponseHeader (PAYMENT-RESPONSE)
// ===========================================================================

describe('[UNIT] parsePaymentResponseHeader (PAYMENT-RESPONSE)', () => {
  it('[UNIT] parsePaymentResponseHeader — should decode a base64 JSON settlement confirmation', () => {
    const b64 = Buffer.from(
      JSON.stringify({
        receiptId: 'r1',
        status: 'confirmed',
        transactionId: '0xabc',
      }),
    ).toString('base64');

    const out = X402Handler.parsePaymentResponseHeader(b64);
    expect(out).toEqual({
      receiptId: 'r1',
      status: 'confirmed',
      transactionId: '0xabc',
    });
  });

  it('[UNIT] parsePaymentResponseHeader — should tolerate snake_case and txHash field variants and default status to pending', () => {
    const b64 = Buffer.from(
      JSON.stringify({ receipt_id: 'r2', txHash: '0xdef' }),
    ).toString('base64');

    const out = X402Handler.parsePaymentResponseHeader(b64);
    expect(out.receiptId).toBe('r2');
    expect(out.transactionId).toBe('0xdef');
    expect(out.status).toBe('pending');
  });

  it('[UNIT] parsePaymentResponseHeader — should throw INVALID_PAYMENT_RESPONSE on malformed base64/JSON', () => {
    expect(() =>
      X402Handler.parsePaymentResponseHeader('%%%not-json%%%'),
    ).toThrow(PayBotApiError);
    try {
      X402Handler.parsePaymentResponseHeader('%%%not-json%%%');
    } catch (e) {
      expect((e as PayBotApiError).code).toBe('INVALID_PAYMENT_RESPONSE');
      expect((e as PayBotApiError).statusCode).toBe(502);
    }
  });

  it('[UNIT] parsePaymentResponseHeader — should throw INVALID_PAYMENT_RESPONSE when payload decodes to a non-object (edge)', () => {
    // Valid base64 JSON, but the value is a primitive, not an object.
    const b64 = Buffer.from('123').toString('base64');
    expect(() => X402Handler.parsePaymentResponseHeader(b64)).toThrow(
      /did not decode to an object|missing receiptId/,
    );
    try {
      X402Handler.parsePaymentResponseHeader(b64);
    } catch (e) {
      expect((e as PayBotApiError).code).toBe('INVALID_PAYMENT_RESPONSE');
    }
  });

  it('[UNIT] parsePaymentResponseHeader — should throw INVALID_PAYMENT_RESPONSE when receiptId is missing (edge)', () => {
    const b64 = Buffer.from(JSON.stringify({ status: 'confirmed' })).toString(
      'base64',
    );
    expect(() => X402Handler.parsePaymentResponseHeader(b64)).toThrow(
      /missing receiptId/,
    );
  });
});

// ===========================================================================
// Deliverable 3 — CAIP-2 helpers
// ===========================================================================

describe('[UNIT] parseCaip2', () => {
  it('[UNIT] parseCaip2 — should split a valid eip155:<chainId> into namespace + reference', () => {
    expect(parseCaip2('eip155:8453')).toEqual({
      namespace: 'eip155',
      reference: '8453',
    });
    expect(parseCaip2('eip155:84532')).toEqual({
      namespace: 'eip155',
      reference: '84532',
    });
  });

  it('[UNIT] parseCaip2 — should throw INVALID_CAIP2 for non-eip155 namespaces or non-numeric references', () => {
    for (const bad of ['solana:foo', 'eip155:', 'eip155:abc', 'eip155']) {
      expect(() => parseCaip2(bad)).toThrow(PayBotApiError);
      try {
        parseCaip2(bad);
      } catch (e) {
        expect((e as PayBotApiError).code).toBe('INVALID_CAIP2');
        expect((e as PayBotApiError).statusCode).toBe(400);
      }
    }
  });

  it('[UNIT] parseCaip2 — should throw INVALID_CAIP2 for empty / non-string input (edge)', () => {
    expect(() => parseCaip2('')).toThrow(/non-empty string/);
    expect(() =>
      parseCaip2(undefined as unknown as string),
    ).toThrow(PayBotApiError);
    // Reject extra colons too.
    expect(() => parseCaip2('eip155:8453:extra')).toThrow(PayBotApiError);
  });
});

describe('[UNIT] isSupportedCaip2', () => {
  it('[UNIT] isSupportedCaip2 — should return true for supported networks', () => {
    expect(isSupportedCaip2('eip155:8453')).toBe(true);
    expect(isSupportedCaip2('eip155:84532')).toBe(true);
  });

  it('[UNIT] isSupportedCaip2 — should return false for well-formed but unsupported chains', () => {
    expect(isSupportedCaip2('eip155:1')).toBe(false);
    expect(isSupportedCaip2('eip155:999999')).toBe(false);
  });

  it('[UNIT] isSupportedCaip2 — should return false (never throw) for malformed input (edge)', () => {
    expect(isSupportedCaip2('not-a-caip2')).toBe(false);
    expect(isSupportedCaip2('')).toBe(false);
    expect(isSupportedCaip2('solana:mainnet')).toBe(false);
  });
});

// ===========================================================================
// Deliverable 3 — INVALID_CAIP2 wired into the signing path (exact scheme)
// ===========================================================================

describe('[UNIT] signPayment — CAIP-2 enforcement', () => {
  it('[UNIT] signPayment — should throw INVALID_CAIP2 when an exact-scheme requirements carries a malformed network', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const requirements = buildRequirements({ network: 'garbage' });

    await expect(
      handler.signPayment(buildPayload(requirements)),
    ).rejects.toMatchObject({ code: 'INVALID_CAIP2', statusCode: 400 });
  });

  it('[UNIT] signPayment — should STILL throw UNSUPPORTED_NETWORK (not INVALID_CAIP2) for well-formed unknown chains (regression guard)', async () => {
    const handler = new X402Handler(TEST_PRIVATE_KEY);
    const requirements = buildRequirements({ network: 'eip155:999999' });

    await expect(
      handler.signPayment(buildPayload(requirements)),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK', statusCode: 402 });
  });
});
