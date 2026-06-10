/**
 * Story AK-1 - Ap2Adapter.settleVc fail-closed settlement tests (AC2/AC4).
 *
 * Proves the core security property: a mandate that fails verification NEVER
 * reaches translation or signing (the mocked handler observes zero calls),
 * and a verified mandate cannot settle twice (replay store, keyed
 * (mandateId, cartHash)).
 */

import { describe, it, expect, vi } from 'vitest';
import { Ap2Adapter } from '../src/ap2.js';
import { PayBotApiError } from '../src/errors.js';
import { InMemoryReplayStore } from '../src/ap2-vc.js';
import type { Ap2MandateVc } from '../src/ap2-vc.js';
import type { X402Handler } from '../src/x402-v2.js';
import type { Receipt, SignedPayment } from '../src/types.js';
import {
  makeEd25519Issuer,
  makeEddsaVc,
  paymentSubject,
} from './helpers/ap2-vc-fixtures.js';

const NOW = Date.parse('2026-06-10T12:00:00Z');

function mockHandler(): {
  handler: X402Handler;
  signPayment: ReturnType<typeof vi.fn>;
  submitPayment: ReturnType<typeof vi.fn>;
} {
  const receipt: Receipt = {
    receiptId: 'r1',
    status: 'confirmed',
    amount: '1000000',
    network: 'eip155:84532',
  };
  const signPayment = vi.fn(async (p: unknown) => p as SignedPayment);
  const submitPayment = vi.fn(async () => receipt);
  return {
    handler: { signPayment, submitPayment } as unknown as X402Handler,
    signPayment,
    submitPayment,
  };
}

describe('Ap2Adapter.settleVc', () => {
  it('settles a verified envelope and marks the receipt verified', async () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    const { handler, signPayment, submitPayment } = mockHandler();
    const adapter = new Ap2Adapter(handler);
    const receipt = await adapter.settleVc(vc, {
      verify: { trustedIssuers: [issuer.did] },
      nowMs: NOW,
    });
    expect(receipt.mandateVerification).toBe('verified');
    expect(signPayment).toHaveBeenCalledTimes(1);
    expect(submitPayment).toHaveBeenCalledTimes(1);
  });

  it('REFUSES before translation/signing when verification fails (AC2)', async () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    (vc.credentialSubject as Record<string, unknown>).amount = '999999999';
    const { handler, signPayment, submitPayment } = mockHandler();
    const adapter = new Ap2Adapter(handler);
    const err = await adapter
      .settleVc(vc, { verify: { trustedIssuers: [issuer.did] }, nowMs: NOW })
      .then(
        () => undefined,
        (e: unknown) => e as PayBotApiError,
      );
    expect(err).toBeInstanceOf(PayBotApiError);
    expect(err?.code).toBe('INVALID_AP2_MANDATE');
    expect(err?.details?.errorCode).toBe('AP2_SIGNATURE_INVALID');
    expect(signPayment).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  it('fails closed on an empty trust-anchor list (AC3) without signing', async () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    const { handler, signPayment } = mockHandler();
    const adapter = new Ap2Adapter(handler);
    await expect(
      adapter.settleVc(vc, { verify: { trustedIssuers: [] }, nowMs: NOW }),
    ).rejects.toMatchObject({
      code: 'INVALID_AP2_MANDATE',
      details: { errorCode: 'AP2_ISSUER_UNTRUSTED' },
    });
    expect(signPayment).not.toHaveBeenCalled();
  });

  it('rejects a second settlement of the same mandate (AC4 replay)', async () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    const { handler } = mockHandler();
    const adapter = new Ap2Adapter(handler);
    const store = new InMemoryReplayStore(() => NOW);
    const opts = {
      verify: { trustedIssuers: [issuer.did], replayStore: store },
      nowMs: NOW,
    };
    const first = await adapter.settleVc(vc, opts);
    expect(first.mandateVerification).toBe('verified');
    await expect(adapter.settleVc(vc, opts)).rejects.toMatchObject({
      code: 'INVALID_AP2_MANDATE',
      details: { errorCode: 'AP2_MANDATE_REPLAYED' },
    });
  });

  it('rejects same mandateId re-presented with a different hash (tamper)', async () => {
    const issuer = makeEd25519Issuer();
    const { handler } = mockHandler();
    const adapter = new Ap2Adapter(handler);
    const store = new InMemoryReplayStore(() => NOW);
    const opts = {
      verify: { trustedIssuers: [issuer.did], replayStore: store },
      nowMs: NOW,
    };
    await adapter.settleVc(makeEddsaVc(issuer), opts);
    // Same mandateId + cartHash, legitimately re-signed with another payer:
    // different envelope hash -> tamper signal.
    const variant = makeEddsaVc(
      issuer,
      paymentSubject({ payer: '0x3333333333333333333333333333333333333333' }),
    );
    const err = await adapter.settleVc(variant, opts).then(
      () => undefined,
      (e: unknown) => e as PayBotApiError,
    );
    expect(err?.details?.errorCode).toBe('AP2_MANDATE_REPLAYED');
    expect(String(err?.details?.errorDetail)).toContain(
      'id_reuse_hash_mismatch',
    );
  });

  it('marks the receipt not-performed when verification is explicitly skipped', async () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    const { handler } = mockHandler();
    const adapter = new Ap2Adapter(handler);
    const receipt = await adapter.settleVc(vc, {
      verify: { trustedIssuers: [] },
      requireVerifiedMandate: false,
      nowMs: NOW,
    });
    expect(receipt.mandateVerification).toBe('not-performed');
  });

  it('rejects a verified envelope whose subject is not a settleable slice', async () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer, {
      mandateId: 'intent_only_001',
      natural_language_description: 'not a payment slice',
    });
    const { handler, signPayment } = mockHandler();
    const adapter = new Ap2Adapter(handler);
    await expect(
      adapter.settleVc(vc, {
        verify: { trustedIssuers: [issuer.did] },
        nowMs: NOW,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_AP2_MANDATE' });
    expect(signPayment).not.toHaveBeenCalled();
  });
});

describe('Ap2Adapter.settle (legacy slice path)', () => {
  it('marks legacy receipts mandateVerification not-performed', async () => {
    const { handler } = mockHandler();
    const adapter = new Ap2Adapter(handler);
    const receipt = await adapter.settle({
      mandateId: 'm1',
      payer: '0x000000000000000000000000000000000000aaaa',
      payee: '0x000000000000000000000000000000000000bbbb',
      amount: '1000000',
      currency: 'USDC',
      network: 'eip155:8453',
    });
    expect(receipt.mandateVerification).toBe('not-performed');
  });

  it('can never produce a verified receipt (translation-only honesty)', async () => {
    const { handler } = mockHandler();
    const adapter = new Ap2Adapter(handler);
    const receipt = await adapter.settle({
      mandateId: 'm2',
      payer: '0x000000000000000000000000000000000000aaaa',
      payee: '0x000000000000000000000000000000000000bbbb',
      amount: '1',
      currency: 'USDC',
      network: 'eip155:8453',
      signature: 'opaque-unverified-vc-signature',
    });
    expect(receipt.mandateVerification).not.toBe('verified');
  });
});

describe('settleVc type surface', () => {
  it('exposes Ap2MandateVc-compatible envelopes from the public index', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.verifyMandate).toBe('function');
    expect(typeof mod.InMemoryReplayStore).toBe('function');
    expect(mod.AP2_VERIFY_ERROR_CODES).toContain('AP2_MANDATE_REPLAYED');
    const issuer = makeEd25519Issuer();
    const vc: Ap2MandateVc = makeEddsaVc(issuer);
    expect(mod.verifyMandate(vc, { trustedIssuers: [issuer.did] }, NOW).verified).toBe(
      true,
    );
  });
});
