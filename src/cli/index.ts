#!/usr/bin/env node
/**
 * @module cli
 *
 * The `paybot` command-line interface — a thin idiomatic wrapper over
 * {@link PayBotClient}. It does NOT reimplement any payment logic; every command
 * resolves config, constructs a client, calls one client method, and prints the
 * result. Secrets are never printed in full (see {@link maskSecret}).
 *
 * Config precedence: flags > environment (PAYBOT_API_KEY, PAYBOT_BOT_ID,
 * WALLET_PRIVATE_KEY, PAYBOT_FACILITATOR_URL) > a helpful error.
 *
 * Dependencies: commander, ../client.js, ../networks.js, ./config.js
 * Used by: the `paybot` bin entry (dist/cli/index.js).
 */

import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { PayBotClient } from '../client.js';
import {
  CliConfigError,
  formatNetworks,
  formatTokens,
  maskSecret,
  parseTrustLevel,
  resolveConfig,
  type CliConfigFlags,
  type CliEnv,
} from './config.js';

/**
 * Build a PayBotClient from resolved config.
 *
 * Factored out so commands share one construction path and tests can reason
 * about it. Reads flags + env via {@link resolveConfig}.
 *
 * @param flags - Command-level config flags.
 * @param env - The environment slice (defaults to `process.env`).
 * @returns A constructed PayBotClient.
 * @throws {CliConfigError} when required config is missing.
 */
function buildClient(flags: CliConfigFlags, env: CliEnv = process.env): PayBotClient {
  const cfg = resolveConfig(flags, env);
  return new PayBotClient(cfg);
}

/**
 * Print a value as pretty JSON to stdout.
 *
 * @param value - Any JSON-serializable value.
 */
function printJson(value: unknown): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Build the commander program. Exposed for testing (so tests can inspect
 * registered commands and parse argv without spawning a process).
 *
 * @returns The configured commander {@link Command}.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('paybot')
    .description('PayBot CLI — USDC/x402 payments for bots, wrapping PayBotClient')
    .version('0.3.0');

  // Global config flags available on every subcommand.
  program
    .option('--api-key <key>', 'PayBot API key (or env PAYBOT_API_KEY)')
    .option('--bot-id <id>', 'Bot identifier (or env PAYBOT_BOT_ID)')
    .option('--facilitator-url <url>', 'Facilitator base URL (or env PAYBOT_FACILITATOR_URL)');

  /** Merge the program-level options with a subcommand's own options. */
  function mergedFlags(cmd: Command): CliConfigFlags {
    const opts = { ...program.opts(), ...cmd.opts() };
    return {
      apiKey: opts.apiKey as string | undefined,
      botId: opts.botId as string | undefined,
      facilitatorUrl: opts.facilitatorUrl as string | undefined,
      walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
    };
  }

  program
    .command('register')
    .description('Register this bot with the facilitator')
    .option('--bot-id <id>', 'Bot identifier (or env PAYBOT_BOT_ID)')
    .option('--trust-level <n>', 'Initial trust level (0-5)')
    .action(async (opts, cmd: Command) => {
      const flags = mergedFlags(cmd);
      if (opts.botId) flags.botId = opts.botId;
      const trustLevel = parseTrustLevel(opts.trustLevel as string | undefined);
      const client = buildClient(flags);
      const result = await client.register(trustLevel);
      printJson(result);
    });

  program
    .command('balance')
    .description('Show trust status and remaining budget for this bot')
    .option('--bot-id <id>', 'Bot identifier (or env PAYBOT_BOT_ID)')
    .action(async (opts, cmd: Command) => {
      const flags = mergedFlags(cmd);
      if (opts.botId) flags.botId = opts.botId;
      const client = buildClient(flags);
      printJson(await client.balance());
    });

  program
    .command('pay')
    .description('Pay for a resource via x402')
    .requiredOption('--resource <url>', 'Resource URL being paid for')
    .requiredOption('--amount <human>', "Human-readable amount, e.g. '0.05'")
    .requiredOption('--pay-to <0x>', 'Recipient wallet address')
    .option('--token <SYM>', 'Token ticker (default USDC)')
    .option('--network <caip2>', 'CAIP-2 network id (default eip155:84532)')
    .option('--idempotency-key <k>', 'Idempotency key for safe retries')
    .option('--bot-id <id>', 'Bot identifier (or env PAYBOT_BOT_ID)')
    .action(async (opts, cmd: Command) => {
      const flags = mergedFlags(cmd);
      if (opts.botId) flags.botId = opts.botId;
      const client = buildClient(flags);
      const result = await client.pay({
        resource: opts.resource as string,
        amount: opts.amount as string,
        payTo: opts.payTo as string,
        token: opts.token as string | undefined,
        network: opts.network as string | undefined,
        idempotencyKey: opts.idempotencyKey as string | undefined,
      });
      printJson(result);
    });

  program
    .command('health')
    .description('Check facilitator health')
    .action(async (_opts, cmd: Command) => {
      const client = buildClient(mergedFlags(cmd));
      printJson(await client.health());
    });

  program
    .command('networks')
    .description('List supported networks (CAIP-2 + name)')
    .action(() => {
      // eslint-disable-next-line no-console
      console.log(formatNetworks());
    });

  program
    .command('tokens')
    .description('List supported tokens (with MiCA flags)')
    .option('--network <caip2>', 'Filter to tokens deployed on this network')
    .action((opts: { network?: string }) => {
      // eslint-disable-next-line no-console
      console.log(formatTokens(opts.network));
    });

  return program;
}

/**
 * CLI entry point. Parses argv, runs the matched command, and maps errors to a
 * non-zero exit with a masked, helpful message (never leaking full secrets).
 *
 * @param argv - Process argv (defaults to `process.argv`).
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Defensive: scrub any wallet/api key that an upstream error might echo.
    const apiKey = process.env.PAYBOT_API_KEY;
    const walletKey = process.env.WALLET_PRIVATE_KEY;
    let safe = message;
    if (apiKey) safe = safe.split(apiKey).join(maskSecret(apiKey));
    if (walletKey) safe = safe.split(walletKey).join(maskSecret(walletKey));
    // eslint-disable-next-line no-console
    console.error(
      error instanceof CliConfigError ? safe : `paybot: ${safe}`,
    );
    process.exitCode = 1;
  }
}

// Only run when invoked as the executable, not when imported by tests.
// pathToFileURL normalizes Windows paths + file:// slashes — the portable ESM
// idiom for "is this module the process entry point".
const isEntry =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  void main();
}
