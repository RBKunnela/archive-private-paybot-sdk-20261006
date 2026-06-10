/**
 * Unit tests for the pure helpers of scripts/quickstart-smoke.mjs (DP-1.4).
 *
 * The live signup -> mock pay() run against the hosted facilitator is the CI
 * job itself (.github/workflows/quickstart-smoke.yml) — these tests cover the
 * script's own logic: fresh-identity generation, response validation, and
 * secret masking.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module without type declarations (script, not src)
import {
  DEFAULT_FACILITATOR_URL,
  generateIdentity,
  maskApiKey,
  redactSecrets,
  validatePayResult,
  validateSignupResult,
} from '../scripts/quickstart-smoke.mjs';

describe('quickstart-smoke helpers', () => {
  describe('generateIdentity', () => {
    it('embeds timestamp + random suffix in email, botId and password (deterministic inputs)', () => {
      const id = generateIdentity(1717999999999, 'abcd1234');
      expect(id.email).toBe('smoke-1717999999999-abcd1234@smoke.paybotcore.com');
      expect(id.botId).toBe('smoke-1717999999999-abcd1234');
      expect(id.password).toContain('1717999999999');
      expect(id.password.length).toBeGreaterThanOrEqual(20);
    });

    it('produces fresh, collision-free identities on consecutive calls (global botId namespace)', () => {
      const a = generateIdentity();
      const b = generateIdentity();
      expect(a.botId).not.toBe(b.botId);
      expect(a.email).not.toBe(b.email);
      expect(a.password).not.toBe(b.password);
      // matches the smoke-<timestamp>-<rand> convention from the story
      expect(a.botId).toMatch(/^smoke-\d{10,}-[0-9a-f]{8}$/);
      expect(a.email).toMatch(/^smoke-\d{10,}-[0-9a-f]{8}@smoke\.paybotcore\.com$/);
    });
  });

  describe('maskApiKey', () => {
    it('prints at most the last 4 characters', () => {
      expect(maskApiKey('pb_live_abcdefgh1234')).toBe('****1234');
    });

    it('never reveals the full key, even for short or non-string input', () => {
      expect(maskApiKey('ab')).toBe('****ab');
      expect(maskApiKey('')).toBe('****');
      expect(maskApiKey(undefined)).toBe('****');
      expect(maskApiKey(12345)).toBe('****');
    });
  });

  describe('redactSecrets', () => {
    it('masks pb_-style keys embedded in arbitrary log text', () => {
      const masked = redactSecrets('server said apiKey=pb_live_secretsecret9876 status=401');
      expect(masked).not.toContain('pb_live_secretsecret9876');
      expect(masked).toContain('****9876');
    });

    it('leaves text without keys untouched', () => {
      expect(redactSecrets('plain error: 503 upstream')).toBe('plain error: 503 upstream');
    });
  });

  describe('validateSignupResult', () => {
    it('accepts the documented SignupResult shape', () => {
      expect(
        validateSignupResult({
          operatorId: 'op_123',
          apiKey: 'pb_live_x',
          botId: 'smoke-1-aa',
          message: 'ok',
        })
      ).toEqual([]);
    });

    it('names every missing field', () => {
      const problems = validateSignupResult({ operatorId: '', botId: 'b' });
      expect(problems.join('\n')).toContain('operatorId');
      expect(problems.join('\n')).toContain('apiKey');
      expect(problems).toHaveLength(2);
    });

    it('rejects non-object results', () => {
      expect(validateSignupResult(undefined)).toHaveLength(1);
      expect(validateSignupResult(null)[0]).toContain('did not return an object');
    });
  });

  describe('validatePayResult', () => {
    const good = {
      success: true,
      txHash: '0xdeadbeefdeadbeef',
      grossAmount: '50000',
      netAmount: '48750',
      commissionAmount: '1250',
      commissionRate: 0.025,
    };

    it('accepts a successful mock payment with commission fields and 0x txHash', () => {
      expect(validatePayResult(good)).toEqual([]);
    });

    it('surfaces server error + errorCode when success is false (the P0 drift case)', () => {
      const problems = validatePayResult({
        ...good,
        success: false,
        error: 'Invalid payment payload',
        errorCode: 'INVALID_PAYLOAD',
      });
      const text = problems.join('\n');
      expect(text).toContain('success !== true');
      expect(text).toContain('Invalid payment payload');
      expect(text).toContain('INVALID_PAYLOAD');
    });

    it('rejects malformed txHash and missing commission fields', () => {
      const problems = validatePayResult({ success: true, txHash: 'not-hex' });
      const text = problems.join('\n');
      expect(text).toContain('txHash');
      expect(text).toContain('commissionAmount');
      expect(text).toContain('commissionRate');
    });

    it('rejects non-object results', () => {
      expect(validatePayResult('boom')[0]).toContain('did not return an object');
    });
  });

  it('defaults to the hosted facilitator URL', () => {
    expect(DEFAULT_FACILITATOR_URL).toBe('https://api.paybotcore.com');
  });
});
