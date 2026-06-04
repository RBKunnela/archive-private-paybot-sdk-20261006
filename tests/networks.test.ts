import { describe, it, expect } from 'vitest';
import {
  NETWORKS,
  USDC_CONFIG,
  getNetwork,
  getSupportedNetworks,
  EIP712_DOMAINS,
  EIP3009_TYPES,
} from '../src/networks.js';

describe('NETWORKS', () => {
  it('should include Base Sepolia (testnet)', () => {
    const net = NETWORKS['eip155:84532'];
    expect(net).toBeDefined();
    expect(net.name).toBe('Base Sepolia');
    expect(net.chainId).toBe(84532);
    expect(net.isTestnet).toBe(true);
    expect(net.usdcAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('should include Base Mainnet', () => {
    const net = NETWORKS['eip155:8453'];
    expect(net).toBeDefined();
    expect(net.name).toBe('Base Mainnet');
    expect(net.chainId).toBe(8453);
    expect(net.isTestnet).toBe(false);
  });

  // T2.1 — EVM L2 mainnet expansion.
  it.each([
    ['eip155:10', 'Optimism', 10, '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'],
    ['eip155:42161', 'Arbitrum One', 42161, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'],
    ['eip155:137', 'Polygon PoS', 137, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'],
  ] as const)(
    'should include %s (%s) as a mainnet with the official USDC address',
    (caip2, name, chainId, usdcAddress) => {
      const net = NETWORKS[caip2];
      expect(net).toBeDefined();
      expect(net.name).toBe(name);
      expect(net.chainId).toBe(chainId);
      expect(net.caip2).toBe(caip2);
      expect(net.isTestnet).toBe(false);
      expect(net.usdcAddress).toBe(usdcAddress);
      expect(net.usdcAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(net.rpcUrl).toMatch(/^https:\/\//);
      expect(net.explorerUrl).toMatch(/^https:\/\//);
    },
  );
});

describe('getNetwork', () => {
  it('should return config for known CAIP-2 ID', () => {
    const net = getNetwork('eip155:84532');
    expect(net).toBeDefined();
    expect(net!.caip2).toBe('eip155:84532');
  });

  it('should return undefined for unknown CAIP-2 ID', () => {
    expect(getNetwork('eip155:99999')).toBeUndefined();
  });
});

describe('getSupportedNetworks', () => {
  it('should return array of CAIP-2 IDs including all mainnets + testnet', () => {
    const networks = getSupportedNetworks();
    expect(networks).toEqual(
      expect.arrayContaining([
        'eip155:8453',
        'eip155:84532',
        'eip155:10',
        'eip155:42161',
        'eip155:137',
      ]),
    );
    expect(networks.length).toBe(5);
  });
});

describe('cross-chain USDC resolution (T2.1)', () => {
  // Every supported network must resolve USDC via getEip712Domain + carry a
  // matching legacy EIP712_DOMAINS entry (the regression-safe USDC view).
  it.each(getSupportedNetworks())('resolves USDC on %s', (network) => {
    const net = NETWORKS[network];
    const domain = EIP712_DOMAINS[network];
    expect(domain).toBeDefined();
    expect(domain.name).toBe('USDC');
    expect(domain.chainId).toBe(net.chainId);
    // The USDC EIP-712 verifyingContract is exactly the network's usdcAddress.
    expect(domain.verifyingContract).toBe(net.usdcAddress);
  });
});

describe('USDC_CONFIG', () => {
  it('should have 6 decimals', () => {
    expect(USDC_CONFIG.decimals).toBe(6);
  });

  it('should have correct symbol', () => {
    expect(USDC_CONFIG.symbol).toBe('USDC');
  });
});

describe('EIP712_DOMAINS', () => {
  it('should have domain for Base Sepolia', () => {
    const domain = EIP712_DOMAINS['eip155:84532'];
    expect(domain).toBeDefined();
    expect(domain.chainId).toBe(84532);
    expect(domain.name).toBe('USDC');
    expect(domain.verifyingContract).toMatch(/^0x/);
  });

  it('should have domain for Base Mainnet', () => {
    const domain = EIP712_DOMAINS['eip155:8453'];
    expect(domain).toBeDefined();
    expect(domain.chainId).toBe(8453);
  });

  it('should use USDC address as verifyingContract', () => {
    const domain = EIP712_DOMAINS['eip155:84532'];
    expect(domain.verifyingContract).toBe(NETWORKS['eip155:84532'].usdcAddress);
  });
});

describe('EIP3009_TYPES', () => {
  it('should define TransferWithAuthorization fields', () => {
    const fields = EIP3009_TYPES.TransferWithAuthorization;
    expect(fields).toHaveLength(6);
    const names = fields.map((f) => f.name);
    expect(names).toEqual(['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']);
  });
});
