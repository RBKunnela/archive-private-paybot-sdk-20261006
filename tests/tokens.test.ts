import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  USDC_CONFIG,
  getToken,
  getTokenAddress,
  resolveTokenAddress,
  getSupportedTokens,
  getEip712Domain,
  EIP712_DOMAINS,
  NETWORKS,
} from '../src/networks.js';
import { PayBotClient } from '../src/client.js';

// EURC Base Sepolia testnet deployment — the ONLY EURC address shipped in the
// public open-core registry. The EURC mainnet address is operator-private and
// intentionally absent from src/ (resolved at runtime via tokenAddressOverrides).
const EURC_BASE_SEPOLIA = '0x808456652fdb597867f38412077A9182bf77359F';
// Stand-in for the operator-injected EURC mainnet address (a valid checksummed
// USDC-style address; the literal Circle EURC mainnet address must NEVER appear
// in this public repo — see open-core-boundary.test.ts).
const EURC_MAINNET_OVERRIDE = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

describe('TOKENS registry', () => {
  it('should include USDC and EURC', () => {
    expect(getSupportedTokens()).toEqual(expect.arrayContaining(['USDC', 'EURC']));
    expect(getSupportedTokens().length).toBe(2);
  });

  it('should keep USDC_CONFIG exported for back-compat', () => {
    expect(USDC_CONFIG.symbol).toBe('USDC');
    expect(USDC_CONFIG.decimals).toBe(6);
  });
});

describe('getToken', () => {
  it('[happy] should return USDC config', () => {
    const usdc = getToken('USDC');
    expect(usdc).toBeDefined();
    expect(usdc!.symbol).toBe('USDC');
    expect(usdc!.decimals).toBe(6);
    expect(usdc!.name).toBe('USD Coin');
    // Premium EU-compliance metadata must NOT exist on the public token config.
    expect('micaCompliant' in usdc!).toBe(false);
  });

  it('[happy] should return EURC config', () => {
    const eurc = getToken('EURC');
    expect(eurc).toBeDefined();
    expect(eurc!.symbol).toBe('EURC');
    expect(eurc!.decimals).toBe(6);
    expect(eurc!.name).toBe('EURC');
    expect('micaCompliant' in eurc!).toBe(false);
  });

  it('[error/edge] should return undefined for an unknown symbol', () => {
    expect(getToken('DOGE')).toBeUndefined();
    expect(getToken('')).toBeUndefined();
  });
});

describe('getTokenAddress', () => {
  it('[happy] should resolve USDC per network (reusing NETWORKS usdcAddress)', () => {
    expect(getTokenAddress('USDC', 'eip155:8453')).toBe(USDC_BASE_MAINNET);
    expect(getTokenAddress('USDC', 'eip155:84532')).toBe(USDC_BASE_SEPOLIA);
    // Must not diverge from the network config's usdcAddress.
    expect(getTokenAddress('USDC', 'eip155:8453')).toBe(NETWORKS['eip155:8453'].usdcAddress);
    expect(getTokenAddress('USDC', 'eip155:84532')).toBe(NETWORKS['eip155:84532'].usdcAddress);
  });

  it('[happy] should resolve EURC testnet from the public registry', () => {
    expect(getTokenAddress('EURC', 'eip155:84532')).toBe(EURC_BASE_SEPOLIA);
  });

  it('[boundary] should NOT resolve EURC mainnet from the public registry', () => {
    // EURC mainnet is operator-private (premium) and intentionally absent.
    expect(getTokenAddress('EURC', 'eip155:8453')).toBeUndefined();
  });

  it('[error] should return undefined for unknown token', () => {
    expect(getTokenAddress('DOGE', 'eip155:8453')).toBeUndefined();
  });

  it('[edge] should return undefined for unsupported network on a known token', () => {
    expect(getTokenAddress('USDC', 'eip155:1')).toBeUndefined();
    expect(getTokenAddress('EURC', 'eip155:1')).toBeUndefined();
  });
});

describe('getSupportedTokens', () => {
  it('should return all registry symbols', () => {
    const tokens = getSupportedTokens();
    expect(tokens).toContain('USDC');
    expect(tokens).toContain('EURC');
  });
});

describe('resolveTokenAddress (operator override layer)', () => {
  it('[happy] should fall back to the public registry when no overrides given', () => {
    expect(resolveTokenAddress('USDC', 'eip155:8453')).toBe(USDC_BASE_MAINNET);
    expect(resolveTokenAddress('EURC', 'eip155:84532')).toBe(EURC_BASE_SEPOLIA);
  });

  it('[boundary] should return undefined for EURC mainnet without an override', () => {
    expect(resolveTokenAddress('EURC', 'eip155:8453')).toBeUndefined();
  });

  it('[happy] should resolve an operator-injected EURC mainnet address', () => {
    const overrides = { EURC: { 'eip155:8453': EURC_MAINNET_OVERRIDE } };
    expect(resolveTokenAddress('EURC', 'eip155:8453', overrides)).toBe(EURC_MAINNET_OVERRIDE);
  });

  it('[edge] override takes precedence over the public registry', () => {
    const overrides = { USDC: { 'eip155:8453': EURC_MAINNET_OVERRIDE } };
    expect(resolveTokenAddress('USDC', 'eip155:8453', overrides)).toBe(EURC_MAINNET_OVERRIDE);
  });

  it('[edge] unrelated overrides do not affect other tokens/networks', () => {
    const overrides = { EURC: { 'eip155:8453': EURC_MAINNET_OVERRIDE } };
    expect(resolveTokenAddress('USDC', 'eip155:8453', overrides)).toBe(USDC_BASE_MAINNET);
    expect(resolveTokenAddress('EURC', 'eip155:84532', overrides)).toBe(EURC_BASE_SEPOLIA);
  });
});

describe('getEip712Domain', () => {
  // REGRESSION GUARD: USDC domain produced by getEip712Domain must be
  // byte-identical to the legacy EIP712_DOMAINS table so all prior signatures
  // remain valid.
  it('[happy/regression] should produce the legacy USDC domain on Base Mainnet', () => {
    const domain = getEip712Domain('eip155:8453', 'USDC');
    expect(domain).toEqual(EIP712_DOMAINS['eip155:8453']);
    expect(domain).toEqual({
      name: 'USDC',
      version: '2',
      chainId: 8453,
      verifyingContract: USDC_BASE_MAINNET,
    });
  });

  it('[happy/regression] should produce the legacy USDC domain on Base Sepolia', () => {
    const domain = getEip712Domain('eip155:84532', 'USDC');
    expect(domain).toEqual(EIP712_DOMAINS['eip155:84532']);
  });

  it('[happy] should default to USDC when no symbol given', () => {
    expect(getEip712Domain('eip155:8453')).toEqual(EIP712_DOMAINS['eip155:8453']);
  });

  it('[happy] should produce a DISTINCT EURC domain (different name + verifyingContract) on testnet', () => {
    const usdc = getEip712Domain('eip155:84532', 'USDC')!;
    const eurc = getEip712Domain('eip155:84532', 'EURC')!;
    expect(eurc.name).toBe('EURC');
    expect(eurc.verifyingContract).toBe(EURC_BASE_SEPOLIA);
    expect(eurc.chainId).toBe(84532);
    // Distinct from USDC on the signing-relevant fields.
    expect(eurc.name).not.toBe(usdc.name);
    expect(eurc.verifyingContract).not.toBe(usdc.verifyingContract);
  });

  it('[happy] should produce EURC domain on Base Sepolia', () => {
    const eurc = getEip712Domain('eip155:84532', 'EURC')!;
    expect(eurc.name).toBe('EURC');
    expect(eurc.verifyingContract).toBe(EURC_BASE_SEPOLIA);
    expect(eurc.chainId).toBe(84532);
  });

  it('[boundary] should return undefined for EURC mainnet without an override', () => {
    // No public-registry mainnet address → no domain unless the operator injects one.
    expect(getEip712Domain('eip155:8453', 'EURC')).toBeUndefined();
  });

  it('[happy] should produce an EURC mainnet domain from an injected override address', () => {
    const eurc = getEip712Domain('eip155:8453', 'EURC', EURC_MAINNET_OVERRIDE)!;
    expect(eurc.name).toBe('EURC');
    expect(eurc.verifyingContract).toBe(EURC_MAINNET_OVERRIDE);
    expect(eurc.chainId).toBe(8453);
  });

  it('[error] should return undefined for an unknown token', () => {
    expect(getEip712Domain('eip155:8453', 'DOGE')).toBeUndefined();
  });

  it('[edge] should return undefined for an unsupported network', () => {
    expect(getEip712Domain('eip155:1', 'USDC')).toBeUndefined();
    expect(getEip712Domain('eip155:1', 'EURC')).toBeUndefined();
  });
});

// --- pay({ token }) integration coverage ---

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

describe('pay({ token })', () => {
  const mockFetch = vi.fn();
  let client: PayBotClient;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    client = new PayBotClient({
      apiKey: 'pb_test_key',
      botId: 'token-bot',
      facilitatorUrl: 'https://api.test.com',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[boundary] should fail TOKEN_ADDRESS_NOT_CONFIGURED for EURC mainnet without an override', async () => {
    const result = await client.pay({
      resource: 'https://example.com',
      amount: '0.05',
      payTo: '0x0000000000000000000000000000000000000001',
      network: 'eip155:8453',
      token: 'EURC',
    });

    // EURC mainnet is operator-private — absent from the public registry and no
    // override supplied, so the SDK must refuse rather than sign a wrong address.
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('TOKEN_ADDRESS_NOT_CONFIGURED');
    expect(result.error).toContain('tokenAddressOverrides');
    // No network round-trip should have happened.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('[happy] should use an operator-injected EURC mainnet address via tokenAddressOverrides', async () => {
    const overrideClient = new PayBotClient({
      apiKey: 'pb_test_key',
      botId: 'token-bot-override',
      facilitatorUrl: 'https://api.test.com',
      tokenAddressOverrides: { EURC: { 'eip155:8453': EURC_MAINNET_OVERRIDE } },
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ valid: true, settlementToken: 'st_eurc', commission: {} })
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, transaction: '0xeurc' }));

    const result = await overrideClient.pay({
      resource: 'https://example.com',
      amount: '0.05',
      payTo: '0x0000000000000000000000000000000000000001',
      network: 'eip155:8453',
      token: 'EURC',
    });

    expect(result.success).toBe(true);
    const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(verifyCall.requirements.asset).toBe(`eip155:8453/erc20:${EURC_MAINNET_OVERRIDE}`);
    // 6-decimal conversion still applies for EURC.
    expect(verifyCall.requirements.amount).toBe('50000');
  });

  it('[happy] should resolve EURC testnet from the public registry (no override needed)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ valid: true, settlementToken: 'st_eurc_t', commission: {} })
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, transaction: '0xeurct' }));

    const result = await client.pay({
      resource: 'https://example.com',
      amount: '0.05',
      payTo: '0x0000000000000000000000000000000000000001',
      network: 'eip155:84532',
      token: 'EURC',
    });

    expect(result.success).toBe(true);
    const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(verifyCall.requirements.asset).toBe(`eip155:84532/erc20:${EURC_BASE_SEPOLIA}`);
  });

  it('[happy] should sign against the EURC domain when token:EURC + walletPrivateKey', async () => {
    const signingClient = new PayBotClient({
      apiKey: 'pb_test_key',
      botId: 'sign-eurc',
      facilitatorUrl: 'https://api.test.com',
      walletPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      maxRetries: 0,
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ valid: true, settlementToken: 'st_s', commission: {} })
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, transaction: '0xt' }));

    const result = await signingClient.pay({
      resource: 'https://example.com',
      amount: '0.01',
      payTo: '0x0000000000000000000000000000000000000001',
      network: 'eip155:84532',
      token: 'EURC',
    });

    expect(result.success).toBe(true);
    const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const signed = JSON.parse(verifyCall.payload.payload);
    // A real EIP-3009 signature was produced (mock-format only fires without a key).
    expect(signed.signature).toMatch(/^0x[a-fA-F0-9]+$/);
    expect(signed.value).toBe('10000');
    // Asset uses the EURC Sepolia address.
    expect(verifyCall.requirements.asset).toBe(`eip155:84532/erc20:${EURC_BASE_SEPOLIA}`);
  });

  it('[error] should return UNSUPPORTED_TOKEN for an unknown token', async () => {
    const result = await client.pay({
      resource: 'https://example.com',
      amount: '0.05',
      payTo: '0x0000000000000000000000000000000000000001',
      network: 'eip155:8453',
      token: 'DOGE',
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('UNSUPPORTED_TOKEN');
    expect(result.error).toContain('DOGE');
    // No network round-trip should have happened.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('[edge/default] should default to USDC (existing behavior) when no token given', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ valid: true, settlementToken: 'st_d', commission: {} })
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

    await client.pay({
      resource: 'https://example.com',
      amount: '1.00',
      payTo: '0x0000000000000000000000000000000000000001',
      network: 'eip155:8453',
    });

    const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(verifyCall.requirements.asset).toBe(`eip155:8453/erc20:${USDC_BASE_MAINNET}`);
  });

  it('[edge] explicit tokenContract should still override the resolved token address', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ valid: true, settlementToken: 'st_o', commission: {} })
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

    await client.pay({
      resource: 'https://example.com',
      amount: '1.00',
      payTo: '0x0000000000000000000000000000000000000001',
      network: 'eip155:8453',
      token: 'EURC',
      tokenContract: '0xOverride',
    });

    const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(verifyCall.requirements.asset).toBe('eip155:8453/erc20:0xOverride');
  });
});
