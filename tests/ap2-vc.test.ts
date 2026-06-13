/**
 * Story AK-1 - AP2 VC verification pipeline tests.
 *
 * Test vectors are generated with FRESH TEST KEYS per run (see
 * helpers/ap2-vc-fixtures.ts). Negative paths dominate by design: forged
 * signature, wrong key, tampered fields, expired/not-yet-valid, untrusted
 * issuer, empty trust anchors, unknown suite, unresolvable DID, replay,
 * id-reuse-hash-mismatch, malformed envelope, null-byte/oversize input.
 */

import { describe, it, expect } from 'vitest';
import {
  verifyMandate,
  computeMandateHash,
  canonicalizeJcs,
  decodeBase58btc,
  resolveDidKey,
  resolveDidDocument,
  isTrustedIssuer,
  getMandateId,
  getCartHash,
  InMemoryReplayStore,
  VC_V2_CONTEXT,
  MAX_VC_DEPTH,
} from '../src/ap2-vc.js';
import type { Ap2MandateVc, Ap2VerifyOptions } from '../src/ap2-vc.js';
import {
  encodeBase58btc,
  makeEd25519Issuer,
  makeP256Issuer,
  makeReferenceSdJwt,
  makePlainJws,
  makeSdJwtVc,
  makeEddsaVc,
  paymentSubject,
  envelopeSkeleton,
  signEddsaJcs2022,
} from './helpers/ap2-vc-fixtures.js';

const NOW = Date.parse('2026-06-10T12:00:00Z');

function optsFor(
  issuerDid: string,
  extra: Partial<Ap2VerifyOptions> = {},
): Ap2VerifyOptions {
  return { trustedIssuers: [issuerDid], ...extra };
}

/* ------------------------------ canonicalizeJcs -------------------------- */

describe('canonicalizeJcs', () => {
  it('sorts object keys and nests deterministically', () => {
    expect(canonicalizeJcs({ b: 2, a: { d: [1, 'x'], c: true } })).toBe(
      '{"a":{"c":true,"d":[1,"x"]},"b":2}',
    );
  });

  it('omits undefined object properties and nullifies undefined in arrays', () => {
    expect(canonicalizeJcs({ a: undefined, b: [undefined, 1] })).toBe(
      '{"b":[null,1]}',
    );
  });

  it('throws on non-finite numbers', () => {
    expect(() => canonicalizeJcs({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalizeJcs(Infinity)).toThrow(/non-finite/);
  });

  it('throws on unsupported types', () => {
    expect(() => canonicalizeJcs({ f: () => 1 })).toThrow(/unsupported/);
  });
});

/* ------------------------------ computeMandateHash ----------------------- */

describe('computeMandateHash', () => {
  it('is independent of key insertion order', () => {
    expect(computeMandateHash({ a: 1, b: 2 })).toBe(
      computeMandateHash({ b: 2, a: 1 }),
    );
  });

  it('changes when any field changes', () => {
    expect(computeMandateHash({ amount: '1' })).not.toBe(
      computeMandateHash({ amount: '2' }),
    );
  });

  it('returns 64 lowercase hex chars', () => {
    expect(computeMandateHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ------------------------------ decodeBase58btc -------------------------- */

describe('decodeBase58btc', () => {
  it('round-trips with the test encoder', () => {
    const buf = Buffer.from([0xed, 0x01, 0, 7, 255, 42]);
    expect(decodeBase58btc(encodeBase58btc(buf))).toEqual(buf);
  });

  it('preserves leading zero bytes via leading 1s', () => {
    const buf = Buffer.from([0, 0, 1, 2]);
    const enc = encodeBase58btc(buf);
    expect(enc.startsWith('11')).toBe(true);
    expect(decodeBase58btc(enc)).toEqual(buf);
  });

  it('throws on characters outside the alphabet (0, O, I, l)', () => {
    expect(() => decodeBase58btc('0OIl')).toThrow(/invalid character/);
  });
});

/* ------------------------------ resolveDidKey ---------------------------- */

describe('resolveDidKey', () => {
  it('resolves a generated Ed25519 did:key into a usable document', () => {
    const issuer = makeEd25519Issuer();
    const doc = resolveDidKey(issuer.did);
    expect(doc.id).toBe(issuer.did);
    expect(doc.verificationMethod?.[0]?.id).toBe(issuer.verificationMethodId);
  });

  it('rejects non-multibase (no z prefix) DIDs', () => {
    expect(() => resolveDidKey('did:key:abc')).toThrow(/base58btc/);
  });

  it('rejects keys with a non-Ed25519 multicodec prefix', () => {
    const fake = 'z' + encodeBase58btc(
      Buffer.concat([Buffer.from([0x12, 0x00]), Buffer.alloc(32)]),
    );
    expect(() => resolveDidKey(`did:key:${fake}`)).toThrow(/Ed25519/);
  });

  it('rejects truncated key material', () => {
    const short = 'z' + encodeBase58btc(
      Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.alloc(16)]),
    );
    expect(() => resolveDidKey(`did:key:${short}`)).toThrow(/Ed25519/);
  });
});

/* ------------------------------ resolveDidDocument ----------------------- */

describe('resolveDidDocument', () => {
  it('prefers the pinned cache and validates its id', () => {
    const issuer = makeP256Issuer();
    const doc = resolveDidDocument(issuer.did, {
      trustedIssuers: [],
      didDocuments: { [issuer.did]: issuer.didDocument },
    });
    expect(doc).toBe(issuer.didDocument);
  });

  it('rejects a pinned document whose id mismatches the key', () => {
    const issuer = makeP256Issuer();
    const doc = resolveDidDocument('did:web:other.invalid', {
      trustedIssuers: [],
      didDocuments: { 'did:web:other.invalid': issuer.didDocument },
    });
    expect(doc).toBeUndefined();
  });

  it('falls back to did:key self-resolution', () => {
    const issuer = makeEd25519Issuer();
    expect(resolveDidDocument(issuer.did, { trustedIssuers: [] })?.id).toBe(
      issuer.did,
    );
  });

  it('NEVER resolves an unpinned did:web (no network, even when "allowed")', () => {
    expect(
      resolveDidDocument('did:web:attacker.example', {
        trustedIssuers: [],
        allowNetworkDidResolution: true,
      }),
    ).toBeUndefined();
  });
});

/* ------------------------------ isTrustedIssuer -------------------------- */

describe('isTrustedIssuer', () => {
  it('matches exact DIDs', () => {
    expect(isTrustedIssuer('did:key:zAbc', ['did:key:zAbc'])).toBe(true);
  });

  it('matches wildcard prefixes', () => {
    expect(isTrustedIssuer('did:web:a.example#x', ['did:web:a.example*'])).toBe(
      true,
    );
    expect(isTrustedIssuer('did:web:b.example', ['did:web:a.example*'])).toBe(
      false,
    );
  });

  it('trusts NOTHING on an empty or absent list (fail closed)', () => {
    expect(isTrustedIssuer('did:key:zAbc', [])).toBe(false);
    expect(isTrustedIssuer('did:key:zAbc', undefined)).toBe(false);
  });

  it('rejects a bare "*" wildcard (would trust everything)', () => {
    expect(isTrustedIssuer('did:key:zAbc', ['*'])).toBe(false);
  });

  it('ignores empty/non-string entries', () => {
    expect(isTrustedIssuer('did:key:zAbc', [''])).toBe(false);
  });
});

/* ------------------------------ id / cart extraction --------------------- */

describe('getMandateId / getCartHash', () => {
  it('prefers vc.id over subject ids', () => {
    const vc = { id: 'top', credentialSubject: { mandateId: 'sub' } };
    expect(getMandateId(vc as never)).toBe('top');
  });

  it('falls back through subject mandateId / id / payment_mandate_id', () => {
    expect(
      getMandateId({ credentialSubject: { mandateId: 'm1' } } as never),
    ).toBe('m1');
    expect(
      getMandateId({
        credentialSubject: { payment_mandate_id: 'pm1' },
      } as never),
    ).toBe('pm1');
  });

  it('returns undefined when no id is present', () => {
    expect(getMandateId({ credentialSubject: {} } as never)).toBeUndefined();
  });

  it('reads cartHash and cart_hash, else undefined', () => {
    expect(
      getCartHash({ credentialSubject: { cartHash: 'c1' } } as never),
    ).toBe('c1');
    expect(
      getCartHash({ credentialSubject: { cart_hash: 'c2' } } as never),
    ).toBe('c2');
    expect(getCartHash({ credentialSubject: {} } as never)).toBeUndefined();
  });
});

/* ------------------------------ InMemoryReplayStore ---------------------- */

describe('InMemoryReplayStore', () => {
  it('records and retrieves by (mandateId, cartHash)', () => {
    const store = new InMemoryReplayStore(() => 1000);
    store.record('m1', 'c1', 'hash1', 60_000);
    expect(store.get('m1', 'c1')).toBe('hash1');
    expect(store.get('m1', 'c2')).toBeUndefined();
    expect(store.anyForId('m1')).toBe(true);
  });

  it('expires entries after their TTL', () => {
    let now = 1000;
    const store = new InMemoryReplayStore(() => now);
    store.record('m1', 'c1', 'hash1', 500);
    now = 1501;
    expect(store.get('m1', 'c1')).toBeUndefined();
    expect(store.anyForId('m1')).toBe(false);
  });

  it('does not record non-positive TTLs', () => {
    const store = new InMemoryReplayStore(() => 1000);
    store.record('m1', 'c1', 'hash1', 0);
    expect(store.get('m1', 'c1')).toBeUndefined();
  });

  it('is collision-proof for ids containing separator-like characters', () => {
    const store = new InMemoryReplayStore(() => 1000);
    store.record('a","b', 'c', 'h1', 60_000);
    expect(store.get('a', '"b","c')).toBeUndefined();
  });
});

/* ------------------------------ verifyMandate: happy paths --------------- */

describe('verifyMandate - happy paths (AC1-analog, self-generated vectors)', () => {
  it('verifies an eddsa-jcs-2022 did:key Intent Mandate', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer, paymentSubject(), 'IntentMandate');
    const result = verifyMandate(vc, optsFor(issuer.did), NOW);
    expect(result.verified).toBe(true);
    expect(result.errorCode).toBeUndefined();
    expect(result.issuerDid).toBe(issuer.did);
    expect(result.mandateType).toBe('IntentMandate');
    expect(result.mandateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a reference-shaped SD-JWT (ES256) Cart Mandate via pinned did:web', () => {
    const issuer = makeP256Issuer();
    const vc = makeSdJwtVc(issuer);
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, {
        didDocuments: { [issuer.did]: issuer.didDocument },
      }),
      NOW,
    );
    expect(result.verified).toBe(true);
    expect(result.issuerDid).toBe(issuer.did);
    expect(result.mandateType).toBe('CartMandate');
  });

  it('verifies the plain compact-JWS degenerate case (zero disclosures)', () => {
    const issuer = makeP256Issuer();
    const subject = paymentSubject();
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: { type: 'SdJwtProof', token: makePlainJws(subject, issuer) },
    };
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, {
        didDocuments: { [issuer.did]: issuer.didDocument },
      }),
      NOW,
    );
    expect(result.verified).toBe(true);
  });

  it('verifies without kid by trying issuer-document keys (still issuer-bound)', () => {
    const issuer = makeP256Issuer();
    const subject = paymentSubject();
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: {
        type: 'SdJwtProof',
        token: makeReferenceSdJwt(subject, issuer, { kid: null }),
      },
    };
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, {
        didDocuments: { [issuer.did]: issuer.didDocument },
      }),
      NOW,
    );
    expect(result.verified).toBe(true);
  });
});

/* ------------------------------ AC2: tampered mandates ------------------- */

describe('verifyMandate - tampered mandates (AC2)', () => {
  const fields: Array<[string, unknown]> = [
    ['amount', '999000000'],
    ['payee', '0xattacker0000000000000000000000000000dead'],
    ['cartHash', 'carthash_swapped'],
  ];

  for (const [field, evil] of fields) {
    it(`rejects a mutated '${field}' with AP2_SIGNATURE_INVALID (SD-JWT)`, () => {
      const issuer = makeP256Issuer();
      const vc = makeSdJwtVc(issuer);
      (vc.credentialSubject as Record<string, unknown>)[field] = evil;
      const result = verifyMandate(
        vc,
        optsFor(issuer.did, {
          didDocuments: { [issuer.did]: issuer.didDocument },
        }),
        NOW,
      );
      expect(result.verified).toBe(false);
      expect(result.errorCode).toBe('AP2_SIGNATURE_INVALID');
    });
  }

  it('rejects a mutated subject with AP2_SIGNATURE_INVALID (eddsa-jcs-2022)', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    (vc.credentialSubject as Record<string, unknown>).amount = '2';
    const result = verifyMandate(vc, optsFor(issuer.did), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_SIGNATURE_INVALID');
  });

  it('rejects a tampered SD-JWT disclosure (payload swap inside the token)', () => {
    const issuer = makeP256Issuer();
    const subject = paymentSubject();
    const token = makeReferenceSdJwt(subject, issuer);
    const evilDisclosure = Buffer.from(
      JSON.stringify(['salt', { ...subject, amount: '999' }]),
      'utf8',
    ).toString('base64url');
    const [jwt] = token.split('~');
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, { ...subject, amount: '999' }),
      proof: { type: 'SdJwtProof', token: `${jwt}~${evilDisclosure}~` },
    };
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, {
        didDocuments: { [issuer.did]: issuer.didDocument },
      }),
      NOW,
    );
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_SIGNATURE_INVALID');
  });

  it('rejects a signature forged with the WRONG key', () => {
    const issuer = makeP256Issuer();
    const attacker = makeP256Issuer(issuer.did); // same DID, different key
    const subject = paymentSubject();
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: {
        type: 'SdJwtProof',
        token: makeReferenceSdJwt(subject, attacker),
      },
    };
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, {
        // The DID document pins the REAL issuer key.
        didDocuments: { [issuer.did]: issuer.didDocument },
      }),
      NOW,
    );
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_SIGNATURE_INVALID');
  });

  it('rejects a forged eddsa proof signed by a different did:key', () => {
    const issuer = makeEd25519Issuer();
    const attacker = makeEd25519Issuer();
    const unsigned = envelopeSkeleton(issuer.did, paymentSubject());
    // Attacker signs but points verificationMethod at the real issuer.
    const vc = signEddsaJcs2022(
      unsigned,
      attacker,
      issuer.verificationMethodId,
    );
    const result = verifyMandate(vc, optsFor(issuer.did), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_SIGNATURE_INVALID');
  });
});

/* ------------------------------ Step 1: envelope ------------------------- */

describe('verifyMandate - malformed envelopes (step 1)', () => {
  const issuer = makeEd25519Issuer();
  const base = () => makeEddsaVc(issuer);

  function expectEnvelopeInvalid(vc: unknown): void {
    const result = verifyMandate(vc as Ap2MandateVc, optsFor(issuer.did), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_ENVELOPE_INVALID');
  }

  it('rejects non-object inputs', () => {
    expectEnvelopeInvalid(null);
    expectEnvelopeInvalid('vc');
    expectEnvelopeInvalid([1, 2]);
  });

  it('rejects a wrong or missing @context[0]', () => {
    const vc = base();
    vc['@context'] = ['https://www.w3.org/2018/credentials/v1'];
    expectEnvelopeInvalid(vc);
  });

  it('rejects missing VerifiableCredential type', () => {
    const vc = base();
    vc.type = ['CartMandate'];
    expectEnvelopeInvalid(vc);
  });

  it('rejects zero or two mandate types', () => {
    const one = base();
    one.type = ['VerifiableCredential'];
    expectEnvelopeInvalid(one);
    const two = base();
    two.type = ['VerifiableCredential', 'CartMandate', 'IntentMandate'];
    expectEnvelopeInvalid(two);
  });

  it('rejects a missing issuer', () => {
    const vc = base();
    (vc as Record<string, unknown>).issuer = '';
    expectEnvelopeInvalid(vc);
  });

  it('rejects a missing validUntil (no eternal mandates)', () => {
    const vc = base();
    delete (vc as Record<string, unknown>).validUntil;
    expectEnvelopeInvalid(vc);
  });

  it('rejects a missing mandate id everywhere', () => {
    const issuer2 = makeEd25519Issuer();
    const subject = paymentSubject();
    delete subject.mandateId;
    const unsigned = envelopeSkeleton(issuer2.did, subject);
    delete (unsigned as Record<string, unknown>).id;
    const vc = signEddsaJcs2022(unsigned, issuer2);
    expectEnvelopeInvalid(vc);
  });

  it('rejects null bytes inside string values', () => {
    const vc = base();
    (vc.credentialSubject as Record<string, unknown>).payee =
      'abc' + String.fromCharCode(0) + 'def';
    expectEnvelopeInvalid(vc);
  });

  it('rejects pathologically deep JSON (DoS cap)', () => {
    const vc = base();
    let bomb: Record<string, unknown> = {};
    const root = bomb;
    for (let i = 0; i < MAX_VC_DEPTH + 4; i++) {
      const next: Record<string, unknown> = {};
      bomb.x = next;
      bomb = next;
    }
    (vc.credentialSubject as Record<string, unknown>).deep = root;
    expectEnvelopeInvalid(vc);
  });

  it('rejects oversize envelopes (DoS cap)', () => {
    const vc = base();
    (vc.credentialSubject as Record<string, unknown>).blob = 'x'.repeat(
      300_000,
    );
    expectEnvelopeInvalid(vc);
  });
});

/* ------------------------------ Step 2: proof suites --------------------- */

describe('verifyMandate - unsupported proof suites (step 2, AC3)', () => {
  const issuer = makeP256Issuer();
  const opts = () =>
    optsFor(issuer.did, { didDocuments: { [issuer.did]: issuer.didDocument } });

  function expectUnsupported(vc: Ap2MandateVc): void {
    const result = verifyMandate(vc, opts(), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_PROOF_SUITE_UNSUPPORTED');
  }

  it('rejects unknown proof types', () => {
    const vc = makeSdJwtVc(issuer);
    (vc.proof as Record<string, unknown>).type = 'RsaSignature2018';
    expectUnsupported(vc);
  });

  it('rejects non-pinned cryptosuites (e.g. ecdsa-rdfc-2019)', () => {
    const ed = makeEd25519Issuer();
    const vc = makeEddsaVc(ed);
    (vc.proof as Record<string, unknown>).cryptosuite = 'ecdsa-rdfc-2019';
    const result = verifyMandate(vc, optsFor(ed.did), NOW);
    expect(result.errorCode).toBe('AP2_PROOF_SUITE_UNSUPPORTED');
  });

  it('rejects alg "none" (algorithm-confusion hard stop)', () => {
    const subject = paymentSubject();
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
      'base64url',
    );
    const payload = Buffer.from(JSON.stringify(subject)).toString('base64url');
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: { type: 'SdJwtProof', token: `${header}.${payload}.x` },
    };
    expectUnsupported(vc);
  });

  it('rejects any alg other than ES256 (downgrade/confusion)', () => {
    const subject = paymentSubject();
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: {
        type: 'SdJwtProof',
        token: makeReferenceSdJwt(subject, issuer, { alg: 'ES384' }),
      },
    };
    expectUnsupported(vc);
  });

  it('rejects non-pinned _sd_alg values', () => {
    const subject = paymentSubject();
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: {
        type: 'SdJwtProof',
        token: makeReferenceSdJwt(subject, issuer, { sdAlg: 'sha-512' }),
      },
    };
    expectUnsupported(vc);
  });

  it('rejects key-binding JWTs and delegation chains (fail closed)', () => {
    const subject = paymentSubject();
    const token = makeReferenceSdJwt(subject, issuer);
    const kb: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: { type: 'SdJwtProof', token: `${token}h.p.s` },
    };
    expectUnsupported(kb);
    const chain: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: {
        type: 'SdJwtProof',
        token: `${token.slice(0, -1)}~~${token}`,
      },
    };
    expectUnsupported(chain);
  });
});

/* ------------------------------ Step 3: key resolution ------------------- */

describe('verifyMandate - key resolution failures (step 3)', () => {
  it('fails for an unpinned did:web issuer (offline, no SSRF)', () => {
    const issuer = makeP256Issuer();
    const vc = makeSdJwtVc(issuer);
    const result = verifyMandate(vc, optsFor(issuer.did), NOW); // no didDocuments
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_KEY_RESOLUTION_FAILED');
  });

  it('fails when verificationMethod points outside the issuer document (key confusion)', () => {
    const issuer = makeEd25519Issuer();
    const attacker = makeEd25519Issuer();
    const unsigned = envelopeSkeleton(issuer.did, paymentSubject());
    const vc = signEddsaJcs2022(unsigned, attacker, attacker.verificationMethodId);
    const result = verifyMandate(vc, optsFor(issuer.did), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_KEY_RESOLUTION_FAILED');
  });

  it('fails when the kid does not resolve within the issuer document', () => {
    const issuer = makeP256Issuer();
    const subject = paymentSubject();
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: {
        type: 'SdJwtProof',
        token: makeReferenceSdJwt(subject, issuer, {
          kid: 'did:web:other.invalid#key-9',
        }),
      },
    };
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, {
        didDocuments: { [issuer.did]: issuer.didDocument },
      }),
      NOW,
    );
    expect(result.errorCode).toBe('AP2_KEY_RESOLUTION_FAILED');
  });

  it('resolves a BARE reference kid against the DID verificationMethod fragment', () => {
    // The AP2 reference SD-JWT issuer emits an unqualified kid (e.g. the JWK
    // kid `key-1`), NOT the DID-fragment URI. The verifier must bind it to
    // the VM whose id fragment equals the bare kid - interop, not a
    // weakening (candidate keys still come only from the issuer's doc).
    const issuer = makeP256Issuer(); // VM id = `${did}#key-1`
    const subject = paymentSubject();
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: {
        type: 'SdJwtProof',
        token: makeReferenceSdJwt(subject, issuer, { kid: 'key-1' }),
      },
    };
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, {
        didDocuments: { [issuer.did]: issuer.didDocument },
      }),
      NOW,
    );
    expect(result.verified).toBe(true);
  });

  it('still fails a bare kid that matches no verificationMethod fragment', () => {
    const issuer = makeP256Issuer(); // only `key-1` exists
    const subject = paymentSubject();
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(issuer.did, subject),
      proof: {
        type: 'SdJwtProof',
        token: makeReferenceSdJwt(subject, issuer, { kid: 'key-999' }),
      },
    };
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, {
        didDocuments: { [issuer.did]: issuer.didDocument },
      }),
      NOW,
    );
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_KEY_RESOLUTION_FAILED');
  });

  it('fails when the issuer document has no usable key for the suite', () => {
    const ed = makeEd25519Issuer();
    const p256 = makeP256Issuer();
    // SD-JWT (needs P-256) but issuer doc only carries an Ed25519 key.
    const edDoc = resolveDidKey(ed.did);
    const subject = paymentSubject();
    const vc: Ap2MandateVc = {
      ...envelopeSkeleton(ed.did, subject),
      proof: {
        type: 'SdJwtProof',
        token: makeReferenceSdJwt(subject, p256, { kid: null }),
      },
    };
    const result = verifyMandate(
      vc,
      optsFor(ed.did, { didDocuments: { [ed.did]: edDoc } }),
      NOW,
    );
    expect(result.errorCode).toBe('AP2_KEY_RESOLUTION_FAILED');
  });
});

/* ------------------------------ Step 4: trust anchors (AC3) -------------- */

describe('verifyMandate - trust anchors (step 4, AC3)', () => {
  it('rejects a cryptographically VALID mandate when the trust list is empty', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    const result = verifyMandate(vc, { trustedIssuers: [] }, NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_ISSUER_UNTRUSTED');
  });

  it('rejects an issuer not on the list', () => {
    const issuer = makeEd25519Issuer();
    const other = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    const result = verifyMandate(vc, { trustedIssuers: [other.did] }, NOW);
    expect(result.errorCode).toBe('AP2_ISSUER_UNTRUSTED');
  });

  it('accepts issuer objects ({ id }) against the same anchors', () => {
    const issuer = makeEd25519Issuer();
    const subject = paymentSubject();
    const unsigned = envelopeSkeleton(issuer.did, subject, 'CartMandate', {
      issuer: { id: issuer.did },
    });
    const vc = signEddsaJcs2022(unsigned, issuer);
    const result = verifyMandate(vc, optsFor(issuer.did), NOW);
    expect(result.verified).toBe(true);
  });
});

/* ------------------------------ Step 6: temporal (AC3) ------------------- */

describe('verifyMandate - temporal validity (step 6, AC3)', () => {
  it('rejects an expired mandate with AP2_MANDATE_EXPIRED', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer, paymentSubject(), 'CartMandate', {
      validUntil: '2026-06-10T11:59:59Z', // 1s before NOW
    });
    const result = verifyMandate(vc, optsFor(issuer.did), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_MANDATE_EXPIRED');
  });

  it('accepts exactly at validUntil and rejects 1s after (boundary)', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer, paymentSubject(), 'CartMandate', {
      validUntil: '2026-06-10T12:00:00Z',
    });
    expect(verifyMandate(vc, optsFor(issuer.did), NOW).verified).toBe(true);
    expect(
      verifyMandate(vc, optsFor(issuer.did), NOW + 1000).errorCode,
    ).toBe('AP2_MANDATE_EXPIRED');
  });

  it('honors bounded clock skew (and caps it at MAX_CLOCK_SKEW_MS)', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer, paymentSubject(), 'CartMandate', {
      validUntil: '2026-06-10T12:00:00Z',
    });
    expect(
      verifyMandate(vc, optsFor(issuer.did, { clockSkewMs: 5000 }), NOW + 4000)
        .verified,
    ).toBe(true);
    expect(
      verifyMandate(
        vc,
        optsFor(issuer.did, { clockSkewMs: 10_000_000 }),
        NOW + 400_000,
      ).errorCode,
    ).toBe('AP2_MANDATE_EXPIRED');
  });

  it('rejects not-yet-valid mandates with AP2_MANDATE_NOT_YET_VALID', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer, paymentSubject(), 'CartMandate', {
      validFrom: '2026-06-10T13:00:00Z',
      validUntil: '2027-01-01T00:00:00Z',
    });
    const result = verifyMandate(vc, optsFor(issuer.did), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_MANDATE_NOT_YET_VALID');
  });
});

/* ------------------------------ Step 7: replay (AC4) --------------------- */

describe('verifyMandate - replay protection (step 7, AC4)', () => {
  it('rejects the same envelope presented twice with AP2_MANDATE_REPLAYED', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    const store = new InMemoryReplayStore(() => NOW);
    const opts = optsFor(issuer.did, { replayStore: store });
    const first = verifyMandate(vc, opts, NOW);
    expect(first.verified).toBe(true);
    store.record('mandate_test_001', 'carthash_abc', first.mandateHash, 60_000);
    const second = verifyMandate(vc, opts, NOW);
    expect(second.verified).toBe(false);
    expect(second.errorCode).toBe('AP2_MANDATE_REPLAYED');
  });

  it('flags same (mandateId, cartHash) with a DIFFERENT hash as tamper', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    const store = new InMemoryReplayStore(() => NOW);
    store.record('mandate_test_001', 'carthash_abc', 'a'.repeat(64), 60_000);
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, { replayStore: store }),
      NOW,
    );
    expect(result.errorCode).toBe('AP2_MANDATE_REPLAYED');
    expect(result.errorDetail).toContain('id_reuse_hash_mismatch');
  });

  it('rejects a non-Intent mandateId reused across different carts', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(
      issuer,
      paymentSubject({ cartHash: 'cart_B' }),
      'CartMandate',
    );
    const store = new InMemoryReplayStore(() => NOW);
    store.record('mandate_test_001', 'cart_A', 'b'.repeat(64), 60_000);
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, { replayStore: store }),
      NOW,
    );
    expect(result.errorCode).toBe('AP2_MANDATE_REPLAYED');
    expect(result.errorDetail).toContain('id_reuse_hash_mismatch');
  });

  it('allows an Intent Mandate to settle multiple different carts', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(
      issuer,
      paymentSubject({ cartHash: 'cart_B' }),
      'IntentMandate',
    );
    const store = new InMemoryReplayStore(() => NOW);
    store.record('mandate_test_001', 'cart_A', 'b'.repeat(64), 60_000);
    const result = verifyMandate(
      vc,
      optsFor(issuer.did, { replayStore: store }),
      NOW,
    );
    expect(result.verified).toBe(true);
  });

  it('skips replay checks when no store is configured (documented)', () => {
    const issuer = makeEd25519Issuer();
    const vc = makeEddsaVc(issuer);
    expect(verifyMandate(vc, optsFor(issuer.did), NOW).verified).toBe(true);
    expect(verifyMandate(vc, optsFor(issuer.did), NOW).verified).toBe(true);
  });
});

/* ------------------------------ Step 8: linkage -------------------------- */

describe('verifyMandate - cart-to-intent linkage (step 8)', () => {
  function makePair(merchants?: string[]) {
    const issuer = makeEd25519Issuer();
    const intentSubject: Record<string, unknown> = {
      mandateId: 'intent_001',
      natural_language_description: 'buy a cable',
      intent_expiry: '2027-01-01T00:00:00Z',
    };
    if (merchants) intentSubject.merchants = merchants;
    const intentVc = makeEddsaVc(issuer, intentSubject, 'IntentMandate', {
      id: 'intent_001',
    });
    const cartVc = makeEddsaVc(
      issuer,
      paymentSubject({ intentId: 'intent_001' }),
      'CartMandate',
    );
    return { issuer, intentVc, cartVc };
  }

  it('verifies a cart linked to its verified intent', () => {
    const { issuer, intentVc, cartVc } = makePair();
    const result = verifyMandate(
      cartVc,
      optsFor(issuer.did, { linkedIntentVc: intentVc }),
      NOW,
    );
    expect(result.verified).toBe(true);
  });

  it('rejects a cart whose intentId does not match the linked intent', () => {
    const { issuer, intentVc } = makePair();
    const cartVc = makeEddsaVc(
      issuer,
      paymentSubject({ intentId: 'intent_OTHER' }),
      'CartMandate',
    );
    const result = verifyMandate(
      cartVc,
      optsFor(issuer.did, { linkedIntentVc: intentVc }),
      NOW,
    );
    expect(result.errorCode).toBe('AP2_MANDATE_LINKAGE_INVALID');
  });

  it('rejects when the cart references an intent but none is supplied', () => {
    const { issuer, cartVc } = makePair();
    const result = verifyMandate(cartVc, optsFor(issuer.did), NOW);
    expect(result.errorCode).toBe('AP2_MANDATE_LINKAGE_INVALID');
  });

  it('rejects when the linked intent itself fails verification (expired)', () => {
    const issuer = makeEd25519Issuer();
    const intentVc = makeEddsaVc(
      issuer,
      { mandateId: 'intent_001' },
      'IntentMandate',
      { id: 'intent_001', validUntil: '2026-01-01T00:00:00Z' },
    );
    const cartVc = makeEddsaVc(
      issuer,
      paymentSubject({ intentId: 'intent_001' }),
      'CartMandate',
    );
    const result = verifyMandate(
      cartVc,
      optsFor(issuer.did, { linkedIntentVc: intentVc }),
      NOW,
    );
    expect(result.errorCode).toBe('AP2_MANDATE_LINKAGE_INVALID');
  });

  it('enforces the intent merchant allowlist against the cart payee', () => {
    const { issuer, intentVc, cartVc } = makePair(['merchant-allowed']);
    const blocked = verifyMandate(
      cartVc,
      optsFor(issuer.did, { linkedIntentVc: intentVc }),
      NOW,
    );
    expect(blocked.errorCode).toBe('AP2_MANDATE_LINKAGE_INVALID');

    const okCart = makeEddsaVc(
      issuer,
      paymentSubject({ intentId: 'intent_001', merchant: 'merchant-allowed' }),
      'CartMandate',
    );
    const ok = verifyMandate(
      okCart,
      optsFor(issuer.did, { linkedIntentVc: intentVc }),
      NOW,
    );
    expect(ok.verified).toBe(true);
  });
});
