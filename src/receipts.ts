/** Scheme-agnostic SHA-256 hash-chain helpers for payment receipts. */
import { createHash } from 'crypto';

/** JSON-like receipt object accepted by the hash-chain helpers. */
export type HashChainReceipt = object;

function canonicalizeReceipt(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('Receipt hash: cannot canonicalize non-finite number');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`Receipt hash: unsupported type ${typeof value}`);
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? 'null' : canonicalizeReceipt(item)))
      .join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    fields.push(`${JSON.stringify(key)}:${canonicalizeReceipt(item)}`);
  }
  return `{${fields.join(',')}}`;
}

/** Compute SHA-256 over the receipt's canonical JSON, as lowercase hex. */
export function hashReceipt(receipt: HashChainReceipt): string {
  return createHash('sha256')
    .update(canonicalizeReceipt(receipt), 'utf8')
    .digest('hex');
}

/**
 * Validate an ordered receipt chain without assuming or verifying a signature
 * scheme. The genesis receipt must omit `prevReceiptHash`.
 */
export function verifyReceiptChain(receipts: readonly HashChainReceipt[]): boolean {
  if (receipts.length === 0) return true;

  const genesis = receipts[0] as { prevReceiptHash?: unknown };
  if (genesis.prevReceiptHash !== undefined && genesis.prevReceiptHash !== null) {
    return false;
  }

  for (let index = 1; index < receipts.length; index++) {
    const current = receipts[index] as { prevReceiptHash?: unknown };
    if (current.prevReceiptHash !== hashReceipt(receipts[index - 1])) {
      return false;
    }
  }
  return true;
}
