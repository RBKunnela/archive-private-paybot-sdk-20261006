/**
 * @module cli/config
 *
 * Pure helpers for the `paybot` CLI: configuration resolution, secret masking,
 * and the formatters for the `networks` / `tokens` commands.
 *
 * Everything in this module is side-effect-free and network-free so it can be
 * unit-tested in isolation. The thin command wiring (process.env, process.exit,
 * console, and the live PayBotClient) lives in `cli/index.ts`.
 *
 * Dependencies: ../networks.js (registry read-only).
 * Used by: cli/index.ts, tests/cli.test.ts
 */

import {
  NETWORKS,
  TOKENS,
  getSupportedNetworks,
  getSupportedTokens,
} from '../networks.js';
import type { TrustLevel } from '../types.js';

/**
 * The subset of environment variables the CLI reads.
 *
 * Kept as an explicit interface (rather than reaching into `process.env`
 * directly) so config resolution is a pure function of its inputs and can be
 * tested without mutating global state.
 */
export interface CliEnv {
  PAYBOT_API_KEY?: string;
  PAYBOT_BOT_ID?: string;
  WALLET_PRIVATE_KEY?: string;
  PAYBOT_FACILITATOR_URL?: string;
}

/**
 * Flag-level overrides for config resolution. Flags win over env.
 */
export interface CliConfigFlags {
  apiKey?: string;
  botId?: string;
  walletPrivateKey?: string;
  facilitatorUrl?: string;
}

/**
 * The fully-resolved config a command needs to build a PayBotClient.
 *
 * `apiKey` and `botId` are required; the optional fields are passed through to
 * PayBotConfig only when present.
 */
export interface ResolvedCliConfig {
  apiKey: string;
  botId: string;
  walletPrivateKey?: string;
  facilitatorUrl?: string;
}

/**
 * Error thrown when a required config value (apiKey / botId) cannot be resolved
 * from flags or environment. Carries a human-friendly, actionable message.
 */
export class CliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliConfigError';
  }
}

/**
 * Mask a secret for display, keeping only a short prefix and suffix.
 *
 * Used for any api key / private key the CLI echoes back so a full secret never
 * lands in terminal output, logs, or CI artifacts.
 *
 * Short or empty secrets collapse to a fixed placeholder rather than leaking a
 * recognizable fraction of their characters.
 *
 * @param secret - The secret string to mask (may be undefined).
 * @param visible - Characters to keep at each end (default 4).
 * @returns A masked string like `pb_t…cdef`, or `***` when there is nothing
 *          safe to reveal.
 *
 * @example
 *   maskSecret('pb_test_abcdef123456'); // 'pb_t…3456'
 *   maskSecret('0xshort');              // '***'
 *   maskSecret(undefined);              // '***'
 */
export function maskSecret(secret: string | undefined, visible = 4): string {
  if (!secret || typeof secret !== 'string') {
    return '***';
  }
  // Need at least prefix + suffix + 1 hidden char to mask without overlap.
  if (secret.length <= visible * 2 + 1) {
    return '***';
  }
  const prefix = secret.slice(0, visible);
  const suffix = secret.slice(-visible);
  return `${prefix}…${suffix}`;
}

/**
 * Resolve CLI config with precedence: flags > environment > error.
 *
 * `apiKey` and `botId` are mandatory; the wallet key and facilitator URL are
 * optional and only included in the result when supplied. On a missing required
 * value a {@link CliConfigError} is thrown with a message naming both the flag
 * and the env var the user can set.
 *
 * @param flags - Command-line flag overrides (highest precedence).
 * @param env - The environment slice (typically `process.env`).
 * @returns The resolved config ready to construct a PayBotClient.
 * @throws {CliConfigError} when apiKey or botId cannot be resolved.
 *
 * @example
 *   resolveConfig({ botId: 'b' }, { PAYBOT_API_KEY: 'k' });
 *   // { apiKey: 'k', botId: 'b' }
 */
export function resolveConfig(
  flags: CliConfigFlags,
  env: CliEnv,
): ResolvedCliConfig {
  const apiKey = flags.apiKey ?? env.PAYBOT_API_KEY;
  const botId = flags.botId ?? env.PAYBOT_BOT_ID;
  const walletPrivateKey = flags.walletPrivateKey ?? env.WALLET_PRIVATE_KEY;
  const facilitatorUrl = flags.facilitatorUrl ?? env.PAYBOT_FACILITATOR_URL;

  if (!apiKey) {
    throw new CliConfigError(
      'Missing API key. Pass --api-key <key> or set the PAYBOT_API_KEY environment variable.',
    );
  }
  if (!botId) {
    throw new CliConfigError(
      'Missing bot id. Pass --bot-id <id> or set the PAYBOT_BOT_ID environment variable.',
    );
  }

  const resolved: ResolvedCliConfig = { apiKey, botId };
  if (walletPrivateKey) resolved.walletPrivateKey = walletPrivateKey;
  if (facilitatorUrl) resolved.facilitatorUrl = facilitatorUrl;
  return resolved;
}

/**
 * Parse a trust-level flag string into the 0–5 integer the SDK expects.
 *
 * @param raw - The raw flag value (e.g. `'2'`), or undefined when unset.
 * @returns The parsed trust level, or `undefined` when `raw` is undefined.
 * @throws {CliConfigError} when `raw` is present but not an integer in 0–5.
 *
 * @example
 *   parseTrustLevel('3');       // 3
 *   parseTrustLevel(undefined); // undefined
 *   parseTrustLevel('9');       // throws CliConfigError
 */
export function parseTrustLevel(raw: string | undefined): TrustLevel | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new CliConfigError(`Invalid --trust-level: '${raw}' must be an integer 0-5.`);
  }
  const n = Number(raw);
  if (n < 0 || n > 5) {
    throw new CliConfigError(`Invalid --trust-level: ${n} is out of range (0-5).`);
  }
  return n as TrustLevel;
}

/**
 * Format the supported networks as plain text lines: `CAIP-2  Name`.
 *
 * Reads the registry directly so the CLI output always tracks `src/networks.ts`.
 *
 * @returns One line per supported network, newline-joined.
 *
 * @example
 *   formatNetworks();
 *   // 'eip155:8453   Base Mainnet\neip155:84532  Base Sepolia (testnet)\n...'
 */
export function formatNetworks(): string {
  const ids = getSupportedNetworks();
  const width = Math.max(...ids.map((id) => id.length));
  return ids
    .map((id) => {
      const cfg = NETWORKS[id];
      const name = cfg ? cfg.name : id;
      const suffix = cfg?.isTestnet ? ' (testnet)' : '';
      return `${id.padEnd(width)}  ${name}${suffix}`;
    })
    .join('\n');
}

/**
 * Format the supported tokens (optionally for one network) as plain text.
 *
 * When `network` is given, only tokens deployed on that network are listed,
 * each annotated with its contract address.
 *
 * @param network - Optional CAIP-2 network id to filter by.
 * @returns One line per matching token, newline-joined; or a friendly notice
 *          when a network filter matches no tokens.
 *
 * @example
 *   formatTokens();                 // 'USDC  6 decimals\nEURC  6 decimals\nDAI   18 decimals'
 *   formatTokens('eip155:10');      // USDC + DAI with addresses (no EURC on OP)
 */
export function formatTokens(network?: string): string {
  const symbols = getSupportedTokens();
  const lines: string[] = [];
  const width = Math.max(...symbols.map((s) => s.length));

  for (const symbol of symbols) {
    const token = TOKENS[symbol];
    if (!token) continue;
    if (network) {
      const address = token.addressByNetwork[network];
      if (!address) continue; // not deployed on the requested network
      lines.push(`${symbol.padEnd(width)}  ${token.decimals} decimals  ${address}`);
    } else {
      lines.push(`${symbol.padEnd(width)}  ${token.decimals} decimals`);
    }
  }

  if (lines.length === 0) {
    return `No supported tokens on network ${network ?? '(any)'}.`;
  }
  return lines.join('\n');
}
