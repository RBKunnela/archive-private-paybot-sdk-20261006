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
 */
export const USDC_CONFIG = {
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
} as const;

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
