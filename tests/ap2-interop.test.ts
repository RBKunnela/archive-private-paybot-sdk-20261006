/**
 * Story AK-1 - AC1 + AC6: interop against the OFFICIAL AP2 reference toolchain.
 *
 * Unlike ap2-vc.test.ts (fresh per-run test keys), these vectors are the
 * fixtures under tests/fixtures/ap2/, minted by the official
 * google-agentic-commerce/AP2 reference SD-JWT issuer
 * (ap2.sdk.sdjwt.sd_jwt.create, ES256) over the genuine ap2.models
 * IntentMandate / CartMandate bodies. See tests/fixtures/ap2/PROVENANCE.md.
 *
 * AC1  - a real reference Intent + Cart mandate, with the sample issuer in
 *        trustedIssuers, verifies (verified:true) with issuer DID + hash.
 * AC2  - tampering each of three fields on the real cart fails closed with
 *        AP2_SIGNATURE_INVALID before any settlement.
 * AC3  - empty trust list, wrong issuer, and expiry fail closed on the real
 *        fixtures with their distinct codes.
 *
 * AC6 (round-trip against a FRESHLY produced reference mandate) is gated in
 * .github/workflows/ap2-interop.yml: that job regenerates the fixtures with
 * the reference SDK in CI and runs this same suite. Locally / in the default
 * suite we verify the CHECKED-IN reference-minted fixtures (the strongest
 * always-available evidence); the freshly-minted round-trip is the CI job.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { verifyMandate } from '../src/ap2-vc.js';
import type {
  Ap2MandateVc,
  Ap2VerifyOptions,
  DidDocument,
} from '../src/ap2-vc.js';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'ap2',
);

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as T;
}

interface FixtureMeta {
  issuerDid: string;
  kid: string;
  referenceCommit: string;
  proofSuite: string;
}

const meta = loadJson<FixtureMeta>('meta.json');
const issuerDoc = loadJson<DidDocument>('issuer-did-document.json');
const intentVc = loadJson<Ap2MandateVc>('intent-mandate.vc.json');
const cartVc = loadJson<Ap2MandateVc>('cart-mandate.vc.json');

/** A time inside both fixtures' validity window. */
const NOW = Date.parse('2026-06-13T00:00:00Z');

function trustedOpts(extra: Partial<Ap2VerifyOptions> = {}): Ap2VerifyOptions {
  return {
    trustedIssuers: [meta.issuerDid],
    didDocuments: { [meta.issuerDid]: issuerDoc },
    ...extra,
  };
}

/* ----------------------------- fixture sanity ---------------------------- */

describe('[INTEROP] AP2 reference fixtures - provenance pins', () => {
  it('pins the reference commit and the sd-jwt-es256 suite', () => {
    expect(meta.referenceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.proofSuite).toBe('sd-jwt-es256');
  });

  it('carries the official SD-JWT enveloping proof, not our DataIntegrity proof', () => {
    expect(intentVc.proof.type).toBe('SdJwtProof');
    expect(cartVc.proof.type).toBe('SdJwtProof');
  });

  it('issuer DID document publishes a P-256 key bound to the issuer DID', () => {
    expect(issuerDoc.id).toBe(meta.issuerDid);
    const jwk = issuerDoc.verificationMethod?.[0]?.publicKeyJwk as
      | Record<string, unknown>
      | undefined;
    expect(jwk?.kty).toBe('EC');
    expect(jwk?.crv).toBe('P-256');
  });
});

/* --------------------------------- AC1 ----------------------------------- */

describe('[INTEROP] AC1 - verify a real reference Mandate', () => {
  it('verifies the official Intent Mandate with the sample issuer trusted', () => {
    const result = verifyMandate(intentVc, trustedOpts(), NOW);
    expect(result.verified).toBe(true);
    expect(result.errorCode).toBeUndefined();
    expect(result.issuerDid).toBe(meta.issuerDid);
    expect(result.mandateType).toBe('IntentMandate');
    expect(result.mandateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies the official Cart Mandate with the sample issuer trusted', () => {
    const result = verifyMandate(cartVc, trustedOpts(), NOW);
    expect(result.verified).toBe(true);
    expect(result.issuerDid).toBe(meta.issuerDid);
    expect(result.mandateType).toBe('CartMandate');
  });

  it('resolves the bare reference kid against the DID-fragment VM (interop binding)', () => {
    // The reference SD-JWT issuer emits a bare `kid` (issuer-key-1); the DID
    // doc publishes it as `<did>#issuer-key-1`. Regression guard for the
    // AK-1 kid-namespace fix: verification must still succeed.
    const result = verifyMandate(intentVc, trustedOpts(), NOW);
    expect(result.verified).toBe(true);
  });
});

/* --------------------------------- AC2 ----------------------------------- */

describe('[INTEROP] AC2 - tampered real Cart Mandate fails closed', () => {
  function tamper(mutate: (vc: Ap2MandateVc) => void): Ap2MandateVc {
    const clone = JSON.parse(JSON.stringify(cartVc)) as Ap2MandateVc;
    mutate(clone);
    return clone;
  }

  it('rejects a mutated merchant_name with AP2_SIGNATURE_INVALID', () => {
    const vc = tamper((c) => {
      const contents = c.credentialSubject.contents as Record<string, unknown>;
      contents.merchant_name = 'Evil Merchant';
    });
    const result = verifyMandate(vc, trustedOpts(), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_SIGNATURE_INVALID');
  });

  it('rejects a mutated total amount with AP2_SIGNATURE_INVALID', () => {
    const vc = tamper((c) => {
      const contents = c.credentialSubject.contents as Record<string, unknown>;
      const pr = contents.payment_request as Record<string, unknown>;
      const details = pr.details as Record<string, unknown>;
      const total = details.total as Record<string, unknown>;
      (total.amount as Record<string, unknown>).value = 1;
    });
    const result = verifyMandate(vc, trustedOpts(), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_SIGNATURE_INVALID');
  });

  it('rejects a mutated cart id (payee/identity surface) with AP2_SIGNATURE_INVALID', () => {
    const vc = tamper((c) => {
      const contents = c.credentialSubject.contents as Record<string, unknown>;
      contents.id = 'cart_attacker_swap';
    });
    const result = verifyMandate(vc, trustedOpts(), NOW);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_SIGNATURE_INVALID');
  });
});

/* --------------------------------- AC3 ----------------------------------- */

describe('[INTEROP] AC3 - real fixtures fail closed on policy violations', () => {
  it('rejects a cryptographically valid mandate when the trust list is empty', () => {
    const result = verifyMandate(
      intentVc,
      { trustedIssuers: [], didDocuments: { [meta.issuerDid]: issuerDoc } },
      NOW,
    );
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_ISSUER_UNTRUSTED');
  });

  it('rejects when the issuer is not on the trust-anchor list', () => {
    const result = verifyMandate(
      intentVc,
      {
        trustedIssuers: ['did:web:someone-else.example'],
        didDocuments: { [meta.issuerDid]: issuerDoc },
      },
      NOW,
    );
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_ISSUER_UNTRUSTED');
  });

  it('rejects when the issuer DID document is not pinned (offline key resolution fails)', () => {
    const result = verifyMandate(
      intentVc,
      { trustedIssuers: [meta.issuerDid] },
      NOW,
    );
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_KEY_RESOLUTION_FAILED');
  });

  it('rejects the real mandate once past validUntil', () => {
    const past = Date.parse('2027-06-01T00:00:00Z');
    const result = verifyMandate(intentVc, trustedOpts(), past);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_MANDATE_EXPIRED');
  });

  it('rejects the real mandate before validFrom', () => {
    const early = Date.parse('2025-06-01T00:00:00Z');
    const result = verifyMandate(intentVc, trustedOpts(), early);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe('AP2_MANDATE_NOT_YET_VALID');
  });
});
