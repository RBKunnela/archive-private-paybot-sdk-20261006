/**
 * @module tests/mpp-seam
 *
 * Unit tests for the thin MPP capability seam (`src/mpp-seam.ts`).
 *
 * Covers:
 *   - detectMppCapability: MPP-Version header → supported detect-only +
 *     specVersion; no advertisement → none; WWW-Authenticate: Payment challenge;
 *     case-insensitive header read; empty/undefined headers.
 *   - createMppSeam: detect delegates to detectMppCapability; settle throws
 *     MPP_NOT_IMPLEMENTED (501).
 *
 * Test naming convention: `[UNIT] symbol — should [behavior] when [condition]`.
 */

import { describe, it, expect } from 'vitest';

import { detectMppCapability, createMppSeam } from '../src/mpp-seam.js';
import { PayBotApiError } from '../src/errors.js';

describe('detectMppCapability', () => {
  it('[UNIT] detectMppCapability — should report detect-only with specVersion when MPP-Version header present', () => {
    const cap = detectMppCapability({ 'MPP-Version': '2024-09-preview' });
    expect(cap.supported).toBe(true);
    expect(cap.mode).toBe('detect-only');
    expect(cap.specVersion).toBe('2024-09-preview');
  });

  it('[UNIT] detectMppCapability — should report none when no MPP advertisement present', () => {
    const cap = detectMppCapability({ 'content-type': 'application/json' });
    expect(cap.supported).toBe(false);
    expect(cap.mode).toBe('none');
    expect(cap.reason).toBe('no MPP advertisement');
  });

  it('[UNIT] detectMppCapability — should detect a WWW-Authenticate Payment challenge', () => {
    const cap = detectMppCapability({
      'WWW-Authenticate': 'Payment realm="x402", network="tempo"',
    });
    expect(cap.supported).toBe(true);
    expect(cap.mode).toBe('detect-only');
    expect(cap.specVersion).toContain('Payment');
  });

  it('[UNIT] detectMppCapability — should read headers case-insensitively', () => {
    const cap = detectMppCapability({ 'stripe-VERSION': '2025-01' });
    expect(cap.supported).toBe(true);
    expect(cap.specVersion).toBe('2025-01');
  });

  it('[UNIT] detectMppCapability — should report none for undefined headers', () => {
    const cap = detectMppCapability();
    expect(cap.supported).toBe(false);
    expect(cap.mode).toBe('none');
  });

  it('[UNIT] detectMppCapability — should report none for an empty headers object', () => {
    const cap = detectMppCapability({});
    expect(cap.supported).toBe(false);
    expect(cap.mode).toBe('none');
  });

  it('[UNIT] detectMppCapability — should not treat a non-payment WWW-Authenticate as MPP', () => {
    const cap = detectMppCapability({ 'WWW-Authenticate': 'Bearer realm="api"' });
    expect(cap.supported).toBe(false);
    expect(cap.mode).toBe('none');
  });
});

describe('createMppSeam', () => {
  it('[UNIT] createMppSeam.detect — should delegate detection to detectMppCapability', () => {
    const seam = createMppSeam();
    expect(seam.detect({ 'MPP-Version': 'x' }).supported).toBe(true);
    expect(seam.detect({}).supported).toBe(false);
  });

  it('[UNIT] createMppSeam.settle — should throw MPP_NOT_IMPLEMENTED with status 501', () => {
    const seam = createMppSeam();
    try {
      seam.settle();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PayBotApiError);
      expect((err as PayBotApiError).code).toBe('MPP_NOT_IMPLEMENTED');
      expect((err as PayBotApiError).statusCode).toBe(501);
    }
  });

  it('[UNIT] createMppSeam.settle — should throw regardless of arguments passed', () => {
    const seam = createMppSeam();
    expect(() => seam.settle('a', 1, { foo: 'bar' })).toThrow(PayBotApiError);
  });
});
