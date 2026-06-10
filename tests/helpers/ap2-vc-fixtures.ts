/**
 * Test-vector builders for AP2 VC verification (story AK-1).
 *
 * IMPORTANT - HONESTY NOTE: all keys here are FRESHLY GENERATED TEST KEYS,
 * created per test run, never used outside tests. The SD-JWT shape mirrors
 * what the AP2 reference SDK (google-agentic-commerce/AP2 @ e1ea56d) emits
 * (ES256 issuer JWT, `_sd_alg: sha-256`, `delegate_payload: [body]` with a
 * disclose-all array disclosure), as read from its source. These are NOT
 * official AP2-issued credentials - see the AK-1 Dev Agent Record for the
 * documented AC6 interop gap.
 */

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  canonicalizeJcs,
  VC_V2_CONTEXT,
} from '../../src/ap2-vc.js';
import type {
  Ap2MandateVc,
  Ap2MandateType,
  DidDocument,
} from '../../src/ap2-vc.js';

const B58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode bytes as base58btc (test-side inverse of decodeBase58btc). */
export function encodeBase58btc(bytes: Buffer): string {
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) + BigInt(b);
  let out = '';
  while (acc > 0n) {
    out = B58_ALPHABET[Number(acc % 58n)] + out;
    acc /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** An Ed25519 test issuer with its did:key identity. */
export interface Ed25519TestIssuer {
  did: string;
  verificationMethodId: string;
  privateKey: KeyObject;
}

/** Generate a fresh Ed25519 test issuer (did:key). TEST KEY ONLY. */
export function makeEd25519Issuer(): Ed25519TestIssuer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const raw = Buffer.from(jwk.x, 'base64url');
  const multibase =
    'z' + encodeBase58btc(Buffer.concat([Buffer.from([0xed, 0x01]), raw]));
  const did = `did:key:${multibase}`;
  return {
    did,
    verificationMethodId: `${did}#${multibase}`,
    privateKey,
  };
}

/** A P-256 test issuer with a pinned did:web document. TEST KEY ONLY. */
export interface P256TestIssuer {
  did: string;
  kid: string;
  privateKey: KeyObject;
  didDocument: DidDocument;
}

/** Generate a fresh P-256 (ES256) test issuer with a did:web document. */
export function makeP256Issuer(
  did = 'did:web:issuer.ap2-test.invalid',
): P256TestIssuer {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const kid = `${did}#key-1`;
  return {
    did,
    kid,
    privateKey,
    didDocument: {
      id: did,
      verificationMethod: [
        { id: kid, type: 'JsonWebKey2020', controller: did, publicKeyJwk: jwk },
      ],
      assertionMethod: [kid],
    },
  };
}

function b64urlJsonEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Build a reference-SDK-shaped compact SD-JWT over `subject`:
 * issuer JWT (ES256) whose payload carries
 * `delegate_payload: [{'...': digest}]` plus a single disclose-all array
 * disclosure `[salt, subject]` - mirroring sd_jwt.create() output shape.
 */
export function makeReferenceSdJwt(
  subject: Record<string, unknown>,
  issuer: P256TestIssuer,
  options: { kid?: string | null; alg?: string; sdAlg?: string } = {},
): string {
  const disclosure = b64urlJsonEncode([
    randomBytes(16).toString('base64url'),
    subject,
  ]);
  const digest = sha256(disclosure).toString('base64url');
  const header: Record<string, unknown> = {
    alg: options.alg ?? 'ES256',
    typ: 'dc+sd-jwt',
  };
  if (options.kid !== null) header.kid = options.kid ?? issuer.kid;
  const payload: Record<string, unknown> = {
    _sd_alg: options.sdAlg ?? 'sha-256',
    delegate_payload: [{ '...': digest }],
  };
  const signingInput = `${b64urlJsonEncode(header)}.${b64urlJsonEncode(payload)}`;
  const sig = cryptoSign(
    'sha256',
    Buffer.from(signingInput, 'utf8'),
    { key: issuer.privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
  return `${signingInput}.${sig}~${disclosure}~`;
}

/** Build a plain (no-disclosure) ES256 compact JWS over `subject`. */
export function makePlainJws(
  subject: Record<string, unknown>,
  issuer: P256TestIssuer,
  options: { kid?: string | null; alg?: string } = {},
): string {
  const header: Record<string, unknown> = { alg: options.alg ?? 'ES256' };
  if (options.kid !== null) header.kid = options.kid ?? issuer.kid;
  const signingInput = `${b64urlJsonEncode(header)}.${b64urlJsonEncode(subject)}`;
  const sig = cryptoSign(
    'sha256',
    Buffer.from(signingInput, 'utf8'),
    { key: issuer.privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
  return `${signingInput}.${sig}`;
}

/** Default settleable credentialSubject (valid Ap2PaymentMandate slice). */
export function paymentSubject(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mandateId: 'mandate_test_001',
    payer: '0x1111111111111111111111111111111111111111',
    payee: '0x2222222222222222222222222222222222222222',
    amount: '1000000',
    currency: 'USDC',
    network: 'eip155:84532',
    cartHash: 'carthash_abc',
    ...overrides,
  };
}

/** Envelope skeleton without proof. */
export function envelopeSkeleton(
  issuerDid: string,
  subject: Record<string, unknown>,
  mandateType: Ap2MandateType = 'CartMandate',
  overrides: Partial<Ap2MandateVc> = {},
): Omit<Ap2MandateVc, 'proof'> {
  return {
    '@context': [VC_V2_CONTEXT],
    type: ['VerifiableCredential', mandateType],
    id: (subject.mandateId as string) ?? 'mandate_test_001',
    issuer: issuerDid,
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: '2027-01-01T00:00:00Z',
    credentialSubject: subject,
    ...overrides,
  };
}

/**
 * Sign a VC with the eddsa-jcs-2022 Data Integrity suite (W3C algorithm:
 * Ed25519 over sha256(JCS(proofConfig)) || sha256(JCS(unsecuredDoc))).
 */
export function signEddsaJcs2022(
  unsigned: Omit<Ap2MandateVc, 'proof'>,
  issuer: Ed25519TestIssuer,
  verificationMethod?: string,
): Ap2MandateVc {
  const proofConfig = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    verificationMethod: verificationMethod ?? issuer.verificationMethodId,
    proofPurpose: 'assertionMethod',
    '@context': unsigned['@context'],
  };
  const hashData = Buffer.concat([
    sha256(canonicalizeJcs(proofConfig)),
    sha256(canonicalizeJcs(unsigned)),
  ]);
  const sig = cryptoSign(null, hashData, issuer.privateKey);
  return {
    ...unsigned,
    proof: {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      verificationMethod: verificationMethod ?? issuer.verificationMethodId,
      proofPurpose: 'assertionMethod',
      proofValue: 'z' + encodeBase58btc(sig),
    },
  };
}

/** Build a complete, verifiable SD-JWT-proofed envelope. */
export function makeSdJwtVc(
  issuer: P256TestIssuer,
  subject: Record<string, unknown> = paymentSubject(),
  mandateType: Ap2MandateType = 'CartMandate',
  overrides: Partial<Ap2MandateVc> = {},
): Ap2MandateVc {
  return {
    ...envelopeSkeleton(issuer.did, subject, mandateType, overrides),
    proof: { type: 'SdJwtProof', token: makeReferenceSdJwt(subject, issuer) },
  };
}

/** Build a complete, verifiable eddsa-jcs-2022 envelope. */
export function makeEddsaVc(
  issuer: Ed25519TestIssuer,
  subject: Record<string, unknown> = paymentSubject(),
  mandateType: Ap2MandateType = 'CartMandate',
  overrides: Partial<Ap2MandateVc> = {},
): Ap2MandateVc {
  return signEddsaJcs2022(
    envelopeSkeleton(issuer.did, subject, mandateType, overrides),
    issuer,
  );
}
