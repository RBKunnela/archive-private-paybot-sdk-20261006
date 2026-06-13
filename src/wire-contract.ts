/**
 * @module wire-contract
 *
 * The sdk's hand-declared mirror of paybot-core's cross-boundary **response**
 * shapes (issue #118, B1 slice 1). The sdk CANNOT import core's zod schemas:
 * core is `BUSL-1.1` + `private`, the sdk is `MIT` + public — a hard license
 * boundary, and the two repos run on independent cadences. Instead, core emits a
 * JSON-Schema snapshot (`dist/wire-contract.json`) from its exported schemas; the
 * sdk vendors that snapshot at `tests/fixtures/wire-contract.json` and a
 * contract-conformance test (`tests/contract/pending-envelope.conformance.test.ts`)
 * fails CI when this hand-declared shape and core's snapshot diverge.
 *
 * See `paybot-core/docs/architecture/adr-wire-contract-b1.md`.
 *
 * Slice 1: the pending-approval envelope.
 * Slice 2: the `/verify` success response + the `/settle` success response.
 * Later slices add the `/approvals/{id}` poll response, `RefundResponse`, etc.
 *
 * Dependencies: none (pure types + runtime field descriptors).
 * Used by: `client.ts` (`mapPendingEnvelope` + the verify/settle reads), and the
 * conformance test.
 */

/**
 * The pending-approval wire envelope the sdk reads from `/verify` when a payment
 * pauses for human approval (core contract §2a). This MUST stay structurally
 * equal to core's exported `PendingEnvelope` (`pendingEnvelopeSchema`). The
 * conformance test enforces that equality against core's vendored snapshot.
 */
export interface PendingEnvelopeWire {
  /** Discriminator the sdk keys off (not the HTTP code). */
  status: 'pending_approval';
  /** The server-issued approval handle (e.g. `ap_…`). */
  approval_id: string;
  /** Relative poll path for this approval (e.g. `/approvals/ap_…`). */
  poll_url: string;
  /** ISO-8601 expiry; past expiry the approval is treated as denied. */
  expires_at: string;
  /** The authoritative USD amount the server placed in the approval band. */
  amount_usd: number;
  /** Human-readable band reason. */
  reason: string;
  /** Audit sequence id for the `APPROVAL_REQUESTED` event. */
  audit_seq_id: number;
  /** Audit event hash for the `APPROVAL_REQUESTED` event. */
  audit_hash: string;
}

/**
 * JSON-primitive type tags, matching the `type` field a zod → JSON-Schema dump
 * emits for each property. Used by the conformance test to compare this sdk
 * mirror against core's vendored snapshot field-by-field.
 *
 * `'opaque-object'` marks an ADR-flagged passthrough bag (e.g. the requirements
 * `extra` field) — core emits it as an open `additionalProperties` object, so the
 * conformance test checks only that it IS an object, not its inner shape.
 */
export type WireFieldType = 'string' | 'number' | 'boolean' | 'opaque-object';

/**
 * A descriptor for one wire field. Either a primitive/opaque tag, or — for a
 * nested object field — a sub-descriptor carrying its own field map plus the set
 * of required (non-optional) keys. This lets the conformance check recurse into
 * `modifiedRequirements` / `commission` while keeping the same drift-shield
 * (a renamed nested field fails the check exactly like a renamed top-level one).
 */
export type WireFieldDescriptor =
  | WireFieldType
  | {
      readonly object: WireObjectDescriptor;
      /** Keys that are NOT optional in core's snapshot `required` array. */
      readonly required: readonly string[];
    };

/** A map of field name → descriptor for one (possibly nested) object shape. */
export type WireObjectDescriptor = {
  readonly [field: string]: WireFieldDescriptor;
};

/**
 * Runtime descriptor of {@link PendingEnvelopeWire}: every wire field mapped to
 * its JSON primitive type. This is the bridge between the compile-time type and
 * the runtime conformance check — TypeScript types are erased at runtime, so the
 * test compares THIS descriptor to core's JSON-Schema snapshot.
 *
 * The `satisfies Record<keyof PendingEnvelopeWire, WireFieldType>` below pins the
 * descriptor to the type: add/rename/remove a field in `PendingEnvelopeWire` and
 * this object fails `tsc` until it is updated in lock-step — which in turn makes
 * the conformance test re-check against core's snapshot.
 */
export const PENDING_ENVELOPE_WIRE_FIELDS = {
  status: 'string',
  approval_id: 'string',
  poll_url: 'string',
  expires_at: 'string',
  amount_usd: 'number',
  reason: 'string',
  audit_seq_id: 'number',
  audit_hash: 'string',
} as const satisfies Record<keyof PendingEnvelopeWire, WireFieldType>;

// ── slice 2: /verify success response ───────────────────────────────────────

/**
 * The `PaymentRequirements` echoed back by `/verify` as `modifiedRequirements`
 * (commission injected) and forwarded verbatim to `/settle`. Mirrors core's
 * `verifyRequirementsSchema`.
 *
 * `extra` is an ADR-flagged opaque passthrough — left as an open record on
 * purpose (do NOT force-type it; see the ADR).
 */
export interface RequirementsWire {
  /** Payment scheme, e.g. `'exact'`. */
  scheme: string;
  /** CAIP-2 network id, e.g. `'eip155:8453'`. */
  network: string;
  /** CAIP-19 asset id. */
  asset: string;
  /** Amount in base units (decimal string). */
  amount: string;
  /** Recipient wallet address (commission-collection wallet after injection). */
  payTo: string;
  /** Max settlement timeout in seconds. */
  maxTimeoutSeconds: number;
  /** ADR-opaque passthrough bag (e.g. `originalPayTo`). Open by design. */
  extra?: Record<string, unknown>;
}

/**
 * The commission split echoed back by `/verify`. All amounts are decimal strings
 * (base-unit bigints serialized via `.toString()`). Mirrors core's
 * `verifyCommissionSchema`.
 */
export interface CommissionWire {
  /** Gross amount (decimal string, base units). */
  grossAmount: string;
  /** Net amount after commission (decimal string, base units). */
  netAmount: string;
  /** Commission amount (decimal string, base units). */
  commissionAmount: string;
  /** Commission rate as a fraction (e.g. `0.025`). */
  commissionRate: number;
}

/**
 * The `/verify` SUCCESS wire response the sdk reads at the settle hand-off in
 * `pay()`. MUST stay structurally equal to core's exported `VerifyResponseWire`
 * (`verifyResponseSchema`). The conformance test enforces that against core's
 * vendored snapshot.
 *
 * This is the SUCCESS shape only — the pending branch returns
 * {@link PendingEnvelopeWire}; errors take the open error bag (out of scope).
 */
export interface VerifyResponseWire {
  /** Whether the payment payload verified. */
  valid: boolean;
  /** Resolved payer address; omitted when the facilitator cannot derive it. */
  payer?: string;
  /** Commission-modified requirements; forwarded verbatim to `/settle`. */
  modifiedRequirements: RequirementsWire;
  /** Commission split surfaced in the sdk's `PaymentResult`. */
  commission: CommissionWire;
  /** Single-use settlement token the sdk passes to `/settle`. */
  settlementToken: string;
  /** ISO-8601 expiry of the settlement token. */
  settlementTokenExpiresAt: string;
}

/**
 * Runtime descriptor of {@link VerifyResponseWire}, pinned to the type via
 * `satisfies`. Nested objects carry their own field map + required-key set so the
 * conformance check recurses; the `extra` opaque bag is tagged `'opaque-object'`.
 * Add/rename/remove a field (top-level OR nested) and this fails `tsc`, which in
 * turn makes the conformance test re-check against core's snapshot.
 */
export const VERIFY_RESPONSE_WIRE_FIELDS = {
  valid: 'boolean',
  payer: 'string',
  modifiedRequirements: {
    object: {
      scheme: 'string',
      network: 'string',
      asset: 'string',
      amount: 'string',
      payTo: 'string',
      maxTimeoutSeconds: 'number',
      extra: 'opaque-object',
    },
    required: ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds'],
  },
  commission: {
    object: {
      grossAmount: 'string',
      netAmount: 'string',
      commissionAmount: 'string',
      commissionRate: 'number',
    },
    required: ['grossAmount', 'netAmount', 'commissionAmount', 'commissionRate'],
  },
  settlementToken: 'string',
  settlementTokenExpiresAt: 'string',
} as const satisfies Record<keyof VerifyResponseWire, WireFieldDescriptor>;

/**
 * The top-level required (non-optional) keys of {@link VerifyResponseWire} — every
 * field except `payer`. The conformance test asserts this matches core's snapshot
 * `required` array so an accidental optional↔required flip is caught.
 */
export const VERIFY_RESPONSE_REQUIRED_FIELDS = [
  'valid',
  'modifiedRequirements',
  'commission',
  'settlementToken',
  'settlementTokenExpiresAt',
] as const satisfies readonly (keyof VerifyResponseWire)[];

// ── slice 2: /settle success response ───────────────────────────────────────

/**
 * The `/settle` SUCCESS wire response the sdk reads after `/verify`. MUST stay
 * structurally equal to core's exported `SettleResponseWire`
 * (`settleResponseSchema`). The conformance test enforces that against core's
 * vendored snapshot.
 *
 * A strict subset of the richer facilitator-internal settle result: failures
 * throw and take the open error bag, so `errorKind` / `amlDecision` never reach
 * this wire.
 */
export interface SettleResponseWire {
  /** Whether settlement succeeded. */
  success: boolean;
  /** On-chain tx hash; omitted in mock mode / some failure-but-200 paths. */
  transaction?: string;
  /** CAIP-2 network the settlement landed on; omitted when unavailable. */
  network?: string;
}

/**
 * Runtime descriptor of {@link SettleResponseWire}, pinned to the type via
 * `satisfies`. Same drift-shield as the other shapes.
 */
export const SETTLE_RESPONSE_WIRE_FIELDS = {
  success: 'boolean',
  transaction: 'string',
  network: 'string',
} as const satisfies Record<keyof SettleResponseWire, WireFieldDescriptor>;

/**
 * The top-level required (non-optional) keys of {@link SettleResponseWire} — only
 * `success`. Asserted against core's snapshot `required` array.
 */
export const SETTLE_RESPONSE_REQUIRED_FIELDS = [
  'success',
] as const satisfies readonly (keyof SettleResponseWire)[];
