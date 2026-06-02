/**
 * Supported blockchain network configurations for PayBot.
 *
 * Mainnets: Base (8453), Optimism (10), Arbitrum One (42161), Polygon PoS (137).
 * Testnet: Base Sepolia (84532).
 *
 * RPC URLs are sensible public defaults; callers may override per network when
 * constructing their own clients (e.g. to use a private/rate-limited endpoint).
 */

import { PayBotApiError } from './errors.js';

export interface NetworkConfig {
  readonly name: string;
  readonly chainId: number;
  readonly caip2: string;
  readonly rpcUrl: string;
  readonly usdcAddress: string;
  readonly explorerUrl: string;
  readonly isTestnet: boolean;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  'eip155:8453': {
    name: 'Base Mainnet',
    chainId: 8453,
    caip2: 'eip155:8453',
    rpcUrl: 'https://mainnet.base.org',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorerUrl: 'https://basescan.org',
    isTestnet: false,
  },
  'eip155:84532': {
    name: 'Base Sepolia',
    chainId: 84532,
    caip2: 'eip155:84532',
    rpcUrl: 'https://sepolia.base.org',
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorerUrl: 'https://sepolia.basescan.org',
    isTestnet: true,
  },
  'eip155:10': {
    name: 'Optimism',
    chainId: 10,
    caip2: 'eip155:10',
    rpcUrl: 'https://mainnet.optimism.io',
    // Native USDC on OP Mainnet (Circle).
    // Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    explorerUrl: 'https://optimistic.etherscan.io',
    isTestnet: false,
  },
  'eip155:42161': {
    name: 'Arbitrum One',
    chainId: 42161,
    caip2: 'eip155:42161',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    // Native USDC on Arbitrum One (Circle).
    // Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    explorerUrl: 'https://arbiscan.io',
    isTestnet: false,
  },
  'eip155:137': {
    name: 'Polygon PoS',
    chainId: 137,
    caip2: 'eip155:137',
    rpcUrl: 'https://polygon-rpc.com',
    // Native USDC on Polygon PoS (Circle).
    // Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
    usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    explorerUrl: 'https://polygonscan.com',
    isTestnet: false,
  },
} as const;

/**
 * USDC token configuration shared across networks.
 *
 * Kept exported for back-compat. The multi-token registry below ({@link TOKENS})
 * supersedes it for new code; this is the legacy single-token view.
 */
export const USDC_CONFIG = {
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
} as const;

/**
 * Configuration for a single fungible token the SDK can pay with.
 *
 * The split between {@link TokenConfig.name} and {@link TokenConfig.eip712Name}
 * is deliberate and load-bearing for signing:
 *
 *   - `name` is the **human-readable** token name (e.g. "USD Coin").
 *   - `eip712Name` is the **on-chain EIP-712 domain name** the token's contract
 *     actually uses in its `DOMAIN_SEPARATOR` (e.g. USDC contracts sign as the
 *     literal string `"USDC"`, NOT "USD Coin"). This string is what gets hashed
 *     into the signature, so it MUST match the deployed contract byte-for-byte
 *     or every signature will be rejected.
 *
 * When `eip712Name` is omitted, {@link getEip712Domain} falls back to `name`.
 */
export interface TokenConfig {
  /** Token ticker symbol, used as the registry key (e.g. `'USDC'`, `'EURC'`). */
  readonly symbol: string;
  /** Number of base-unit decimals (USDC/EURC use 6; DAI uses 18). */
  readonly decimals: number;
  /** Human-readable token name (e.g. `'USD Coin'`). NOT necessarily the EIP-712 name. */
  readonly name: string;
  /**
   * The on-chain EIP-712 domain `name` the token contract signs under. Defaults
   * to {@link TokenConfig.name} when absent. For USDC this is `'USDC'` (the
   * deployed Circle contract's domain name), distinct from the display name.
   */
  readonly eip712Name?: string;
  /** Whether the token is MiCA-compliant (EU Markets in Crypto-Assets). */
  readonly micaCompliant: boolean;
  /** Map of CAIP-2 network id → the token's ERC-20 contract address on that network. */
  readonly addressByNetwork: Record<string, string>;
}

/**
 * Registry of supported tokens, keyed by ticker symbol.
 *
 * Every address below is the OFFICIAL issuer deployment for that (token, network)
 * pair, cited inline with its source URL. A wrong token contract address routes
 * real funds to the wrong contract, so only pairs verifiable from an official
 * issuer source are listed; unverifiable pairs are deliberately omitted.
 *
 * Coverage notes (as of the T2.1/T2.2 expansion):
 *   - USDC: native (Circle) on Base, Base Sepolia, Optimism, Arbitrum One, Polygon.
 *   - EURC: Circle deploys native EURC on Base/Base Sepolia (and Ethereum, Solana,
 *     Avalanche) but NOT on Optimism / Arbitrum / Polygon — so EURC is omitted
 *     on those three L2s.
 *   - DAI: MakerDAO/Sky canonical deployments on Optimism, Arbitrum One, Polygon
 *     (and Base). DAI is crypto-collateralized, NOT an authorized EU EMT →
 *     `micaCompliant: false`.
 *   - PYUSD (Paxos) and RLUSD (Ripple) are NOT deployed on any network currently
 *     in this registry (PYUSD: Ethereum + Solana; RLUSD: Ethereum + XRPL), so they
 *     are intentionally absent rather than added with empty/guessed addresses.
 */
export const TOKENS: Record<string, TokenConfig> = {
  USDC: {
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
    // USDC contracts sign their EIP-712 domain as the literal "USDC".
    eip712Name: 'USDC',
    micaCompliant: true,
    addressByNetwork: {
      // Reuses NETWORKS[...].usdcAddress — keep identical, do not diverge.
      // All native USDC (Circle).
      // Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
      'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      'eip155:10': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      'eip155:42161': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      'eip155:137': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    },
  },
  EURC: {
    symbol: 'EURC',
    decimals: 6,
    name: 'EURC',
    eip712Name: 'EURC',
    micaCompliant: true,
    addressByNetwork: {
      // Circle native EURC. Only deployed on Base + Base Sepolia among the
      // networks in this registry — NOT on Optimism/Arbitrum/Polygon.
      // Source: https://developers.circle.com/stablecoins/eurc-contract-addresses
      'eip155:8453': '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
      'eip155:84532': '0x808456652fdb597867f38412077A9182bf77359F',
    },
  },
  DAI: {
    symbol: 'DAI',
    decimals: 18,
    name: 'Dai Stablecoin',
    // DAI contracts sign their EIP-712 domain as the literal "Dai Stablecoin".
    eip712Name: 'Dai Stablecoin',
    // DAI is crypto-collateralized (MakerDAO/Sky), not an EU-authorized EMT.
    micaCompliant: false,
    addressByNetwork: {
      // MakerDAO/Sky canonical DAI deployments (bridged).
      // Source: https://docs.makerdao.com/ + chain-native bridge deployments.
      // Optimism + Arbitrum share the canonical bridged-DAI address.
      'eip155:10': '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      'eip155:42161': '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      'eip155:137': '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    },
  },
} as const;

/**
 * Look up a token's full configuration by symbol.
 *
 * @param symbol - The token ticker (e.g. `'USDC'`, `'EURC'`). Case-sensitive.
 * @returns The {@link TokenConfig}, or `undefined` when the symbol is unknown.
 *
 * @example
 *   getToken('USDC')?.decimals; // 6
 *   getToken('DOGE');           // undefined
 */
export function getToken(symbol: string): TokenConfig | undefined {
  return TOKENS[symbol];
}

/**
 * Resolve a token's ERC-20 contract address on a specific network.
 *
 * @param symbol - The token ticker (e.g. `'USDC'`).
 * @param network - The CAIP-2 network id (e.g. `'eip155:8453'`).
 * @returns The contract address, or `undefined` when either the token is
 *          unknown OR the token is not deployed on that network.
 *
 * @example
 *   getTokenAddress('EURC', 'eip155:8453'); // '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42'
 *   getTokenAddress('USDC', 'eip155:1');    // undefined (not deployed here)
 *   getTokenAddress('DOGE', 'eip155:8453'); // undefined (unknown token)
 */
export function getTokenAddress(symbol: string, network: string): string | undefined {
  return TOKENS[symbol]?.addressByNetwork[network];
}

/**
 * List the ticker symbols of all tokens in the registry.
 *
 * @returns An array of supported token symbols (e.g. `['USDC', 'EURC']`).
 *
 * @example
 *   getSupportedTokens(); // ['USDC', 'EURC']
 */
export function getSupportedTokens(): string[] {
  return Object.keys(TOKENS);
}

/**
 * Build the EIP-712 domain for signing an EIP-3009 `TransferWithAuthorization`
 * for a given token on a given network.
 *
 * The domain is token-specific: USDC signs as `name: 'USDC'` at the USDC
 * contract address; EURC signs as `name: 'EURC'` at the EURC contract address.
 * This is the multi-token generalization of the legacy {@link EIP712_DOMAINS}
 * table (which only ever held USDC).
 *
 * REGRESSION GUARANTEE: for `symbol === 'USDC'` this returns a domain
 * byte-identical to `EIP712_DOMAINS[network]` (same `name`, `version`,
 * `chainId`, `verifyingContract`), so existing USDC signatures are unchanged.
 *
 * @param network - The CAIP-2 network id (e.g. `'eip155:8453'`).
 * @param symbol - The token ticker (default `'USDC'`).
 * @returns The EIP-712 domain, or `undefined` when the token is unknown OR the
 *          token has no address / no network entry for `network`.
 *
 * @example
 *   getEip712Domain('eip155:8453', 'USDC');
 *   // { name: 'USDC', version: '2', chainId: 8453, verifyingContract: '0x8335...' }
 *   getEip712Domain('eip155:8453', 'EURC');
 *   // { name: 'EURC', version: '2', chainId: 8453, verifyingContract: '0x60a3...' }
 *   getEip712Domain('eip155:8453', 'DOGE'); // undefined
 */
export function getEip712Domain(
  network: string,
  symbol = 'USDC',
): { name: string; version: string; chainId: number; verifyingContract: `0x${string}` } | undefined {
  const token = TOKENS[symbol];
  if (!token) {
    return undefined;
  }
  const verifyingContract = token.addressByNetwork[network];
  const networkConfig = NETWORKS[network];
  if (!verifyingContract || !networkConfig) {
    return undefined;
  }
  return {
    name: token.eip712Name ?? token.name,
    version: '2',
    chainId: networkConfig.chainId,
    verifyingContract: verifyingContract as `0x${string}`,
  };
}

/**
 * Get network config by CAIP-2 identifier.
 */
export function getNetwork(caip2: string): NetworkConfig | undefined {
  return NETWORKS[caip2];
}

/**
 * Get all supported network CAIP-2 identifiers.
 */
export function getSupportedNetworks(): string[] {
  return Object.keys(NETWORKS);
}

/**
 * Parsed components of a CAIP-2 chain identifier.
 *
 * @see https://chainagnostic.org/CAIPs/caip-2
 */
export interface Caip2 {
  /** CAIP-2 namespace (e.g. `eip155` for EVM chains). */
  namespace: string;
  /** CAIP-2 reference (e.g. `8453` — the EVM chain id). */
  reference: string;
}

/**
 * Parse a CAIP-2 identifier of the form `eip155:<chainId>` into its
 * `{ namespace, reference }` parts.
 *
 * Validates the x402-relevant `eip155` shape: the namespace MUST be `eip155`
 * and the reference MUST be a non-empty run of digits (an EVM chain id). The
 * generic CAIP-2 grammar allows other namespaces, but x402 networks are EVM
 * chains, so this helper is intentionally strict — anything else is rejected
 * rather than silently passed through.
 *
 * @param id - The CAIP-2 string to parse (e.g. `'eip155:8453'`).
 * @returns The parsed `{ namespace, reference }`.
 * @throws {PayBotApiError} code `INVALID_CAIP2` (HTTP 400) when `id` is not a
 *          well-formed `eip155:<digits>` identifier.
 *
 * @example
 *   parseCaip2('eip155:8453'); // { namespace: 'eip155', reference: '8453' }
 *   parseCaip2('solana:foo');  // throws PayBotApiError INVALID_CAIP2
 */
export function parseCaip2(id: string): Caip2 {
  if (typeof id !== 'string' || id.length === 0) {
    throw new PayBotApiError(
      `Invalid CAIP-2 identifier: expected a non-empty string, got ${typeof id}`,
      'INVALID_CAIP2',
      400,
    );
  }

  // Strict eip155:<chainId> shape. Reject extra colons, empty parts, and
  // non-digit references. (Generic CAIP-2 permits more, but x402 is EVM-only.)
  const match = /^(eip155):(\d+)$/.exec(id);
  if (!match) {
    throw new PayBotApiError(
      `Invalid CAIP-2 identifier: '${id}' is not a well-formed eip155:<chainId>`,
      'INVALID_CAIP2',
      400,
      { id },
    );
  }

  return { namespace: match[1], reference: match[2] };
}

/**
 * Test whether a CAIP-2 identifier is both well-formed AND maps to a network
 * this SDK actually supports (present in {@link NETWORKS}).
 *
 * Never throws — malformed input simply returns `false`. Use
 * {@link parseCaip2} when you want a hard error on malformed input.
 *
 * @param id - The CAIP-2 string to check.
 * @returns `true` if `id` is a supported, well-formed CAIP-2 network id.
 *
 * @example
 *   isSupportedCaip2('eip155:8453');   // true  (Base Mainnet)
 *   isSupportedCaip2('eip155:1');      // false (well-formed but unsupported)
 *   isSupportedCaip2('not-a-caip2');   // false (malformed)
 */
export function isSupportedCaip2(id: string): boolean {
  try {
    parseCaip2(id);
  } catch {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(NETWORKS, id);
}

/**
 * EIP-712 domain separators for USDC contracts.
 * Used for EIP-3009 transferWithAuthorization signature verification.
 */
export const EIP712_DOMAINS: Record<string, { name: string; version: string; chainId: number; verifyingContract: `0x${string}` }> = {
  'eip155:84532': {
    name: 'USDC',
    version: '2',
    chainId: 84532,
    verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  'eip155:8453': {
    name: 'USDC',
    version: '2',
    chainId: 8453,
    verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  'eip155:10': {
    name: 'USDC',
    version: '2',
    chainId: 10,
    verifyingContract: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  'eip155:42161': {
    name: 'USDC',
    version: '2',
    chainId: 42161,
    verifyingContract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  'eip155:137': {
    name: 'USDC',
    version: '2',
    chainId: 137,
    verifyingContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
} as const;

/**
 * EIP-3009 TransferWithAuthorization typed data definition.
 * Used for viem's signTypedData / verifyTypedData.
 */
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;
