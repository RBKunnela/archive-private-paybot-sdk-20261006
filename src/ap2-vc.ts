/**
 * @module ap2-vc
 *
 * AP2 Verifiable-Credential mandate envelope + fail-closed verification.
 *
 * ## Spec pin (T1, AK-1 - recorded 2026-06-10, fixtures vendored 2026-06-13)
 *
 * Conformance target: the `google-agentic-commerce/AP2` reference repo at
 * commit `e1ea56db72a6385bce3e5c1112b3a56ce60acb43` (2026-04-29). Official
 * Intent + Cart mandate fixtures minted by that commit's reference SD-JWT
 * issuer are vendored under `tests/fixtures/ap2/` (see PROVENANCE.md) and
 * verified by `tests/ap2-interop.test.ts` (AC1/AC6). At that
 * commit the reference SDK signs mandates as **SD-JWT compact tokens**
 * (RFC 9901 lineage, `sd_jwt` Python library) whose issuer JWT is signed
 * with **ES256** (ECDSA P-256 + SHA-256; see
 * `code/sdk/python/ap2/sdk/jwt_helper.py`), with `_sd_alg: sha-256` and the
 * mandate body wrapped as `delegate_payload: [<claims>]`
 * (`code/sdk/python/ap2/sdk/sdjwt/sd_jwt.py`). The reference SDK does NOT
 * emit W3C Data Integrity embedded proofs.
 *
 * Pinned proof-suite list (closed - anything else fails with
 * `AP2_PROOF_SUITE_UNSUPPORTED`):
 *
 * 1. `'sd-jwt-es256'` - enveloping proof: the reference SDK's compact SD-JWT
 *    (issuer JWT alg MUST be exactly `ES256`; `_sd_alg` MUST be `sha-256`;
 *    a plain 3-part compact JWS is accepted as the zero-disclosure
 *    degenerate case). Key-binding JWTs and `~~` delegation chains are NOT
 *    yet supported and fail closed.
 * 2. `'eddsa-jcs-2022'` - W3C VC Data Integrity embedded proof (Ed25519 over
 *    RFC 8785 JCS canonicalization), the offline-first `did:key` path.
 *
 * ## Trust boundary
 *
 * `verifyMandate()` IS an authenticity check: envelope shape, pinned suite,
 * offline DID/key resolution, operator trust anchors (empty list = nothing
 * trusted), cryptographic signature over the canonicalized payload, temporal
 * validity, replay, and cart-to-intent linkage - in that order, failing
 * closed at the first failure with a distinct machine error code. The legacy
 * `Ap2PaymentMandate` slice in `./ap2` remains translation-only and can
 * never yield `verified: true`.
 *
 * DID resolution is offline-only: `did:key` (self-contained) and `did:web`
 * via the operator-provisioned {@link Ap2VerifyOptions.didDocuments} pinned
 * cache. No network fetch ever happens at verify time (SSRF hardening);
 * {@link Ap2VerifyOptions.allowNetworkDidResolution} is reserved and
 * currently NOT honored - see Dev Notes in the AK-1 PR.
 *
 * Dependencies: node:crypto only (Ed25519/P-256 verify, SHA-256).
 * Used by: Ap2Adapter.settleVc (./ap2) and direct SDK callers.
 */

import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/* ------------------------------ Error codes ------------------------------ */

/**
 * Machine-readable error codes returned by {@link verifyMandate}, one per
 * pipeline step. Fail-closed: any unverifiable input maps to exactly one of
 * these - there is no "unknown but accepted" state.
 */
export const AP2_VERIFY_ERROR_CODES = [
  'AP2_ENVELOPE_INVALID',
  'AP2_PROOF_SUITE_UNSUPPORTED',
  'AP2_KEY_RESOLUTION_FAILED',
  'AP2_ISSUER_UNTRUSTED',
  'AP2_SIGNATURE_INVALID',
  'AP2_MANDATE_EXPIRED',
  'AP2_MANDATE_NOT_YET_VALID',
  'AP2_MANDATE_REPLAYED',
  'AP2_MANDATE_LINKAGE_INVALID',
] as const;

/** Union of all {@link verifyMandate} error codes. */
export type Ap2VerifyErrorCode = (typeof AP2_VERIFY_ERROR_CODES)[number];

/* ------------------------------ Envelope types --------------------------- */

/** W3C VC 2.0 base context required as the first `@context` entry. */
export const VC_V2_CONTEXT = 'https://www.w3.org/ns/credentials/v2';

/** Mandate credential types accepted in the envelope `type` array. */
export const AP2_MANDATE_TYPES = [
  'IntentMandate',
  'CartMandate',
  'PaymentMandate',
] as const;

/** Union of accepted AP2 mandate credential types. */
export type Ap2MandateType = (typeof AP2_MANDATE_TYPES)[number];

/**
 * W3C Data Integrity embedded proof (pinned cryptosuite `eddsa-jcs-2022`).
 * `proofValue` is the multibase base58btc (`z`-prefixed) Ed25519 signature.
 */
export interface Ap2DataIntegrityProof {
  type: 'DataIntegrityProof';
  /** Pinned: only `'eddsa-jcs-2022'` is accepted. */
  cryptosuite: string;
  /** Key reference; MUST resolve within the issuer's DID document. */
  verificationMethod: string;
  /** MUST be `'assertionMethod'`. */
  proofPurpose: string;
  /** Multibase base58btc Ed25519 signature (64 bytes when decoded). */
  proofValue: string;
  /** Optional creation timestamp (informational; not trusted). */
  created?: string;
}

/**
 * Enveloping proof carrying an AP2 reference-SDK compact SD-JWT (or plain
 * compact JWS) whose issuer JWT is ES256-signed. The disclosure-resolved
 * payload MUST canonically equal the envelope's `credentialSubject`.
 */
export interface Ap2SdJwtProof {
  type: 'SdJwtProof';
  /** Compact SD-JWT (`<jws>~<disclosure>~...~`) or bare compact JWS. */
  token: string;
}

/** Discriminated union of the pinned proof representations. */
export type Ap2Proof = Ap2DataIntegrityProof | Ap2SdJwtProof;

/**
 * Full AP2 mandate Verifiable-Credential envelope (W3C VC 2.0 shape).
 *
 * This is the only shape that can ever verify; the legacy
 * `Ap2PaymentMandate` settlement slice is translation-only.
 */
export interface Ap2MandateVc {
  /** JSON-LD contexts; `[0]` MUST be {@link VC_V2_CONTEXT}. */
  '@context': string[];
  /** MUST include `'VerifiableCredential'` and exactly one mandate type. */
  type: string[];
  /** Credential / mandate id (used as the replay `mandateId` when present). */
  id?: string;
  /** Issuer DID (string) or object with an `id` DID. */
  issuer: string | { id: string };
  /** ISO-8601 start of validity (optional). */
  validFrom?: string;
  /** ISO-8601 end of validity (REQUIRED - fail-closed, no eternal mandates). */
  validUntil?: string;
  /** The mandate body (settlement slice, cart contents, intent, ...). */
  credentialSubject: Record<string, unknown>;
  /** Pinned-suite proof. */
  proof: Ap2Proof;
}

/* ------------------------------ DID / options ---------------------------- */

/** A verification method inside a {@link DidDocument}. */
export interface DidVerificationMethod {
  /** Fully-qualified id, e.g. `did:web:issuer.example#key-1`. */
  id: string;
  /** Method type (informational; key material decides usability). */
  type?: string;
  /** Controller DID. */
  controller?: string;
  /** JWK form of the public key (P-256 `EC` or Ed25519 `OKP`). */
  publicKeyJwk?: Record<string, unknown>;
  /** Multibase base58btc multicodec public key (Ed25519: `z6Mk...`). */
  publicKeyMultibase?: string;
}

/** Minimal DID document model for the pinned offline cache. */
export interface DidDocument {
  /** The DID this document describes. */
  id: string;
  /** Available verification methods. */
  verificationMethod?: DidVerificationMethod[];
  /** Methods usable for assertions (ids or embedded methods). */
  assertionMethod?: (string | DidVerificationMethod)[];
}

/**
 * Pluggable replay-protection store keyed by `(mandateId, cartHash)`.
 *
 * The SDK ships {@link InMemoryReplayStore} (per-process only -
 * single-process honesty; a multi-instance deployment MUST plug a shared
 * store, and paybot core remains the authoritative replay layer on its
 * settle path).
 */
export interface ReplayStore {
  /** Recorded mandateHash for `(mandateId, cartHash)`, if any (unexpired). */
  get(mandateId: string, cartHash: string | undefined): string | undefined;
  /** Whether ANY unexpired record exists for `mandateId` (any cartHash). */
  anyForId(mandateId: string): boolean;
  /** Record a settlement of `(mandateId, cartHash)` with its envelope hash. */
  record(
    mandateId: string,
    cartHash: string | undefined,
    mandateHash: string,
    ttlMs: number,
  ): void;
}

/** Operator-supplied verification options. */
export interface Ap2VerifyOptions {
  /**
   * Trust-anchor allowlist: exact DIDs, or prefixes ending in `*`
   * (e.g. `did:web:issuer.example*`). EMPTY OR ABSENT MEANS NO ISSUER IS
   * TRUSTED - every verification fails with `AP2_ISSUER_UNTRUSTED`.
   * Never hard-code anchors into the SDK (open-core rule).
   */
  trustedIssuers: string[];
  /** Pinned offline DID-document cache keyed by DID (required for did:web). */
  didDocuments?: Record<string, DidDocument>;
  /**
   * Reserved. Network DID resolution is NOT implemented; setting `true`
   * does not enable fetching - resolution still fails closed offline.
   * Kept so operators can grep for the SSRF-relevant switch.
   */
  allowNetworkDidResolution?: boolean;
  /** Replay store consulted at step 7 (skipped when absent). */
  replayStore?: ReplayStore;
  /** Bounded clock-skew tolerance in ms (default 0, max 300 000). */
  clockSkewMs?: number;
  /**
   * Verified-linkage input for step 8: the Intent Mandate envelope a Cart
   * Mandate claims to fulfil (`credentialSubject.intentId`).
   */
  linkedIntentVc?: Ap2MandateVc;
}

/** Result of {@link verifyMandate}. */
export interface Ap2VerifyResult {
  /** `true` only when ALL eight pipeline steps passed. */
  verified: boolean;
  /** First-failure machine code when `verified` is `false`. */
  errorCode?: Ap2VerifyErrorCode;
  /** Human-readable detail of the first failure. */
  errorDetail?: string;
  /** Resolved issuer DID (present from step 3 onward). */
  issuerDid?: string;
  /** `sha256(JCS(vc))` hex - stable replay/audit reference. */
  mandateHash: string;
  /** The envelope's mandate type (when the envelope parsed far enough). */
  mandateType?: Ap2MandateType;
}

/* ------------------------------ Constants -------------------------------- */

/** Maximum serialized envelope size in bytes (DoS cap). */
export const MAX_VC_BYTES = 262_144;
/** Maximum JSON nesting depth (DoS cap). */
export const MAX_VC_DEPTH = 24;
/** Maximum accepted clock-skew tolerance (ms). */
export const MAX_CLOCK_SKEW_MS = 300_000;
/** Pinned Data Integrity cryptosuite. */
const PINNED_CRYPTOSUITE = 'eddsa-jcs-2022';
/** Pinned JOSE alg for SD-JWT issuer JWTs. */
const PINNED_JWS_ALG = 'ES256';
/** Pinned SD-JWT disclosure-hash algorithm. */
const PINNED_SD_ALG = 'sha-256';
/** The 6-char JCS escape of a raw U+0000 inside a JSON string. */
const NUL_ESCAPED = String.fromCharCode(0x5c) + 'u0000';

/* --------------------- Canonicalization (RFC 8785) ----------------------- */

/**
 * Serialize a JSON value per RFC 8785 (JSON Canonicalization Scheme).
 *
 * Object keys sort by UTF-16 code units; numbers serialize per ECMA-262
 * (which RFC 8785 adopts); `undefined` object properties are omitted.
 *
 * @param value - Any JSON-representable value.
 * @returns The canonical JSON string.
 * @throws {Error} on non-finite numbers, bigints, functions, or symbols.
 *
 * @example
 *   canonicalizeJcs({ b: 2, a: 1 }); // '{"a":1,"b":2}'
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('JCS: cannot canonicalize non-finite number');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`JCS: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((v) => (v === undefined ? 'null' : canonicalizeJcs(v)))
      .join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const v = record[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalizeJcs(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** SHA-256 of a UTF-8 string or buffer, returned as a Buffer. */
function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * Compute the stable mandate hash: `sha256(JCS(vc))` as lowercase hex.
 *
 * This is the replay-key component and the only mandate-derived value that
 * should ever enter audit logs (hashes only, never the mandate body).
 *
 * @param vc - Any JSON-representable envelope (need not be valid).
 * @returns 64-char lowercase hex digest.
 */
export function computeMandateHash(vc: unknown): string {
  return sha256(canonicalizeJcs(vc)).toString('hex');
}

/* ------------------------- base58btc / base64url ------------------------- */

const B58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map<string, number>(
  [...B58_ALPHABET].map((c, i) => [c, i]),
);

/**
 * Decode a base58btc string (no multibase prefix) to bytes.
 *
 * @param input - base58btc text.
 * @returns Decoded bytes.
 * @throws {Error} on characters outside the base58btc alphabet.
 */
export function decodeBase58btc(input: string): Buffer {
  let acc = 0n;
  for (const ch of input) {
    const digit = B58_MAP.get(ch);
    if (digit === undefined) {
      throw new Error(`base58btc: invalid character '${ch}'`);
    }
    acc = acc * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (acc > 0n) {
    bytes.unshift(Number(acc & 0xffn));
    acc >>= 8n;
  }
  for (const ch of input) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function b64urlDecode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new Error('base64url: invalid character');
  }
  return Buffer.from(segment, 'base64url');
}

function b64urlJson(segment: string): unknown {
  const text = b64urlDecode(segment).toString('utf8');
  return JSON.parse(text);
}

/* ----------------------- DID resolution (offline) ------------------------ */

/** Multicodec prefix for raw Ed25519 public keys (0xed 0x01). */
const MULTICODEC_ED25519_PUB = [0xed, 0x01];

/**
 * Resolve a `did:key` Ed25519 DID into a synthesized {@link DidDocument}.
 *
 * Only the Ed25519 multicodec (`z6Mk...`) is supported - other key types
 * fail (operators pin non-Ed25519 issuers via `did:web` documents instead).
 *
 * @param did - A `did:key:z...` DID.
 * @returns The synthesized DID document.
 * @throws {Error} when the DID is not a supported Ed25519 did:key.
 */
export function resolveDidKey(did: string): DidDocument {
  if (!did.startsWith('did:key:z')) {
    throw new Error('did:key: only multibase base58btc (z...) is supported');
  }
  const suffix = did.slice('did:key:'.length);
  const decoded = decodeBase58btc(suffix.slice(1));
  if (
    decoded.length !== 34 ||
    decoded[0] !== MULTICODEC_ED25519_PUB[0] ||
    decoded[1] !== MULTICODEC_ED25519_PUB[1]
  ) {
    throw new Error('did:key: not an Ed25519 public key (0xed01 multicodec)');
  }
  const vmId = `${did}#${suffix}`;
  return {
    id: did,
    verificationMethod: [
      {
        id: vmId,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: suffix,
      },
    ],
    assertionMethod: [vmId],
  };
}

/**
 * Resolve an issuer DID into a DID document using OFFLINE sources only:
 * `did:key` (self-contained) or the pinned
 * {@link Ap2VerifyOptions.didDocuments} cache (any DID method, required for
 * `did:web`). Never touches the network.
 *
 * @param did - The issuer DID.
 * @param opts - Verify options carrying the pinned cache.
 * @returns The resolved document, or `undefined` when unresolvable.
 */
export function resolveDidDocument(
  did: string,
  opts: Ap2VerifyOptions,
): DidDocument | undefined {
  const pinned = opts.didDocuments?.[did];
  if (pinned) {
    return pinned.id === did ? pinned : undefined;
  }
  if (did.startsWith('did:key:')) {
    try {
      return resolveDidKey(did);
    } catch {
      return undefined;
    }
  }
  // No network fallback by design (SSRF hardening). allowNetworkDidResolution
  // is reserved and intentionally NOT honored in this version.
  return undefined;
}

function keyObjectFromMethod(
  method: DidVerificationMethod,
): KeyObject | undefined {
  try {
    if (method.publicKeyMultibase) {
      if (!method.publicKeyMultibase.startsWith('z')) return undefined;
      const decoded = decodeBase58btc(method.publicKeyMultibase.slice(1));
      if (
        decoded.length !== 34 ||
        decoded[0] !== MULTICODEC_ED25519_PUB[0] ||
        decoded[1] !== MULTICODEC_ED25519_PUB[1]
      ) {
        return undefined;
      }
      return createPublicKey({
        key: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: decoded.subarray(2).toString('base64url'),
        },
        format: 'jwk',
      });
    }
    if (method.publicKeyJwk) {
      return createPublicKey({
        key: method.publicKeyJwk as never,
        format: 'jwk',
      });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function methodsOf(doc: DidDocument): DidVerificationMethod[] {
  const out: DidVerificationMethod[] = [...(doc.verificationMethod ?? [])];
  for (const am of doc.assertionMethod ?? []) {
    if (typeof am === 'object') out.push(am);
  }
  return out;
}

/* ----------------------------- Trust anchors ----------------------------- */

/**
 * Check an issuer DID against the operator trust-anchor list.
 *
 * Entries match exactly, or as a prefix when they end with `*`.
 * An empty/absent list trusts NOTHING (fail closed).
 *
 * @param issuerDid - Resolved issuer DID.
 * @param trustedIssuers - Operator allowlist.
 * @returns `true` only when a non-empty list contains a match.
 */
export function isTrustedIssuer(
  issuerDid: string,
  trustedIssuers: string[] | undefined,
): boolean {
  if (!trustedIssuers || trustedIssuers.length === 0) return false;
  return trustedIssuers.some((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) return false;
    if (entry.endsWith('*')) {
      const prefix = entry.slice(0, -1);
      return prefix.length > 0 && issuerDid.startsWith(prefix);
    }
    return issuerDid === entry;
  });
}

/* ------------------------- In-memory replay store ------------------------ */

/**
 * Per-process {@link ReplayStore}. HONESTY NOTE: state lives in this process
 * only - restarts forget it and replicas do not share it. Production
 * deployments settle through paybot core, whose settle path is the
 * authoritative replay layer; this store is defense-in-depth for direct SDK
 * use.
 */
export class InMemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<
    string,
    { mandateHash: string; expiresAtMs: number }
  >();
  private readonly byId = new Map<string, Set<string>>();
  private readonly now: () => number;

  /** @param now - Injectable clock (epoch ms) for deterministic tests. */
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private static key(mandateId: string, cartHash: string | undefined): string {
    // JSON array form is collision-proof even when ids contain separators.
    return JSON.stringify([mandateId, cartHash ?? null]);
  }

  private prune(mandateId: string): void {
    const keys = this.byId.get(mandateId);
    if (!keys) return;
    for (const k of keys) {
      const e = this.entries.get(k);
      if (!e || e.expiresAtMs <= this.now()) {
        this.entries.delete(k);
        keys.delete(k);
      }
    }
    if (keys.size === 0) this.byId.delete(mandateId);
  }

  /** @inheritdoc */
  get(mandateId: string, cartHash: string | undefined): string | undefined {
    this.prune(mandateId);
    return this.entries.get(InMemoryReplayStore.key(mandateId, cartHash))
      ?.mandateHash;
  }

  /** @inheritdoc */
  anyForId(mandateId: string): boolean {
    this.prune(mandateId);
    return (this.byId.get(mandateId)?.size ?? 0) > 0;
  }

  /** @inheritdoc */
  record(
    mandateId: string,
    cartHash: string | undefined,
    mandateHash: string,
    ttlMs: number,
  ): void {
    if (ttlMs <= 0) return;
    const k = InMemoryReplayStore.key(mandateId, cartHash);
    this.entries.set(k, { mandateHash, expiresAtMs: this.now() + ttlMs });
    let keys = this.byId.get(mandateId);
    if (!keys) {
      keys = new Set();
      this.byId.set(mandateId, keys);
    }
    keys.add(k);
  }
}

/* -------------------------- Envelope validation -------------------------- */

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > MAX_VC_DEPTH) return depth;
  if (value === null || typeof value !== 'object') return depth;
  let max = depth;
  const children = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    const d = jsonDepth(child, depth + 1);
    if (d > max) max = d;
    if (max > MAX_VC_DEPTH) break;
  }
  return max;
}

/** Extract the issuer DID string from the envelope's `issuer` field. */
function issuerDidOf(vc: Ap2MandateVc): string | undefined {
  if (typeof vc.issuer === 'string') return vc.issuer || undefined;
  if (vc.issuer && typeof vc.issuer === 'object') {
    const id = (vc.issuer as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  }
  return undefined;
}

/**
 * Extract the replay `mandateId` from an envelope: `vc.id`, else the
 * subject's `mandateId` / `id` / `payment_mandate_id` (first non-empty).
 *
 * @param vc - The envelope (untrusted; may be partial).
 * @returns The mandate id, or `undefined` when none is present.
 */
export function getMandateId(vc: Ap2MandateVc): string | undefined {
  if (typeof vc.id === 'string' && vc.id.length > 0) return vc.id;
  const subject = vc.credentialSubject as
    | Record<string, unknown>
    | undefined;
  for (const k of ['mandateId', 'id', 'payment_mandate_id']) {
    const v = subject?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Extract the cart hash from an envelope's subject (`cartHash` /
 * `cart_hash`), when present - the second component of the replay key.
 *
 * @param vc - The envelope (untrusted; may be partial).
 * @returns The cart hash, or `undefined` when none is present.
 */
export function getCartHash(vc: Ap2MandateVc): string | undefined {
  const subject = vc.credentialSubject as
    | Record<string, unknown>
    | undefined;
  for (const k of ['cartHash', 'cart_hash']) {
    const v = subject?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function envelopeError(vc: unknown): string | undefined {
  if (typeof vc !== 'object' || vc === null || Array.isArray(vc)) {
    return 'envelope must be a JSON object';
  }
  let serialized: string;
  try {
    serialized = canonicalizeJcs(vc);
  } catch (e) {
    return `envelope is not canonicalizable: ${(e as Error).message}`;
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VC_BYTES) {
    return `envelope exceeds ${MAX_VC_BYTES} bytes`;
  }
  // JCS escapes a raw U+0000 in any string value as the literal backslash-u0000.
  if (serialized.includes(NUL_ESCAPED)) {
    return 'envelope contains a null byte';
  }
  if (jsonDepth(vc) > MAX_VC_DEPTH) {
    return `envelope exceeds depth ${MAX_VC_DEPTH}`;
  }
  const v = vc as Partial<Ap2MandateVc>;
  const ctx = v['@context'];
  if (!Array.isArray(ctx) || ctx[0] !== VC_V2_CONTEXT) {
    return `@context[0] must be ${VC_V2_CONTEXT}`;
  }
  if (!Array.isArray(v.type) || !v.type.includes('VerifiableCredential')) {
    return 'type must include VerifiableCredential';
  }
  const mandateTypes = v.type.filter((t) =>
    (AP2_MANDATE_TYPES as readonly string[]).includes(t),
  );
  if (mandateTypes.length !== 1) {
    return 'type must include exactly one of IntentMandate/CartMandate/PaymentMandate';
  }
  if (!issuerDidOf(v as Ap2MandateVc)) {
    return 'issuer DID is missing';
  }
  if (
    typeof v.credentialSubject !== 'object' ||
    v.credentialSubject === null ||
    Array.isArray(v.credentialSubject)
  ) {
    return 'credentialSubject must be an object';
  }
  if (!getMandateId(v as Ap2MandateVc)) {
    return 'no mandate id (vc.id or credentialSubject.mandateId) present';
  }
  if (
    typeof v.validUntil !== 'string' ||
    Number.isNaN(Date.parse(v.validUntil))
  ) {
    return 'validUntil is required and must be ISO-8601 (no eternal mandates)';
  }
  if (v.validFrom !== undefined && Number.isNaN(Date.parse(v.validFrom))) {
    return 'validFrom must be ISO-8601 when present';
  }
  if (typeof v.proof !== 'object' || v.proof === null) {
    return 'proof is missing';
  }
  return undefined;
}

/* --------------------------- Proof suite checks -------------------------- */

type SuiteCheck =
  | { suite: 'eddsa-jcs-2022'; proof: Ap2DataIntegrityProof }
  | {
      suite: 'sd-jwt-es256';
      proof: Ap2SdJwtProof;
      issuerJwt: string;
      header: Record<string, unknown>;
      payload: Record<string, unknown>;
      disclosures: string[];
    }
  | { error: string };

function checkProofSuite(proof: Ap2Proof): SuiteCheck {
  if (proof.type === 'DataIntegrityProof') {
    if (proof.cryptosuite !== PINNED_CRYPTOSUITE) {
      return {
        error: `cryptosuite '${String(proof.cryptosuite)}' is not pinned (${PINNED_CRYPTOSUITE})`,
      };
    }
    if (proof.proofPurpose !== 'assertionMethod') {
      return { error: 'proofPurpose must be assertionMethod' };
    }
    if (
      typeof proof.verificationMethod !== 'string' ||
      typeof proof.proofValue !== 'string'
    ) {
      return {
        error: 'DataIntegrityProof missing verificationMethod/proofValue',
      };
    }
    return { suite: 'eddsa-jcs-2022', proof };
  }
  if (proof.type === 'SdJwtProof') {
    if (typeof proof.token !== 'string' || proof.token.length === 0) {
      return { error: 'SdJwtProof missing token' };
    }
    if (proof.token.includes('~~')) {
      return { error: 'SD-JWT delegation chains are not supported' };
    }
    let issuerJwt: string;
    let disclosures: string[];
    if (proof.token.includes('~')) {
      if (!proof.token.endsWith('~')) {
        return { error: 'key-binding JWTs are not supported' };
      }
      const parts = proof.token.split('~');
      issuerJwt = parts[0];
      disclosures = parts.slice(1, -1);
      if (disclosures.some((d) => d.length === 0)) {
        return { error: 'malformed SD-JWT: empty disclosure segment' };
      }
    } else {
      issuerJwt = proof.token;
      disclosures = [];
    }
    const jwtParts = issuerJwt.split('.');
    if (jwtParts.length !== 3 || jwtParts.some((p) => p.length === 0)) {
      return { error: 'issuer JWT must be header.payload.signature' };
    }
    let header: unknown;
    let payload: unknown;
    try {
      header = b64urlJson(jwtParts[0]);
      payload = b64urlJson(jwtParts[1]);
    } catch (e) {
      return { error: `cannot parse issuer JWT: ${(e as Error).message}` };
    }
    if (
      typeof header !== 'object' ||
      header === null ||
      typeof payload !== 'object' ||
      payload === null
    ) {
      return { error: 'issuer JWT header/payload must be JSON objects' };
    }
    const h = header as Record<string, unknown>;
    if (h.alg !== PINNED_JWS_ALG) {
      return {
        error: `alg '${String(h.alg)}' is not pinned (${PINNED_JWS_ALG})`,
      };
    }
    if (h.crit !== undefined) {
      return { error: 'crit header parameters are not supported' };
    }
    const p = payload as Record<string, unknown>;
    if (p._sd_alg !== undefined && p._sd_alg !== PINNED_SD_ALG) {
      return {
        error: `_sd_alg '${String(p._sd_alg)}' is not pinned (${PINNED_SD_ALG})`,
      };
    }
    return {
      suite: 'sd-jwt-es256',
      proof,
      issuerJwt,
      header: h,
      payload: p,
      disclosures,
    };
  }
  return {
    error: `proof type '${String((proof as { type?: unknown }).type)}' is not pinned`,
  };
}

/* ----------------------- Signature verification -------------------------- */

function verifyEddsaJcs2022(
  vc: Ap2MandateVc,
  proof: Ap2DataIntegrityProof,
  key: KeyObject,
): { ok: boolean; detail?: string } {
  let sig: Buffer;
  try {
    if (!proof.proofValue.startsWith('z')) {
      return {
        ok: false,
        detail: 'proofValue must be multibase base58btc (z...)',
      };
    }
    sig = decodeBase58btc(proof.proofValue.slice(1));
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  if (sig.length !== 64) {
    return { ok: false, detail: 'Ed25519 signature must be 64 bytes' };
  }
  const unsecured: Record<string, unknown> = { ...vc };
  delete unsecured.proof;
  const proofConfig: Record<string, unknown> = { ...proof };
  delete proofConfig.proofValue;
  proofConfig['@context'] = vc['@context'];
  let hashData: Buffer;
  try {
    hashData = Buffer.concat([
      sha256(canonicalizeJcs(proofConfig)),
      sha256(canonicalizeJcs(unsecured)),
    ]);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  const ok = cryptoVerify(null, hashData, key, sig);
  return ok ? { ok } : { ok: false, detail: 'Ed25519 signature mismatch' };
}

/**
 * Resolve SD-JWT disclosures into the payload (RFC 9901 semantics, pinned
 * `sha-256`). Fails on unmatched/duplicate disclosures (tamper signals).
 */
function resolveSdJwtPayload(
  payload: Record<string, unknown>,
  disclosures: string[],
): { resolved?: Record<string, unknown>; detail?: string } {
  const byDigest = new Map<string, { raw: string; decoded: unknown[] }>();
  for (const d of disclosures) {
    let decoded: unknown;
    try {
      decoded = b64urlJson(d);
    } catch {
      return { detail: 'disclosure is not base64url JSON' };
    }
    if (!Array.isArray(decoded) || decoded.length < 2 || decoded.length > 3) {
      return { detail: 'disclosure must be a 2- or 3-element array' };
    }
    const digest = sha256(d).toString('base64url');
    if (byDigest.has(digest)) {
      return { detail: 'duplicate disclosure' };
    }
    byDigest.set(digest, { raw: d, decoded });
  }
  const used = new Set<string>();

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const el of node) {
        if (
          el !== null &&
          typeof el === 'object' &&
          !Array.isArray(el) &&
          Object.keys(el as object).length === 1 &&
          typeof (el as Record<string, unknown>)['...'] === 'string'
        ) {
          const digest = (el as Record<string, unknown>)['...'] as string;
          const entry = byDigest.get(digest);
          if (entry) {
            if (entry.decoded.length !== 2) {
              throw new Error('array disclosure must have 2 elements');
            }
            used.add(digest);
            out.push(walk(entry.decoded[1]));
          }
          // Undisclosed array element: omitted.
          continue;
        }
        out.push(walk(el));
      }
      return out;
    }
    if (node !== null && typeof node === 'object') {
      const src = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) {
        if (k === '_sd' || k === '_sd_alg') continue;
        out[k] = walk(v);
      }
      const sd = src._sd;
      if (sd !== undefined) {
        if (!Array.isArray(sd) || sd.some((x) => typeof x !== 'string')) {
          throw new Error('_sd must be an array of digest strings');
        }
        for (const digest of sd as string[]) {
          const entry = byDigest.get(digest);
          if (!entry) continue; // Undisclosed (or decoy) - omitted.
          if (entry.decoded.length !== 3) {
            throw new Error('object disclosure must have 3 elements');
          }
          const name = entry.decoded[1];
          if (typeof name !== 'string') {
            throw new Error('disclosure claim name must be a string');
          }
          if (name in out) {
            throw new Error(`duplicate claim '${name}' via disclosure`);
          }
          used.add(digest);
          out[name] = walk(entry.decoded[2]);
        }
      }
      return out;
    }
    return node;
  }

  let resolved: Record<string, unknown>;
  try {
    resolved = walk(payload) as Record<string, unknown>;
  } catch (e) {
    return { detail: (e as Error).message };
  }
  if (used.size !== byDigest.size) {
    return {
      detail: 'disclosure does not match any _sd digest (tamper signal)',
    };
  }
  return { resolved };
}

function verifySdJwtEs256(
  vc: Ap2MandateVc,
  check: Extract<SuiteCheck, { suite: 'sd-jwt-es256' }>,
  keys: KeyObject[],
): { ok: boolean; detail?: string } {
  const [headerB64, payloadB64, sigB64] = check.issuerJwt.split('.');
  let sig: Buffer;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return { ok: false, detail: 'signature is not base64url' };
  }
  if (sig.length !== 64) {
    return { ok: false, detail: 'ES256 signature must be 64 bytes (r||s)' };
  }
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const verifiedByAnyKey = keys.some((key) => {
    try {
      return cryptoVerify(
        'sha256',
        signingInput,
        { key, dsaEncoding: 'ieee-p1363' },
        sig,
      );
    } catch {
      return false;
    }
  });
  if (!verifiedByAnyKey) {
    return { ok: false, detail: 'ES256 signature mismatch' };
  }
  const { resolved, detail } = resolveSdJwtPayload(
    check.payload,
    check.disclosures,
  );
  if (!resolved) {
    return { ok: false, detail };
  }
  // Effective subject: the reference SDK wraps claims as
  // delegate_payload: [body].
  let effective: unknown = resolved;
  const dp = resolved.delegate_payload;
  if (Array.isArray(dp)) {
    const dicts = dp.filter(
      (x) => x !== null && typeof x === 'object' && !Array.isArray(x),
    );
    if (dicts.length !== 1) {
      return {
        ok: false,
        detail: `delegate_payload has ${dicts.length} disclosed items, expected exactly 1`,
      };
    }
    effective = dicts[0];
  }
  // Envelope-to-proof binding: the signed payload must canonically equal the
  // envelope's credentialSubject. Any mutation of either side lands here.
  if (canonicalizeJcs(effective) !== canonicalizeJcs(vc.credentialSubject)) {
    return {
      ok: false,
      detail: 'credentialSubject does not match the signed SD-JWT payload',
    };
  }
  return { ok: true };
}

/* --------------------------- The 8-step pipeline ------------------------- */

function fail(
  code: Ap2VerifyErrorCode,
  detail: string,
  mandateHash: string,
  issuerDid?: string,
  mandateType?: Ap2MandateType,
): Ap2VerifyResult {
  return {
    verified: false,
    errorCode: code,
    errorDetail: detail,
    mandateHash,
    issuerDid,
    mandateType,
  };
}

/**
 * Verify an AP2 mandate VC envelope - the fail-closed, ordered 8-step
 * pipeline of story AK-1 (stops at the first failure, each step with a
 * distinct machine code):
 *
 * 1. Envelope shape, size/depth caps, pinned `@context`/`type`
 *    -> `AP2_ENVELOPE_INVALID`
 * 2. Pinned proof-suite membership (see module docs)
 *    -> `AP2_PROOF_SUITE_UNSUPPORTED`
 * 3. Offline issuer DID/key resolution -> `AP2_KEY_RESOLUTION_FAILED`
 * 4. Operator trust anchors (empty list trusts nothing)
 *    -> `AP2_ISSUER_UNTRUSTED`
 * 5. Cryptographic proof over the canonicalized payload
 *    -> `AP2_SIGNATURE_INVALID`
 * 6. Temporal validity (injectable clock, bounded skew)
 *    -> `AP2_MANDATE_EXPIRED` / `AP2_MANDATE_NOT_YET_VALID`
 * 7. Replay check keyed `(mandateId, cartHash)` -> `AP2_MANDATE_REPLAYED`
 * 8. Cart-to-Intent linkage when both supplied
 *    -> `AP2_MANDATE_LINKAGE_INVALID`
 *
 * Never throws on bad input - every unverifiable envelope returns
 * `{ verified: false, errorCode }`. Read-only: recording into the replay
 * store happens at settlement time (Ap2Adapter.settleVc), not here.
 *
 * @param vc - The candidate envelope (untrusted input).
 * @param opts - Operator trust anchors, pinned DID documents, replay store.
 * @param nowMs - Current epoch ms (injectable for deterministic tests).
 * @returns The verification result with the stable `mandateHash`.
 *
 * @example
 *   const result = verifyMandate(vc, {
 *     trustedIssuers: ['did:key:z6Mk...'],
 *     replayStore: new InMemoryReplayStore(),
 *   });
 *   if (!result.verified) console.error(result.errorCode);
 */
export function verifyMandate(
  vc: Ap2MandateVc,
  opts: Ap2VerifyOptions,
  nowMs: number = Date.now(),
): Ap2VerifyResult {
  let mandateHash = '';
  try {
    mandateHash = computeMandateHash(vc);
  } catch {
    mandateHash = '';
  }

  // Step 1 - envelope shape (+ DoS caps, null bytes).
  const envErr = envelopeError(vc);
  if (envErr) {
    return fail('AP2_ENVELOPE_INVALID', envErr, mandateHash);
  }
  const mandateType = vc.type.find((t) =>
    (AP2_MANDATE_TYPES as readonly string[]).includes(t),
  ) as Ap2MandateType;
  const issuerDid = issuerDidOf(vc) as string;

  // Step 2 - pinned proof-suite membership.
  const suite = checkProofSuite(vc.proof);
  if ('error' in suite) {
    return fail(
      'AP2_PROOF_SUITE_UNSUPPORTED',
      suite.error,
      mandateHash,
      issuerDid,
      mandateType,
    );
  }

  // Step 3 - offline DID/key resolution (no network, ever).
  const doc = resolveDidDocument(issuerDid, opts);
  if (!doc) {
    return fail(
      'AP2_KEY_RESOLUTION_FAILED',
      `issuer DID '${issuerDid}' did not resolve offline (did:key or pinned didDocuments)`,
      mandateHash,
      issuerDid,
      mandateType,
    );
  }
  // Key-to-proof binding: keys MUST come from the issuer's own document.
  let keys: KeyObject[] = [];
  if (suite.suite === 'eddsa-jcs-2022') {
    const vmId = suite.proof.verificationMethod;
    if (vmId !== doc.id && !vmId.startsWith(`${doc.id}#`)) {
      return fail(
        'AP2_KEY_RESOLUTION_FAILED',
        'verificationMethod does not resolve within the issuer DID document (cross-issuer key confusion)',
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
    const method = methodsOf(doc).find((m) => m.id === vmId);
    const key = method ? keyObjectFromMethod(method) : undefined;
    if (!key || key.asymmetricKeyType !== 'ed25519') {
      return fail(
        'AP2_KEY_RESOLUTION_FAILED',
        `verificationMethod '${vmId}' is absent or carries no usable Ed25519 key`,
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
    keys = [key];
  } else {
    const kid = suite.header.kid;
    let candidates = methodsOf(doc);
    if (typeof kid === 'string' && kid.length > 0) {
      // The JOSE `kid` and a DID verificationMethod `id` live in different
      // namespaces. The AP2 reference SD-JWT issuer
      // (ap2.sdk.sdjwt.common.header_parameters) propagates the issuer JWK's
      // BARE `kid` (e.g. `issuer-key-1`) into the SD-JWT header - NOT the
      // DID-fragment-qualified VM id (`did:web:...#issuer-key-1`). Accept the
      // conventional bindings: an exact VM id, the VM-id fragment, or
      // `<issuerDid>#<kid>`. All candidates already come from this issuer's
      // own DID document (methodsOf(doc)), so widening the kid match here does
      // NOT permit cross-issuer key confusion - it only tolerates the
      // namespace gap the official fixtures revealed (AK-1 T1/AC1 finding).
      const fragmentOf = (id: string): string => {
        const hash = id.indexOf('#');
        return hash >= 0 ? id.slice(hash + 1) : id;
      };
      const qualified = `${doc.id}#${kid}`;
      candidates = candidates.filter(
        (m) => m.id === kid || m.id === qualified || fragmentOf(m.id) === kid,
      );
      if (candidates.length === 0) {
        return fail(
          'AP2_KEY_RESOLUTION_FAILED',
          `kid '${kid}' does not resolve within the issuer DID document`,
          mandateHash,
          issuerDid,
          mandateType,
        );
      }
    }
    keys = candidates
      .map((m) => keyObjectFromMethod(m))
      .filter((k): k is KeyObject => k !== undefined)
      // ES256 needs P-256 EC keys; Ed25519 keys cannot verify this suite.
      .filter((k) => k.asymmetricKeyType === 'ec');
    if (keys.length === 0) {
      return fail(
        'AP2_KEY_RESOLUTION_FAILED',
        'issuer DID document carries no usable P-256 key for ES256',
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
  }

  // Step 4 - operator trust anchors (empty list = nothing trusted).
  if (!isTrustedIssuer(issuerDid, opts.trustedIssuers)) {
    return fail(
      'AP2_ISSUER_UNTRUSTED',
      opts.trustedIssuers?.length
        ? `issuer '${issuerDid}' is not in the trust-anchor list`
        : 'trust-anchor list is empty - no issuer is trusted (fail closed)',
      mandateHash,
      issuerDid,
      mandateType,
    );
  }

  // Step 5 - cryptographic proof over canonicalized payload.
  const sigResult =
    suite.suite === 'eddsa-jcs-2022'
      ? verifyEddsaJcs2022(vc, suite.proof, keys[0])
      : verifySdJwtEs256(vc, suite, keys);
  if (!sigResult.ok) {
    return fail(
      'AP2_SIGNATURE_INVALID',
      sigResult.detail ?? 'signature verification failed',
      mandateHash,
      issuerDid,
      mandateType,
    );
  }

  // Step 6 - temporal validity (injectable clock, bounded skew).
  const skew = Math.min(Math.max(opts.clockSkewMs ?? 0, 0), MAX_CLOCK_SKEW_MS);
  const validUntilMs = Date.parse(vc.validUntil as string);
  if (nowMs > validUntilMs + skew) {
    return fail(
      'AP2_MANDATE_EXPIRED',
      `validUntil ${vc.validUntil} has passed`,
      mandateHash,
      issuerDid,
      mandateType,
    );
  }
  if (vc.validFrom !== undefined) {
    const validFromMs = Date.parse(vc.validFrom);
    if (nowMs < validFromMs - skew) {
      return fail(
        'AP2_MANDATE_NOT_YET_VALID',
        `validFrom ${vc.validFrom} is in the future`,
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
  }

  // Step 7 - replay protection keyed (mandateId, cartHash).
  if (opts.replayStore) {
    const mandateId = getMandateId(vc) as string;
    const cartHash = getCartHash(vc);
    const recorded = opts.replayStore.get(mandateId, cartHash);
    if (recorded === mandateHash) {
      return fail(
        'AP2_MANDATE_REPLAYED',
        `mandate (${mandateId}) already settled for this cart`,
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
    if (recorded !== undefined) {
      return fail(
        'AP2_MANDATE_REPLAYED',
        'id_reuse_hash_mismatch: same (mandateId, cartHash) re-presented with a different envelope hash (tamper signal)',
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
    // Same mandateId under a DIFFERENT cart: only Intent Mandates may
    // authorize multiple cart settlements.
    if (
      opts.replayStore.anyForId(mandateId) &&
      mandateType !== 'IntentMandate'
    ) {
      return fail(
        'AP2_MANDATE_REPLAYED',
        'id_reuse_hash_mismatch: non-Intent mandateId reused across different carts (tamper signal)',
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
  }

  // Step 8 - Cart-to-Intent linkage when both supplied.
  const subject = vc.credentialSubject as Record<string, unknown>;
  const intentId =
    typeof subject.intentId === 'string' && subject.intentId.length > 0
      ? subject.intentId
      : undefined;
  if (mandateType === 'CartMandate' && (intentId || opts.linkedIntentVc)) {
    if (!opts.linkedIntentVc || !intentId) {
      return fail(
        'AP2_MANDATE_LINKAGE_INVALID',
        intentId
          ? 'cart references an intent but no linkedIntentVc was supplied'
          : 'linkedIntentVc supplied but the cart carries no intentId',
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
    const intentResult = verifyMandate(
      opts.linkedIntentVc,
      { ...opts, replayStore: undefined, linkedIntentVc: undefined },
      nowMs,
    );
    if (!intentResult.verified) {
      return fail(
        'AP2_MANDATE_LINKAGE_INVALID',
        `linked intent failed verification (${intentResult.errorCode})`,
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
    if (intentResult.mandateType !== 'IntentMandate') {
      return fail(
        'AP2_MANDATE_LINKAGE_INVALID',
        'linked credential is not an IntentMandate',
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
    const linkedId = getMandateId(opts.linkedIntentVc);
    if (linkedId !== intentId) {
      return fail(
        'AP2_MANDATE_LINKAGE_INVALID',
        `cart intentId '${intentId}' does not match the linked intent id '${String(linkedId)}'`,
        mandateHash,
        issuerDid,
        mandateType,
      );
    }
    // Intent constraint: merchant allowlist, when the intent carries one.
    const intentSubject = opts.linkedIntentVc.credentialSubject as Record<
      string,
      unknown
    >;
    const merchants = intentSubject.merchants;
    if (Array.isArray(merchants) && merchants.length > 0) {
      const cartMerchant =
        (typeof subject.merchant === 'string' && subject.merchant) ||
        (typeof subject.merchant_name === 'string' && subject.merchant_name) ||
        (typeof subject.payee === 'string' && subject.payee) ||
        undefined;
      if (!cartMerchant || !merchants.includes(cartMerchant)) {
        return fail(
          'AP2_MANDATE_LINKAGE_INVALID',
          'cart merchant is not in the intent merchant allowlist',
          mandateHash,
          issuerDid,
          mandateType,
        );
      }
    }
  }

  return { verified: true, issuerDid, mandateHash, mandateType };
}
