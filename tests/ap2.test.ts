/**
 * @module tests/ap2
 *
 * Unit tests for the AP2 → x402 settlement adapter (`src/ap2.ts`).
 *
 * Covers:
 *   - ap2MandateToPaymentRequirements: USDC + EURC happy paths, missing-field
 *     throw, unknown-currency throw, network-not-supported throw.
 *   - Ap2Adapter.validateMandate: valid / expired / missing-field.
 *   - isAp2Mandate: structural guard true/false.
 *   - Ap2Adapter.settle: signs + submits via a mocked X402Handler and returns
 *     the Receipt; rejects an expired mandate before signing.
 *
 * Test naming convention: `[UNIT] symbol — should [behavior] when [condition]`.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  ap2MandateToPaymentRequirements,
  isAp2Mandate,
  Ap2Adapter,
  type Ap2PaymentMandate,
} from '../src/ap2.js';
import { PayBotApiError } from '../src/errors.js';
import type { X402Handler } from '../src/x402-v2.js';
import type { Receipt, SignedPayment } from '../src/types.js';

/** Build a complete, valid USDC mandate; override per test. */
function buildMandate(
  overrides: Partial<Ap2PaymentMandate> = {},
): Ap2PaymentMandate {
  return {
    mandateId: 'mandate_abc',
    intentId: 'intent_xyz',
    payer: '0x000000000000000000000000000000000000aaaa',
    payee: '0x000000000000000000000000000000000000bEEF',
    amount: '1000000', // 1 USDC (6 decimals)
    currency: 'USDC',
    network: 'eip155:8453',
    ...overrides,
  };
}

const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EURC_BASE_ADDRESS = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';

describe('ap2MandateToPaymentRequirements', () => {
  it('[UNIT] ap2MandateToPaymentRequirements — should translate a USDC mandate when all fields present', () => {
    const reqs = ap2MandateToPaymentRequirements(buildMandate());
    expect(reqs.scheme).toBe('exact');
    expect(reqs.network).toBe('eip155:8453');
    expect(reqs.token).toBe('USDC');
    expect(reqs.amount).toBe('1000000');
    expect(reqs.payTo).toBe('0x000000000000000000000000000000000000bEEF');
    expect(reqs.asset).toBe(`eip155:8453/erc20:${USDC_BASE_ADDRESS}`);
    expect(reqs.maxTimeoutSeconds).toBe(300); // default when no expiresAt
  });

  it('[UNIT] ap2MandateToPaymentRequirements — should resolve the EURC asset when currency is EURC', () => {
    const reqs = ap2MandateToPaymentRequirements(
      buildMandate({ currency: 'EURC', amount: '2500000' }),
    );
    expect(reqs.token).toBe('EURC');
    expect(reqs.amount).toBe('2500000');
    expect(reqs.asset).toBe(`eip155:8453/erc20:${EURC_BASE_ADDRESS}`);
  });

  it('[UNIT] ap2MandateToPaymentRequirements — should derive maxTimeoutSeconds from a future expiresAt', () => {
    const future = new Date(Date.now() + 600_000).toISOString(); // ~600s ahead
    const reqs = ap2MandateToPaymentRequirements(
      buildMandate({ expiresAt: future }),
    );
    expect(reqs.maxTimeoutSeconds).toBeGreaterThan(0);
    expect(reqs.maxTimeoutSeconds).toBeLessThanOrEqual(600);
  });

  it('[UNIT] ap2MandateToPaymentRequirements — should throw INVALID_AP2_MANDATE when a required field is missing', () => {
    const bad = buildMandate();
    // Remove a required field at runtime.
    delete (bad as Partial<Ap2PaymentMandate>).payee;
    try {
      ap2MandateToPaymentRequirements(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PayBotApiError);
      expect((err as PayBotApiError).code).toBe('INVALID_AP2_MANDATE');
      expect((err as PayBotApiError).statusCode).toBe(400);
    }
  });

  it('[UNIT] ap2MandateToPaymentRequirements — should throw UNSUPPORTED_TOKEN when currency is unknown', () => {
    try {
      ap2MandateToPaymentRequirements(buildMandate({ currency: 'DOGE' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PayBotApiError);
      expect((err as PayBotApiError).code).toBe('UNSUPPORTED_TOKEN');
      expect((err as PayBotApiError).statusCode).toBe(400);
    }
  });

  it('[UNIT] ap2MandateToPaymentRequirements — should throw UNSUPPORTED_NETWORK when token not deployed on network', () => {
    try {
      // USDC is a known token but not registered on eip155:1 in this SDK.
      ap2MandateToPaymentRequirements(buildMandate({ network: 'eip155:1' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PayBotApiError);
      expect((err as PayBotApiError).code).toBe('UNSUPPORTED_NETWORK');
      expect((err as PayBotApiError).statusCode).toBe(400);
    }
  });
});

describe('isAp2Mandate', () => {
  it('[UNIT] isAp2Mandate — should return true for a structurally complete mandate', () => {
    expect(isAp2Mandate(buildMandate())).toBe(true);
  });

  it('[UNIT] isAp2Mandate — should return false when required fields are absent', () => {
    expect(isAp2Mandate({ payer: '0xaaa' })).toBe(false);
  });

  it('[UNIT] isAp2Mandate — should return false for non-object inputs', () => {
    expect(isAp2Mandate(null)).toBe(false);
    expect(isAp2Mandate('mandate')).toBe(false);
    expect(isAp2Mandate(42)).toBe(false);
  });
});

describe('Ap2Adapter.validateMandate', () => {
  /** Minimal stub handler — validateMandate does not touch it. */
  const adapter = new Ap2Adapter({} as unknown as X402Handler);

  it('[UNIT] validateMandate — should be valid for a complete, unexpired mandate', () => {
    const result = adapter.validateMandate(buildMandate());
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('[UNIT] validateMandate — should be valid for a future expiresAt', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(adapter.validateMandate(buildMandate({ expiresAt: future })).valid).toBe(
      true,
    );
  });

  it('[UNIT] validateMandate — should be invalid when expiresAt is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = adapter.validateMandate(buildMandate({ expiresAt: past }));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('mandate expired');
  });

  it('[UNIT] validateMandate — should be invalid when a required field is missing', () => {
    const bad = buildMandate();
    delete (bad as Partial<Ap2PaymentMandate>).amount;
    const result = adapter.validateMandate(bad);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('amount');
  });

  it('[UNIT] validateMandate — should be invalid when expiresAt is not a valid date', () => {
    const result = adapter.validateMandate(
      buildMandate({ expiresAt: 'not-a-date' }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('ISO-8601');
  });
});

describe('Ap2Adapter.settle', () => {
  const fakeSigned: SignedPayment = {
    protocol: 'x402',
    signedData: { from: '0xaaa', to: '0xbEEF', value: '1000000' },
    signature: '0xsig',
    timestamp: 1_700_000_000_000,
  };

  const fakeReceipt: Receipt = {
    receiptId: 'rcpt_1',
    transactionId: '0xtx',
    status: 'confirmed',
    amount: '1000000',
    network: 'eip155:8453',
  };

  function buildMockHandler() {
    const signPayment = vi.fn().mockResolvedValue(fakeSigned);
    const submitPayment = vi.fn().mockResolvedValue(fakeReceipt);
    const handler = { signPayment, submitPayment } as unknown as X402Handler;
    return { handler, signPayment, submitPayment };
  }

  it('[UNIT] settle — should sign then submit and return the receipt (happy path)', async () => {
    const { handler, signPayment, submitPayment } = buildMockHandler();
    const adapter = new Ap2Adapter(handler);

    const receipt = await adapter.settle(buildMandate(), {
      paymentEndpoint: 'https://merchant.example/settle',
      authToken: 'tok_123',
    });

    expect(receipt).toEqual(fakeReceipt);

    // signPayment received an x402 payload built from the mandate.
    expect(signPayment).toHaveBeenCalledTimes(1);
    const payloadArg = signPayment.mock.calls[0][0];
    expect(payloadArg.paymentIntent.protocol).toBe('x402');
    expect(payloadArg.requirements.token).toBe('USDC');
    expect(payloadArg.requirements.payTo).toBe(
      '0x000000000000000000000000000000000000bEEF',
    );

    // submitPayment received the signed payload + endpoint + auth token.
    expect(submitPayment).toHaveBeenCalledTimes(1);
    expect(submitPayment).toHaveBeenCalledWith(
      fakeSigned,
      'https://merchant.example/settle',
      'tok_123',
    );
  });

  it('[UNIT] settle — should use the default endpoint when none is provided', async () => {
    const { handler, submitPayment } = buildMockHandler();
    const adapter = new Ap2Adapter(handler);

    await adapter.settle(buildMandate());

    const endpointArg = submitPayment.mock.calls[0][1] as string;
    expect(endpointArg).toContain('paybotcore.com');
  });

  it('[UNIT] settle — should throw INVALID_AP2_MANDATE and not sign when the mandate is expired', async () => {
    const { handler, signPayment } = buildMockHandler();
    const adapter = new Ap2Adapter(handler);
    const past = new Date(Date.now() - 60_000).toISOString();

    await expect(
      adapter.settle(buildMandate({ expiresAt: past })),
    ).rejects.toMatchObject({ code: 'INVALID_AP2_MANDATE', statusCode: 400 });

    expect(signPayment).not.toHaveBeenCalled();
  });
});
