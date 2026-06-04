import { describe, it, expect } from 'vitest';
import {
  CliConfigError,
  formatNetworks,
  formatTokens,
  maskSecret,
  parseTrustLevel,
  resolveConfig,
} from '../src/cli/config.js';

describe('cli/maskSecret', () => {
  it('[UNIT] maskSecret — should keep prefix and suffix when secret is long enough', () => {
    expect(maskSecret('pb_test_abcdef123456')).toBe('pb_t…3456');
  });

  it('[UNIT] maskSecret — should collapse short secrets to *** (error/leak guard)', () => {
    // 9 chars, visible*2+1 = 9 → not enough headroom to mask safely.
    expect(maskSecret('0xshorttt')).toBe('***');
  });

  it('[UNIT] maskSecret — should return *** for undefined/empty (edge case)', () => {
    expect(maskSecret(undefined)).toBe('***');
    expect(maskSecret('')).toBe('***');
  });

  it('[UNIT] maskSecret — should never contain the full secret', () => {
    const secret = '0xdeadbeefcafebabe0123456789abcdef';
    const masked = maskSecret(secret);
    expect(masked).not.toBe(secret);
    expect(masked.length).toBeLessThan(secret.length);
    expect(masked).toContain('…');
  });

  it('[UNIT] maskSecret — should honor a custom visible window', () => {
    expect(maskSecret('abcdefghijklmnop', 2)).toBe('ab…op');
  });
});

describe('cli/resolveConfig', () => {
  it('[UNIT] resolveConfig — should prefer flags over env (happy path)', () => {
    const cfg = resolveConfig(
      { apiKey: 'flagKey', botId: 'flagBot' },
      { PAYBOT_API_KEY: 'envKey', PAYBOT_BOT_ID: 'envBot' },
    );
    expect(cfg.apiKey).toBe('flagKey');
    expect(cfg.botId).toBe('flagBot');
  });

  it('[UNIT] resolveConfig — should fall back to env when flags absent', () => {
    const cfg = resolveConfig(
      {},
      { PAYBOT_API_KEY: 'envKey', PAYBOT_BOT_ID: 'envBot' },
    );
    expect(cfg.apiKey).toBe('envKey');
    expect(cfg.botId).toBe('envBot');
  });

  it('[UNIT] resolveConfig — should include optional wallet key and facilitator url when set', () => {
    const cfg = resolveConfig(
      { walletPrivateKey: '0xabc', facilitatorUrl: 'https://f.test' },
      { PAYBOT_API_KEY: 'k', PAYBOT_BOT_ID: 'b' },
    );
    expect(cfg.walletPrivateKey).toBe('0xabc');
    expect(cfg.facilitatorUrl).toBe('https://f.test');
  });

  it('[UNIT] resolveConfig — should omit optional fields when neither flag nor env present', () => {
    const cfg = resolveConfig({}, { PAYBOT_API_KEY: 'k', PAYBOT_BOT_ID: 'b' });
    expect(cfg.walletPrivateKey).toBeUndefined();
    expect(cfg.facilitatorUrl).toBeUndefined();
  });

  it('[UNIT] resolveConfig — should throw a helpful error when api key is missing (error path)', () => {
    expect(() => resolveConfig({}, { PAYBOT_BOT_ID: 'b' })).toThrowError(CliConfigError);
    expect(() => resolveConfig({}, { PAYBOT_BOT_ID: 'b' })).toThrowError(/PAYBOT_API_KEY/);
  });

  it('[UNIT] resolveConfig — should throw a helpful error when bot id is missing (error path)', () => {
    expect(() => resolveConfig({}, { PAYBOT_API_KEY: 'k' })).toThrowError(/PAYBOT_BOT_ID/);
  });
});

describe('cli/parseTrustLevel', () => {
  it('[UNIT] parseTrustLevel — should parse a valid level (happy path)', () => {
    expect(parseTrustLevel('3')).toBe(3);
    expect(parseTrustLevel('0')).toBe(0);
    expect(parseTrustLevel('5')).toBe(5);
  });

  it('[UNIT] parseTrustLevel — should return undefined when unset (edge case)', () => {
    expect(parseTrustLevel(undefined)).toBeUndefined();
  });

  it('[UNIT] parseTrustLevel — should reject non-integers (error path)', () => {
    expect(() => parseTrustLevel('abc')).toThrowError(CliConfigError);
    expect(() => parseTrustLevel('2.5')).toThrowError(CliConfigError);
  });

  it('[UNIT] parseTrustLevel — should reject out-of-range levels (error path)', () => {
    expect(() => parseTrustLevel('6')).toThrowError(/out of range/);
  });
});

describe('cli/formatNetworks', () => {
  it('[UNIT] formatNetworks — should list every supported network with its CAIP-2 id and name', () => {
    const out = formatNetworks();
    const lines = out.split('\n');
    // 5 supported networks (T2.1 registry).
    expect(lines.length).toBe(5);
    expect(out).toContain('eip155:8453');
    expect(out).toContain('Base Mainnet');
  });

  it('[UNIT] formatNetworks — should annotate testnets', () => {
    expect(formatNetworks()).toMatch(/eip155:84532.*testnet/);
  });
});

describe('cli/formatTokens', () => {
  it('[UNIT] formatTokens — should list all tokens with decimals when no network filter (happy path)', () => {
    const out = formatTokens();
    expect(out).toContain('USDC');
    expect(out).toContain('EURC');
    expect(out).toContain('DAI');
    expect(out).toMatch(/USDC\s+6 decimals/);
    expect(out).toMatch(/DAI\s+18 decimals/);
  });

  it('[UNIT] formatTokens — should filter to a network and show addresses (edge case)', () => {
    // Optimism has USDC + DAI but NOT EURC (registry T2.2).
    const out = formatTokens('eip155:10');
    expect(out).toContain('USDC');
    expect(out).toContain('DAI');
    expect(out).not.toContain('EURC');
    expect(out).toContain('0x'); // contract address present
  });

  it('[UNIT] formatTokens — should return a friendly notice for a network with no tokens (error path)', () => {
    const out = formatTokens('eip155:99999');
    expect(out).toMatch(/No supported tokens/);
  });
});
