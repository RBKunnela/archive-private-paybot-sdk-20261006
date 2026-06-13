/**
 * @module tests/contract/pending-envelope.conformance
 *
 * THE CONTRACT-CONFORMANCE SPINE (issue #118, B1 slice 1 — sdk side).
 *
 * This is the cross-repo, cross-license bridge. The sdk cannot import core's zod
 * schema (core is BUSL-1.1/private, the sdk is MIT/public). Instead:
 *
 *   1. core emits `dist/wire-contract.json` (a JSON-Schema dump of its exported
 *      `pendingEnvelopeSchema`) via `npm run build:contract`.
 *   2. the sdk VENDORS a copy at `tests/fixtures/wire-contract.json`.
 *   3. THIS test asserts the sdk's hand-declared `PendingEnvelopeWire`
 *      (via its runtime descriptor `PENDING_ENVELOPE_WIRE_FIELDS`) is structurally
 *      equal to core's snapshot definition — same field set, same primitive types,
 *      and core's `.strict()` (`additionalProperties:false`) is honored.
 *
 * When core renames/adds/removes a pending-envelope field, regenerating the
 * snapshot and re-vendoring it makes this test FAIL until the sdk mirror is
 * updated in lock-step. That CI failure IS the regression shield for #118 — drift
 * is caught at build time, never in production.
 *
 * To refresh the snapshot after an intentional core change:
 *   (in paybot-core)  npm run build && npm run build:contract
 *   then copy core's dist/wire-contract.json → this repo's tests/fixtures/.
 *
 * Test naming convention: `[CONTRACT] subject — should [behavior] when [condition]`.
 */

import { describe, it, expect } from 'vitest';
import wireContract from '../fixtures/wire-contract.json';
import {
  PENDING_ENVELOPE_WIRE_FIELDS,
  type PendingEnvelopeWire,
  type WireFieldType,
} from '../../src/wire-contract.js';

/** The shape of one JSON-Schema property entry we care about. */
interface JsonSchemaProperty {
  type?: string;
  const?: unknown;
}

/** The shape of one contract definition in the vendored snapshot. */
interface JsonSchemaDefinition {
  type: string;
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: boolean;
}

const CONTRACT_NAME = 'PendingEnvelope';

function getDefinition(name: string): JsonSchemaDefinition {
  const defs = (wireContract as { definitions: Record<string, JsonSchemaDefinition> }).definitions;
  const def = defs[name];
  if (def === undefined) {
    throw new Error(
      `Vendored snapshot has no "${name}" definition. Re-run core \`build:contract\` and re-vendor tests/fixtures/wire-contract.json.`
    );
  }
  return def;
}

/**
 * Map a JSON-Schema property to the sdk's primitive type tag, so the two sides
 * are comparable. A `const` literal (e.g. core's `z.literal('pending_approval')`)
 * still carries `type:'string'` in the dump, so this stays simple.
 */
function jsonSchemaTypeToWireType(prop: JsonSchemaProperty): WireFieldType {
  switch (prop.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      throw new Error(`Unhandled JSON-Schema type "${String(prop.type)}" in snapshot.`);
  }
}

describe('pending-envelope wire conformance (sdk ⊇⊆ core snapshot)', () => {
  const def = getDefinition(CONTRACT_NAME);
  const snapshotFields = Object.keys(def.properties).sort();
  const sdkFields = Object.keys(PENDING_ENVELOPE_WIRE_FIELDS).sort();

  it('[CONTRACT] PendingEnvelopeWire — should declare EXACTLY core’s field set (happy)', () => {
    // Bidirectional: no field the sdk forgot, no field the sdk invented.
    expect(sdkFields).toEqual(snapshotFields);
  });

  it('[CONTRACT] PendingEnvelopeWire — should match core’s primitive type for every field (happy)', () => {
    for (const field of snapshotFields) {
      const expected = jsonSchemaTypeToWireType(def.properties[field]);
      const actual = PENDING_ENVELOPE_WIRE_FIELDS[field as keyof typeof PENDING_ENVELOPE_WIRE_FIELDS];
      expect(actual, `field "${field}" type mismatch`).toBe(expected);
    }
  });

  it('[CONTRACT] snapshot — should mark every field required AND forbid extras (.strict) (edge)', () => {
    // core uses `.strict()`; the dump must carry that through so drift fails closed.
    expect(def.additionalProperties).toBe(false);
    expect([...def.required].sort()).toEqual(snapshotFields);
  });

  it('[CONTRACT] snapshot — should be a versioned paybot-core artifact (edge)', () => {
    // Guard against vendoring an unrelated/garbage JSON by accident.
    const meta = wireContract as { $contract?: string; version?: number; issue?: number };
    expect(meta.$contract).toBe('paybot-core wire contract');
    expect(typeof meta.version).toBe('number');
    expect(meta.issue).toBe(118);
  });

  it('[CONTRACT] PendingEnvelopeWire — should keep status as the pending discriminator (happy)', () => {
    // The one field the sdk semantically depends on at the `pay()` branch.
    const statusProp = def.properties.status;
    expect(statusProp.type).toBe('string');
    expect(statusProp.const).toBe('pending_approval');
    // Compile-time anchor: a literal value still typed against the wire interface.
    const probe: Pick<PendingEnvelopeWire, 'status'> = { status: 'pending_approval' };
    expect(probe.status).toBe('pending_approval');
  });
});
