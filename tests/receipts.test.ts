import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hashReceipt, verifyReceiptChain } from '../src/receipts.js';
import type { Receipt } from '../src/types.js';

const PYTHON = process.env.PYTHON ?? (existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');

function baseReceipt(receiptId: string): Receipt {
  return {
    receiptId,
    status: 'confirmed',
    confirmedAt: new Date('2026-09-12T10:00:00.000Z'),
    amount: '50000',
    network: 'eip155:8453',
    transactionId: `0x${receiptId}`,
  };
}

describe('receipt hash chains', () => {
  it('hashes canonical receipt JSON deterministically', () => {
    const first = baseReceipt('receipt-1');
    const reordered = {
      network: first.network,
      amount: first.amount,
      confirmedAt: first.confirmedAt,
      status: first.status,
      transactionId: first.transactionId,
      receiptId: first.receiptId,
    };

    expect(hashReceipt(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashReceipt(reordered)).toBe(hashReceipt(first));
  });

  it('validates a linked chain and detects tampering or a non-genesis root', () => {
    const first = baseReceipt('receipt-1');
    const second = { ...baseReceipt('receipt-2'), prevReceiptHash: hashReceipt(first) };
    const third = { ...baseReceipt('receipt-3'), prevReceiptHash: hashReceipt(second) };

    expect(verifyReceiptChain([])).toBe(true);
    expect(verifyReceiptChain([first, second, third])).toBe(true);
    expect(verifyReceiptChain([{ ...first, prevReceiptHash: '0'.repeat(64) }])).toBe(false);
    expect(verifyReceiptChain([first, { ...second, amount: '50001' }, third])).toBe(false);
  });

  it('validates Python-built chains in TS and TS-built chains in Python', () => {
    const pythonBuild = spawnSync(
      PYTHON,
      ['-c', [
        'import hashlib, json',
        'hash_receipt = lambda receipt: hashlib.sha256(json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()).hexdigest()',
        'first = {"receiptId":"py-1","status":"confirmed","amount":"7","network":"eip155:8453","signature":{"scheme":"eip191","value":"0x01"}}',
        'second = {"receiptId":"py-2","status":"confirmed","amount":"9","network":"eip155:8453","signature":{"scheme":"ed25519","value":"abc"},"prevReceiptHash":hash_receipt(first)}',
        'print(json.dumps([first, second], separators=(",", ":")))',
      ].join(';')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    expect(pythonBuild.status, pythonBuild.stderr).toBe(0);
    expect(verifyReceiptChain(JSON.parse(pythonBuild.stdout) as object[])).toBe(true);

    const first = {
      receiptId: 'ts-1',
      status: 'confirmed',
      amount: '11',
      network: 'eip155:8453',
      signature: { scheme: 'ed25519', value: 'def' },
    };
    const chain = [
      first,
      {
        receiptId: 'ts-2',
        status: 'confirmed',
        amount: '13',
        network: 'eip155:8453',
        signature: { scheme: 'eip191', value: '0x02' },
        prevReceiptHash: hashReceipt(first),
      },
    ];
    const pythonVerify = spawnSync(
      PYTHON,
      ['-c', [
        'import hashlib, json, sys',
        'chain = json.loads(sys.argv[1])',
        'hash_receipt = lambda receipt: hashlib.sha256(json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()).hexdigest()',
        'valid = not chain or (chain[0].get("prevReceiptHash") is None and all(chain[i].get("prevReceiptHash") == hash_receipt(chain[i - 1]) for i in range(1, len(chain))))',
        'print(json.dumps(valid))',
      ].join(';'), JSON.stringify(chain)],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    expect(pythonVerify.status, pythonVerify.stderr).toBe(0);
    expect(JSON.parse(pythonVerify.stdout)).toBe(true);
  });
});
