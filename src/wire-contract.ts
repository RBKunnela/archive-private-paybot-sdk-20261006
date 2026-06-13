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
 * Slice 1: the pending-approval envelope only. Later slices add `VerifyResponse`,
 * `SettleResponse`, the `/approvals/{id}` poll response, etc.
 *
 * Dependencies: none (pure types + a runtime field descriptor).
 * Used by: `client.ts` (`mapPendingEnvelope` input type), and the conformance test.
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
 */
export type WireFieldType = 'string' | 'number' | 'boolean';

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
