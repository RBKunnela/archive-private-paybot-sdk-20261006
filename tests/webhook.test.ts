import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  verifyWebhookSignature,
  signWebhookPayload,
} from '../src/webhook.js';

const SECRET = 'whsec_test_secret_123';
const PAYLOAD = '{"event":"payment.completed","id":"evt_abc"}';

/** Current unix time in seconds (matches the implementation's clock). */
function now(): number {
  return Math.floor(Date.now() / 1000);
}

describe('signWebhookPayload', () => {
  it('[UNIT] should produce a t=<ts>,v1=<hex> header (happy path)', () => {
    const header = signWebhookPayload({
      payload: PAYLOAD,
      secret: SECRET,
      timestamp: 1700000000,
    });
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it('[UNIT] should default the timestamp to now when omitted', () => {
    const header = signWebhookPayload({ payload: PAYLOAD, secret: SECRET });
    const match = header.match(/^t=(\d+),v1=[0-9a-f]{64}$/);
    expect(match).not.toBeNull();
    const ts = Number(match![1]);
    expect(Math.abs(now() - ts)).toBeLessThanOrEqual(2);
  });

  it('[UNIT] should sign Buffer and string payloads identically (edge)', () => {
    const fromString = signWebhookPayload({
      payload: PAYLOAD,
      secret: SECRET,
      timestamp: 1700000000,
    });
    const fromBuffer = signWebhookPayload({
      payload: Buffer.from(PAYLOAD, 'utf8'),
      secret: SECRET,
      timestamp: 1700000000,
    });
    expect(fromBuffer).toBe(fromString);
  });
});

describe('verifyWebhookSignature', () => {
  it('[UNIT] should accept a valid, fresh signature (happy path)', () => {
    const signature = signWebhookPayload({ payload: PAYLOAD, secret: SECRET });
    expect(
      verifyWebhookSignature({ payload: PAYLOAD, signature, secret: SECRET })
    ).toBe(true);
  });

  it('[UNIT] should reject a tampered payload (error path)', () => {
    const signature = signWebhookPayload({ payload: PAYLOAD, secret: SECRET });
    const tampered = PAYLOAD.replace('evt_abc', 'evt_evil');
    expect(
      verifyWebhookSignature({ payload: tampered, signature, secret: SECRET })
    ).toBe(false);
  });

  it('[UNIT] should reject a wrong secret (error path)', () => {
    const signature = signWebhookPayload({ payload: PAYLOAD, secret: SECRET });
    expect(
      verifyWebhookSignature({
        payload: PAYLOAD,
        signature,
        secret: 'whsec_wrong_secret',
      })
    ).toBe(false);
  });

  it('[UNIT] should reject an expired timestamp outside tolerance (replay)', () => {
    const oldTs = now() - 301; // default tolerance is 300
    const signature = signWebhookPayload({
      payload: PAYLOAD,
      secret: SECRET,
      timestamp: oldTs,
    });
    expect(
      verifyWebhookSignature({ payload: PAYLOAD, signature, secret: SECRET })
    ).toBe(false);
  });

  it('[UNIT] should reject a future timestamp beyond tolerance (replay)', () => {
    const futureTs = now() + 301;
    const signature = signWebhookPayload({
      payload: PAYLOAD,
      secret: SECRET,
      timestamp: futureTs,
    });
    expect(
      verifyWebhookSignature({ payload: PAYLOAD, signature, secret: SECRET })
    ).toBe(false);
  });

  it('[UNIT] should honor a custom tolerance (edge)', () => {
    const ts = now() - 600;
    const signature = signWebhookPayload({
      payload: PAYLOAD,
      secret: SECRET,
      timestamp: ts,
    });
    // Outside the default 300 but inside an explicit 900.
    expect(
      verifyWebhookSignature({
        payload: PAYLOAD,
        signature,
        secret: SECRET,
        tolerance: 900,
      })
    ).toBe(true);
    // And rejected with a tighter tolerance.
    expect(
      verifyWebhookSignature({
        payload: PAYLOAD,
        signature,
        secret: SECRET,
        tolerance: 60,
      })
    ).toBe(false);
  });

  it('[UNIT] should verify a Buffer payload (edge)', () => {
    const signature = signWebhookPayload({
      payload: Buffer.from(PAYLOAD, 'utf8'),
      secret: SECRET,
    });
    expect(
      verifyWebhookSignature({
        payload: Buffer.from(PAYLOAD, 'utf8'),
        signature,
        secret: SECRET,
      })
    ).toBe(true);
  });

  it('[UNIT] should round-trip sign -> verify (happy path)', () => {
    const ts = now();
    const signature = signWebhookPayload({
      payload: PAYLOAD,
      secret: SECRET,
      timestamp: ts,
    });
    expect(signature).toBe(
      `t=${ts},v1=${createHmac('sha256', SECRET)
        .update(`${ts}.${PAYLOAD}`, 'utf8')
        .digest('hex')}`
    );
    expect(
      verifyWebhookSignature({ payload: PAYLOAD, signature, secret: SECRET })
    ).toBe(true);
  });

  describe('malformed input never throws and returns false', () => {
    const cases: Array<[string, string]> = [
      ['garbage string', 'not-a-valid-header'],
      ['empty string', ''],
      ['missing v1', `t=${now()}`],
      ['missing t', 'v1=abc123'],
      ['segment without =', `t=${now()},v1`],
      ['non-integer t', `t=abc,v1=${'0'.repeat(64)}`],
      ['decimal t', `t=170.5,v1=${'0'.repeat(64)}`],
      ['empty t value', `t=,v1=${'0'.repeat(64)}`],
    ];

    for (const [name, signature] of cases) {
      it(`[UNIT] should return false for ${name} (error path)`, () => {
        let result: boolean | undefined;
        expect(() => {
          result = verifyWebhookSignature({
            payload: PAYLOAD,
            signature,
            secret: SECRET,
          });
        }).not.toThrow();
        expect(result).toBe(false);
      });
    }
  });

  it('[UNIT] should return false on v1 length mismatch (timingSafeEqual guard)', () => {
    // A well-formed, fresh header whose v1 is a short hex — length differs from
    // the 64-char expected digest, exercising the length-mismatch guard before
    // timingSafeEqual (which would otherwise throw).
    const ts = now();
    const signature = `t=${ts},v1=deadbeef`;
    let result: boolean | undefined;
    expect(() => {
      result = verifyWebhookSignature({
        payload: PAYLOAD,
        signature,
        secret: SECRET,
      });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('[UNIT] should reject a same-length but wrong v1 (constant-time path)', () => {
    const ts = now();
    // 64 hex chars, correct length, wrong value — forces timingSafeEqual to run
    // and return false rather than short-circuiting on length.
    const signature = `t=${ts},v1=${'a'.repeat(64)}`;
    expect(
      verifyWebhookSignature({ payload: PAYLOAD, signature, secret: SECRET })
    ).toBe(false);
  });

  it('[CROSS-LANG] should match the Python hmac.hexdigest byte-for-byte', () => {
    // Fixed vector. The expected hex below is what Python produces via:
    //   hmac.new(b"whsec_test_secret_123",
    //            b"1700000000." + payload, sha256).hexdigest()
    // and what Node produces via createHmac — verified identical at authoring.
    const t = 1700000000;
    const expectedHex =
      '12be6cc21d50311763619d575af23a49aaf9f15616827041822d1fa69af47adb';
    const header = signWebhookPayload({
      payload: PAYLOAD,
      secret: SECRET,
      timestamp: t,
    });
    expect(header).toBe(`t=${t},v1=${expectedHex}`);

    // And the verifier accepts that exact cross-language header (with ample
    // tolerance since the fixed timestamp is far in the past).
    expect(
      verifyWebhookSignature({
        payload: PAYLOAD,
        signature: `t=${t},v1=${expectedHex}`,
        secret: SECRET,
        tolerance: Number.MAX_SAFE_INTEGER,
      })
    ).toBe(true);
  });
});
