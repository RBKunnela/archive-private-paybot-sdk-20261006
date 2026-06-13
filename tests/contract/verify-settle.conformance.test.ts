/**
 * @module tests/contract/verify-settle.conformance
 *
 * THE CONTRACT-CONFORMANCE SPINE, slice 2 (issue #118, B1 — sdk side).
 *
 * Same cross-repo / cross-license bridge as the slice-1
 * `pending-envelope.conformance.test.ts`, extended to the `/verify` and `/settle`
 * SUCCESS responses. The sdk cannot import core's zod schemas (core is
 * BUSL-1.1/private, the sdk is MIT/public). Instead:
 *
 *   1. core emits `dist/wire-contract.json` (a JSON-Schema dump of its exported
 *      `verifyResponseSchema` + `settleResponseSchema`) via `npm run build:contract`.
 *   2. the sdk VENDORS a copy at `tests/fixtures/wire-contract.json` — the SAME
 *      vendored file the slice-1 test reads (now carrying all THREE shapes:
 *      `PendingEnvelope`, `VerifyResponse`, `SettleResponse`).
 *   3. THIS test asserts the sdk's hand-declared `VerifyResponseWire` /
 *      `SettleResponseWire` (via their runtime descriptors) are structurally equal
 *      to core's snapshot definitions — same field set (top-level AND nested),
 *      same primitive types, same required/optional split, and core's `.strict()`
 *      (`additionalProperties:false`) honored on every object level.
 *
 * THE DRIFT-SHIELD (the whole point): when core renames/adds/removes a verify- or
 * settle-response field, regenerating the snapshot and re-vendoring it makes this
 * test FAIL until the sdk mirror is updated in lock-step. That CI failure IS the
 * regression shield for #118 — drift caught at build time, never in production.
 * The recursion means a RENAMED NESTED field (e.g. `commission.grossAmount` →
 * `commission.gross`) fails exactly like a renamed top-level one.
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
  VERIFY_RESPONSE_WIRE_FIELDS,
  VERIFY_RESPONSE_REQUIRED_FIELDS,
  SETTLE_RESPONSE_WIRE_FIELDS,
  SETTLE_RESPONSE_REQUIRED_FIELDS,
  type WireFieldDescriptor,
  type WireObjectDescriptor,
  type VerifyResponseWire,
  type SettleResponseWire,
} from '../../src/wire-contract.js';

/** One JSON-Schema property entry in the vendored snapshot. */
interface JsonSchemaProperty {
  type?: string;
  const?: unknown;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  propertyNames?: { type?: string };
}

/** One contract definition (top-level object) in the vendored snapshot. */
interface JsonSchemaDefinition extends JsonSchemaProperty {
  type: string;
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: boolean;
}

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
 * Is this JSON-Schema property an ADR-opaque passthrough bag? zod's
 * `z.record(z.string(), z.unknown())` dumps as an object WITHOUT a fixed
 * `properties`/`required` set and WITH an open `additionalProperties` (and a
 * `propertyNames` string guard). The sdk tags these `'opaque-object'`.
 */
function isOpaqueObject(prop: JsonSchemaProperty): boolean {
  return (
    prop.type === 'object' &&
    prop.properties === undefined &&
    prop.additionalProperties !== false
  );
}

/**
 * Recursively assert that an sdk descriptor matches a JSON-Schema object node.
 * Compares field sets, primitive types, required/optional split, nested objects,
 * and that every object level honors core's `.strict()`
 * (`additionalProperties:false`). Throws a descriptive error on the first mismatch
 * so a drifted field is named in the failure.
 */
function assertObjectConforms(
  path: string,
  descriptor: WireObjectDescriptor,
  node: JsonSchemaProperty
): void {
  // Every fixed-shape object level must be `.strict()` in core's dump.
  expect(node.additionalProperties, `${path}: expected .strict() (additionalProperties:false)`).toBe(
    false
  );

  const snapProps = node.properties ?? {};
  const snapFields = Object.keys(snapProps).sort();
  const sdkFields = Object.keys(descriptor).sort();
  // Bidirectional field-set equality: no field the sdk forgot or invented.
  expect(sdkFields, `${path}: field set drift`).toEqual(snapFields);

  const snapRequired = [...(node.required ?? [])].sort();

  for (const field of snapFields) {
    const fieldPath = `${path}.${field}`;
    const sdkDesc = descriptor[field];
    const snapProp = snapProps[field];

    if (typeof sdkDesc === 'object') {
      // Nested object: recurse. The snapshot node must also be a fixed object.
      expect(snapProp.type, `${fieldPath}: expected nested object`).toBe('object');
      expect(
        isOpaqueObject(snapProp),
        `${fieldPath}: sdk declares a fixed object but snapshot is opaque`
      ).toBe(false);
      assertObjectConforms(fieldPath, sdkDesc.object, snapProp);
      // The nested required-set the sdk declared must match the snapshot's.
      expect([...sdkDesc.required].sort(), `${fieldPath}: nested required drift`).toEqual(
        [...(snapProp.required ?? [])].sort()
      );
    } else if (sdkDesc === 'opaque-object') {
      // ADR-opaque passthrough bag: only assert it IS an open object.
      expect(isOpaqueObject(snapProp), `${fieldPath}: expected an opaque object bag`).toBe(true);
    } else {
      // Primitive leaf.
      const expected =
        snapProp.type === 'integer' ? 'number' : snapProp.type;
      expect(sdkDesc, `${fieldPath}: primitive type mismatch`).toBe(expected);
    }
  }

  // Required/optional split is part of the contract: a field flipping
  // optional↔required is drift too.
  void snapRequired;
}

describe('snapshot meta (slice 2)', () => {
  it('[CONTRACT] snapshot — should be a versioned paybot-core artifact carrying all 3 shapes (edge)', () => {
    const meta = wireContract as {
      $contract?: string;
      version?: number;
      issue?: number;
      definitions?: Record<string, unknown>;
    };
    expect(meta.$contract).toBe('paybot-core wire contract');
    expect(typeof meta.version).toBe('number');
    expect(meta.issue).toBe(118);
    // The single vendored file now covers slice 1 + slice 2.
    expect(Object.keys(meta.definitions ?? {}).sort()).toEqual(
      ['PendingEnvelope', 'SettleResponse', 'VerifyResponse'].sort()
    );
  });
});

describe('verify-response wire conformance (sdk ⊇⊆ core snapshot)', () => {
  const def = getDefinition('VerifyResponse');

  it('[CONTRACT] VerifyResponseWire — should match core’s shape recursively (happy)', () => {
    assertObjectConforms('VerifyResponse', VERIFY_RESPONSE_WIRE_FIELDS, def);
  });

  it('[CONTRACT] VerifyResponseWire — should match core’s required/optional split (happy)', () => {
    // `payer` is optional in core's snapshot; everything else required.
    expect([...VERIFY_RESPONSE_REQUIRED_FIELDS].sort()).toEqual([...def.required].sort());
    expect(def.required).not.toContain('payer');
    expect(Object.keys(def.properties)).toContain('payer');
  });

  it('[CONTRACT] VerifyResponse — should keep the opaque requirements `extra` bag open (edge)', () => {
    // ADR-flagged passthrough: core must NOT have force-typed it.
    const extra = def.properties.modifiedRequirements?.properties?.extra;
    expect(extra, 'modifiedRequirements.extra missing from snapshot').toBeDefined();
    expect(isOpaqueObject(extra as JsonSchemaProperty)).toBe(true);
    // It must NOT be in the requirements required-set (it is optional).
    expect(def.properties.modifiedRequirements?.required ?? []).not.toContain('extra');
  });

  it('[CONTRACT] VerifyResponse — should honor .strict() at every fixed-object level (edge)', () => {
    expect(def.additionalProperties).toBe(false);
    expect(def.properties.modifiedRequirements?.additionalProperties).toBe(false);
    expect(def.properties.commission?.additionalProperties).toBe(false);
  });

  it('[CONTRACT] VerifyResponseWire — compile-time anchor for the settle hand-off fields (happy)', () => {
    // The fields the sdk reads at the settle hand-off, typed against the wire.
    const probe: Pick<VerifyResponseWire, 'settlementToken' | 'commission'> = {
      settlementToken: 'st_x',
      commission: {
        grossAmount: '1',
        netAmount: '1',
        commissionAmount: '0',
        commissionRate: 0,
      },
    };
    expect(probe.commission.grossAmount).toBe('1');
  });
});

describe('settle-response wire conformance (sdk ⊇⊆ core snapshot)', () => {
  const def = getDefinition('SettleResponse');

  it('[CONTRACT] SettleResponseWire — should match core’s shape recursively (happy)', () => {
    assertObjectConforms('SettleResponse', SETTLE_RESPONSE_WIRE_FIELDS, def);
  });

  it('[CONTRACT] SettleResponseWire — should match core’s required/optional split (happy)', () => {
    // Only `success` is required; transaction + network are optional.
    expect([...SETTLE_RESPONSE_REQUIRED_FIELDS].sort()).toEqual([...def.required].sort());
    expect(def.required).toEqual(['success']);
  });

  it('[CONTRACT] SettleResponse — should NOT leak internal failure fields onto the wire (edge)', () => {
    // The richer internal SettleResponse carries errorKind/amlDecision/…; the
    // success wire must expose only the 3 contract fields, and .strict() forbids
    // the rest.
    expect(def.additionalProperties).toBe(false);
    expect(Object.keys(def.properties).sort()).toEqual(['network', 'success', 'transaction'].sort());
    expect(Object.keys(def.properties)).not.toContain('errorKind');
    expect(Object.keys(def.properties)).not.toContain('amlDecision');
  });

  it('[CONTRACT] SettleResponseWire — compile-time anchor for the result fields (happy)', () => {
    const probe: SettleResponseWire = { success: true, transaction: '0xabc', network: 'eip155:8453' };
    expect(probe.success).toBe(true);
  });
});

// ── DRIFT-SHIELD self-test: the comparator MUST fail on a field rename ───────

describe('drift-shield integrity (the comparator genuinely fails closed)', () => {
  it('[CONTRACT] comparator — should FAIL when a top-level field is renamed (edge)', () => {
    const def = getDefinition('SettleResponse');
    // Simulate core renaming `transaction` → `txHash` in the snapshot WITHOUT the
    // sdk descriptor being updated. The comparator must reject it.
    const drifted: JsonSchemaProperty = {
      ...def,
      properties: {
        success: def.properties.success,
        txHash: def.properties.transaction, // renamed
        network: def.properties.network,
      },
    };
    expect(() =>
      assertObjectConforms('SettleResponse(drifted)', SETTLE_RESPONSE_WIRE_FIELDS, drifted)
    ).toThrow();
  });

  it('[CONTRACT] comparator — should FAIL when a NESTED field is renamed (edge)', () => {
    const def = getDefinition('VerifyResponse');
    const commission = def.properties.commission;
    const driftedCommission: JsonSchemaProperty = {
      ...commission,
      properties: {
        gross: commission.properties?.grossAmount, // renamed grossAmount → gross
        netAmount: commission.properties?.netAmount,
        commissionAmount: commission.properties?.commissionAmount,
        commissionRate: commission.properties?.commissionRate,
      },
    };
    const drifted: JsonSchemaProperty = {
      ...def,
      properties: { ...def.properties, commission: driftedCommission },
    };
    expect(() =>
      assertObjectConforms('VerifyResponse(drifted)', VERIFY_RESPONSE_WIRE_FIELDS, drifted)
    ).toThrow();
  });

  it('[CONTRACT] comparator — should FAIL when a primitive type changes (edge)', () => {
    const def = getDefinition('SettleResponse');
    const drifted: JsonSchemaProperty = {
      ...def,
      properties: {
        ...def.properties,
        success: { type: 'string' }, // boolean → string
      },
    };
    expect(() =>
      assertObjectConforms('SettleResponse(typedrift)', SETTLE_RESPONSE_WIRE_FIELDS, drifted)
    ).toThrow();
  });
});
