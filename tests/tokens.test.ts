import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TOKENS,
  USDC_CONFIG,
  getToken,
  getTokenAddress,
  getSupportedTokens,
  getEip712Domain,
  EIP712_DOMAINS,
  NETWORKS,
} from '../src/networks.js';
import { PayBotClient } from '../src/client.js';

// Official Circle EURC deployments seeded by the token registry (T2.2).
const EURC_BASE_MAINNET = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
const EURC_BASE_SEPOLIA = '0x808456652fdb597867f38412077A9182bf77359F';
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// T2.1/T2.2 expansion — native USDC on the new L2 mainnets (Circle).
const USDC_OPTIMISM = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const USDC_ARBITRUM = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
// Canonical DAI (MakerDAO/Sky).
const DAI_OPTIMISM = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1';
const DAI_ARBITRUM = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1';
const DAI_POLYGON = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';

describe('TOKENS registry', () => {
  it('should include USDC, EURC and DAI', () => {
    expect(getSupportedTokens()).toEqual(expect.arrayContaining(['USDC', 'EURC', 'DAI']));
    expect(getSupportedTokens().length).toBe(3);
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
    expect(usdc!.micaCompliant).toBe(true);
  });

  it('[happy] should return EURC config', () => {
    const eurc = getToken('EURC');
    expect(eurc).toBeDefined();
    expect(eurc!.symbol).toBe('EURC');
    expect(eurc!.decimals).toBe(6);
    expect(eurc!.name).toBe('EURC');
    expect(eurc!.micaCompliant).toBe(true);
  });

  it('[happy] should return DAI config (18 decimals, not MiCA)', () => {
    const dai = getToken('DAI');
    expect(dai).toBeDefined();
    expect(dai!.symbol).toBe('DAI');
    expect(dai!.decimals).toBe(18);
    expect(dai!.name).toBe('Dai Stablecoin');
    expect(dai!.eip712Name).toBe('Dai Stablecoin');
    expect(dai!.micaCompliant).toBe(false);
  });

  it('[error/edge] should return undefined for an unknown symbol', () => {
    expect(getToken('DOGE')).toBeUndefined();
    expect(getToken('')).toBeUndefined();
    // PYUSD and RLUSD are intentionally NOT in the registry (no deployment on any
    // supported network) — they must resolve to undefined, not a guessed entry.
    expect(getToken('PYUSD')).toBeUndefined();
    expect(getToken('RLUSD')).toBeUndefined();
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

  it('[happy] should resolve USDC on every new L2 mainnet (T2.1)', () => {
    expect(getTokenAddress('USDC', 'eip155:10')).toBe(USDC_OPTIMISM);
    expect(getTokenAddress('USDC', 'eip155:42161')).toBe(USDC_ARBITRUM);
    expect(getTokenAddress('USDC', 'eip155:137')).toBe(USDC_POLYGON);
    // Registry address must equal the network config's usdcAddress (no divergence).
    expect(getTokenAddress('USDC', 'eip155:10')).toBe(NETWORKS['eip155:10'].usdcAddress);
    expect(getTokenAddress('USDC', 'eip155:42161')).toBe(NETWORKS['eip155:42161'].usdcAddress);
    expect(getTokenAddress('USDC', 'eip155:137')).toBe(NETWORKS['eip155:137'].usdcAddress);
  });

  it('[happy] should resolve EURC per network', () => {
    expect(getTokenAddress('EURC', 'eip155:8453')).toBe(EURC_BASE_MAINNET);
    expect(getTokenAddress('EURC', 'eip155:84532')).toBe(EURC_BASE_SEPOLIA);
  });

  it('[edge] EURC is NOT deployed on the new L2s — must resolve undefined', () => {
    // Circle does not deploy native EURC on Optimism/Arbitrum/Polygon.
    expect(getTokenAddress('EURC', 'eip155:10')).toBeUndefined();
    expect(getTokenAddress('EURC', 'eip155:42161')).toBeUndefined();
    expect(getTokenAddress('EURC', 'eip155:137')).toBeUndefined();
  });

  it('[happy] should resolve DAI on each network it is deployed to (T2.2)', () => {
    expect(getTokenAddress('DAI', 'eip155:10')).toBe(DAI_OPTIMISM);
    expect(getTokenAddress('DAI', 'eip155:42161')).toBe(DAI_ARBITRUM);
    expect(getTokenAddress('DAI', 'eip155:137')).toBe(DAI_POLYGON);
  });

  it('[edge] DAI is NOT registered on Base/Base Sepolia — must resolve undefined', () => {
    expect(getTokenAddress('DAI', 'eip155:8453')).toBeUndefined();
    expect(getTokenAddress('DAI', 'eip155:84532')).toBeUndefined();
  });

  it('[error] should return undefined for unknown token', () => {
    expect(getTokenAddress('DOGE', 'eip155:8453')).toBeUndefined();
  });

  it('[edge] should return undefined for unsupported network on a known token', () => {
    expect(getTokenAddress('USDC', 'eip155:1')).toBeUndefined();
    expect(getTokenAddress('EURC', 'eip155:1')).toBeUndefined();
    expect(getTokenAddress('DAI', 'eip155:1')).toBeUndefined();
  });
});

describe('getSupportedTokens', () => {
  it('should return all registry symbols', () => {
    const tokens = getSupportedTokens();
    expect(tokens).toContain('USDC');
    expect(tokens).toContain('EURC');
  });
});

describe('micaCompliant flags', () => {
  it('should mark USDC and EURC MiCA-compliant, DAI NOT compliant', () => {
    expect(TOKENS.USDC.micaCompliant).toBe(true);
    expect(TOKENS.EURC.micaCompliant).toBe(true);
    // DAI is crypto-collateralized, not an EU-authorized EMT.
    expect(TOKENS.DAI.micaCompliant).toBe(false);
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

  it('[happy] should produce a DISTINCT EURC domain (different name + verifyingContract)', () => {
    const usdc = getEip712Domain('eip155:8453', 'USDC')!;
    const eurc = getEip712Domain('eip155:8453', 'EURC')!;
    expect(eurc.name).toBe('EURC');
    expect(eurc.verifyingContract).toBe(EURC_BASE_MAINNET);
    expect(eurc.chainId).toBe(8453);
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

  it('[happy/regression] should produce the legacy USDC domain on each new L2 mainnet', () => {
    for (const network of ['eip155:10', 'eip155:42161', 'eip155:137'] as const) {
      const domain = getEip712Domain(network, 'USDC')!;
      expect(domain).toEqual(EIP712_DOMAINS[network]);
      expect(domain.name).toBe('USDC');
      expect(domain.chainId).toBe(NETWORKS[network].chainId);
      expect(domain.verifyingContract).toBe(NETWORKS[network].usdcAddress);
    }
  });

  it('[happy] should produce a DAI domain (name "Dai Stablecoin") where DAI is deployed', () => {
    const dai = getEip712Domain('eip155:10', 'DAI')!;
    expect(dai.name).toBe('Dai Stablecoin');
    expect(dai.verifyingContract).toBe(DAI_OPTIMISM);
    expect(dai.chainId).toBe(10);
  });

  it('[edge] should return undefined for DAI on a network where it is not registered', () => {
    // DAI is not registered on Base, even though Base is a supported network.
    expect(getEip712Domain('eip155:8453', 'DAI')).toBeUndefined();
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

  it('[happy] should use the EURC address in requirements.asset when token:EURC', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ valid: true, settlementToken: 'st_eurc', commission: {} })
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, transaction: '0xeurc' }));

    const result = await client.pay({
      resource: 'https://example.com',
      amount: '0.05',
      payTo: '0x0000000000000000000000000000000000000001',
      network: 'eip155:8453',
      token: 'EURC',
    });

    expect(result.success).toBe(true);
    const verifyCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(verifyCall.requirements.asset).toBe(`eip155:8453/erc20:${EURC_BASE_MAINNET}`);
    // 6-decimal conversion still applies for EURC.
    expect(verifyCall.requirements.amount).toBe('50000');
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
