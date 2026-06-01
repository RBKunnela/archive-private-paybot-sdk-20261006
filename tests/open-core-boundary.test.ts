/**
 * @module open-core-boundary.test
 *
 * In-suite tripwire enforcing the open-core / premium boundary on `src/`.
 *
 * The public paybot-sdk MUST NOT ship operator-private ("premium") EU-compliance
 * positioning — it is what the operator sells, and it must live only in the
 * private repos. `scripts/verify-open-core-boundary.sh` is the canonical CI gate;
 * this test is a FAST, platform-independent duplicate of its core checks so a
 * leak fails locally under `npm test` even when the shell script is not run.
 *
 * If this test fails: a forbidden term or address was reintroduced into `src/`.
 * Remove it — do NOT loosen this test.
 *
 * Dependencies: node:fs, node:path, node:url.
 * Used by: vitest test run + the open-core boundary CI job.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Forbidden substrings that must never appear anywhere in `src/`. Mirrors the
 * patterns in scripts/verify-open-core-boundary.sh (premium vendor/compliance
 * terms + the operator-private EURC mainnet contract address, both cases).
 */
const FORBIDDEN_PATTERNS: readonly string[] = [
  'MiCA',
  'FIN-FSA',
  'Chainalysis',
  'Elliptic',
  'Onfido',
  'Tink',
  'PSD2',
  // Operator-private EURC Base-mainnet address (upper + lower case forms).
  '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42',
];

/** Recursively collect every `.ts` file under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('open-core boundary (src/ tripwire)', () => {
  const files = collectTsFiles(SRC_DIR);

  it('[guard] should find at least one source file to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`[boundary] src/ must not contain forbidden pattern "${pattern}"`, () => {
      const needle = pattern.toLowerCase();
      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8').toLowerCase();
        if (text.includes(needle)) {
          offenders.push(file);
        }
      }
      expect(
        offenders,
        `Forbidden pattern "${pattern}" leaked into:\n${offenders.join('\n')}`,
      ).toEqual([]);
    });
  }
});
