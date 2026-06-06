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
import { createHash } from 'node:crypto';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Forbidden substrings that must never appear anywhere in `src/`. Mirrors the
 * literal-pattern denylist in scripts/verify-open-core-boundary.sh (premium
 * vendor/compliance terms). The operator-private EURC mainnet address is NOT
 * listed here as a literal — it is enforced separately via a one-way hash so
 * this guard does not itself publish the value it guards (see below).
 */
const FORBIDDEN_PATTERNS: readonly string[] = [
  'MiCA',
  'FIN-FSA',
  'Chainalysis',
  'Elliptic',
  'Onfido',
  'Tink',
  'PSD2',
];

/**
 * SHA-256 of the lowercased operator-private EURC mainnet address (incl. the
 * `0x` prefix). Storing only this one-way hash keeps the guarded value out of
 * shippable code. Detection (below) extracts every `0x`-40-hex token from
 * `src/`, lowercases + hashes each, and fails if any matches this hash —
 * functionally equivalent to a literal denylist for the address.
 */
const FORBIDDEN_EURC_ADDR_SHA256 =
  'b263ba174b7c339735c3734a9829d0dc5af0f5dd2efbfdfe79add4065a44148a';

/** sha256 hex digest of `value` (lowercased), matching the bash verifier. */
function sha256Lower(value: string): string {
  return createHash('sha256').update(value.toLowerCase()).digest('hex');
}

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

  it('[boundary] src/ must not contain the operator-private token address', () => {
    const tokenRe = /0x[0-9a-fA-F]{40}/g;
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(tokenRe)) {
        if (sha256Lower(match[0]) === FORBIDDEN_EURC_ADDR_SHA256) {
          // Never echo the offending value — report by file only.
          offenders.push(file);
          break;
        }
      }
    }
    expect(
      offenders,
      `operator-private token address detected in:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
