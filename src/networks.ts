/**
 * Supported blockchain network configurations for PayBot.
 * PoC supports Base Sepolia (testnet) and Base Mainnet.
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
  /** Number of base-unit decimals (USDC and EURC both use 6). */
  readonly decimals: number;
  /** Human-readable token name (e.g. `'USD Coin'`). NOT necessarily the EIP-712 name. */
  readonly name: string;
  /**
   * The on-chain EIP-712 domain `name` the token contract signs under. Defaults
   * to {@link TokenConfig.name} when absent. For USDC this is `'USDC'` (the
   * deployed Circle contract's domain name), distinct from the display name.
   */
  readonly eip712Name?: string;
  /**
   * Map of CAIP-2 network id → the token's ERC-20 contract address on that
   * network. This public registry intentionally carries only the addresses that
   * are safe to ship open-core (e.g. testnet deployments). Mainnet addresses for
   * regulated tokens are resolved at runtime from the operator layer via
   * {@link PayBotConfig.tokenAddressOverrides} — never hardcoded here.
   */
  readonly addressByNetwork: Record<string, string>;
}

/**
 * Registry of supported tokens, keyed by ticker symbol.
 *
 * Addresses are reused from / kept in sync with the per-network `usdcAddress`
 * for USDC (do not diverge). EURC addresses are Circle's official deployments.
 */
export const TOKENS: Record<string, TokenConfig> = {
  USDC: {
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
    // USDC contracts sign their EIP-712 domain as the literal "USDC".
    eip712Name: 'USDC',
    addressByNetwork: {
      // Reuses NETWORKS[...].usdcAddress — keep identical, do not diverge.
      'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
  },
  EURC: {
    symbol: 'EURC',
    decimals: 6,
    name: 'EURC',
    eip712Name: 'EURC',
    addressByNetwork: {
      // Public open-core registry carries ONLY the Base Sepolia testnet
      // deployment. The EURC mainnet address is operator-private and must be
      // injected at runtime via PayBotConfig.tokenAddressOverrides — it is
      // deliberately NOT hardcoded here.
      'eip155:84532': '0x808456652fdb597867f38412077A9182bf77359F',
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
 *   getTokenAddress('EURC', 'eip155:84532'); // '0x...' (testnet deployment)
 *   getTokenAddress('USDC', 'eip155:1');     // undefined (not deployed here)
 *   getTokenAddress('DOGE', 'eip155:8453');  // undefined (unknown token)
 */
export function getTokenAddress(symbol: string, network: string): string | undefined {
  return TOKENS[symbol]?.addressByNetwork[network];
}

/**
 * Resolve a token's contract address with an optional operator override layer.
 *
 * Resolution precedence (first match wins):
 *   1. `overrides[symbol][network]` — operator-injected address (e.g. a mainnet
 *      deployment intentionally kept out of the public registry).
 *   2. The public {@link TOKENS} registry ({@link getTokenAddress}).
 *
 * Use this instead of {@link getTokenAddress} when an operator may supply
 * addresses at runtime via {@link PayBotConfig.tokenAddressOverrides}. The
 * helper is deliberately generic — it carries no token-specific or regulatory
 * data, only the symbol→network→address lookup.
 *
 * @param symbol - The token ticker (e.g. `'USDC'`, `'EURC'`).
 * @param network - The CAIP-2 network id (e.g. `'eip155:8453'`).
 * @param overrides - Optional operator-supplied `symbol → network → address` map.
 * @returns The resolved contract address, or `undefined` when neither the
 *          override map nor the public registry has an entry.
 *
 * @example
 *   resolveTokenAddress('EURC', 'eip155:8453');                 // undefined (not public)
 *   resolveTokenAddress('EURC', 'eip155:8453', {
 *     EURC: { 'eip155:8453': '0x...' },
 *   });                                                          // '0x...' (operator-injected)
 */
export function resolveTokenAddress(
  symbol: string,
  network: string,
  overrides?: Record<string, Record<string, string>>,
): string | undefined {
  const override = overrides?.[symbol]?.[network];
  if (override) {
    return override;
  }
  return getTokenAddress(symbol, network);
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
 * @param verifyingContractOverride - Optional contract address to sign against,
 *   used when the address is supplied at runtime by the operator layer (i.e. the
 *   token has no public-registry entry for `network`, such as EURC mainnet).
 *   When omitted, the address is taken from the public {@link TOKENS} registry.
 * @returns The EIP-712 domain, or `undefined` when the token is unknown, the
 *          network is unsupported, OR no contract address can be resolved
 *          (neither an override nor a public-registry entry).
 *
 * @example
 *   getEip712Domain('eip155:8453', 'USDC');
 *   // { name: 'USDC', version: '2', chainId: 8453, verifyingContract: '0x8335...' }
 *   getEip712Domain('eip155:84532', 'EURC');
 *   // { name: 'EURC', version: '2', chainId: 84532, verifyingContract: '0x...' }
 *   getEip712Domain('eip155:8453', 'EURC', '0x...'); // operator-injected mainnet address
 *   getEip712Domain('eip155:8453', 'DOGE');          // undefined
 */
export function getEip712Domain(
  network: string,
  symbol = 'USDC',
  verifyingContractOverride?: string,
): { name: string; version: string; chainId: number; verifyingContract: `0x${string}` } | undefined {
  const token = TOKENS[symbol];
  if (!token) {
    return undefined;
  }
  const verifyingContract = verifyingContractOverride ?? token.addressByNetwork[network];
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
