#!/usr/bin/env node
/**
 * Quickstart smoke test vs the hosted facilitator (story DP-1.4).
 *
 * Runs the LITERAL README quickstart against the live hosted facilitator
 * using the PUBLISHED npm package (`npm install paybot-sdk@latest` in a temp
 * dir) — i.e. exactly what a stranger who reads the README installs and runs.
 * Unit tests mock the server and the server deploys without exercising
 * published clients, so this script is the only thing that continuously
 * proves "README + npm + hosted URL" still line up. Any drift = exit 1.
 *
 * README fidelity map (README.md, sections as of DP-0.3):
 *   Step 1 "Install"            -> `npm install paybot-sdk` (here: @latest, temp dir)
 *   Step 2 "Get your API key"   -> `PayBotClient.signup(email, password, { botId })`
 *                                  (signup auto-registers the bot; README explicitly
 *                                   says to SKIP register() afterwards, so we do)
 *   Step 3 "Quick Start"        -> `new PayBotClient({ apiKey, botId, facilitatorUrl })`
 *                                  then `client.pay({ resource, amount, payTo })`
 *   Step 4 "Mock mode"          -> no walletPrivateKey passed => mock mode, no funds move
 *
 * Fresh identity per run (AC: "fresh signup identity per run"):
 *   - botId defaults/collisions are GLOBAL on the hosted facilitator — a reused
 *     botId 409s on signup's internal register step. So every run generates a
 *     fresh random botId AND a fresh random email (smoke-<timestamp>-<rand>).
 *   - This also means the job needs ZERO stored secrets: each run
 *     self-provisions a throwaway identity and never reuses credentials.
 *
 * Security: the API key returned by signup() is never printed in full —
 * only its last 4 characters (see maskApiKey).
 *
 * Usage:
 *   node scripts/quickstart-smoke.mjs
 *   PAYBOT_FACILITATOR_URL=https://staging.example.com node scripts/quickstart-smoke.mjs
 *
 * Exit codes: 0 = quickstart works end-to-end; 1 = drift/failure (message
 * names the failed step and includes the server response, credentials masked).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const DEFAULT_FACILITATOR_URL = 'https://api.paybotcore.com';

/**
 * Generate a fresh throwaway identity for one smoke run.
 *
 * Both the email and the botId embed a timestamp + random suffix because the
 * hosted facilitator's botId namespace is global — reusing a botId makes
 * signup's internal register step 409. Fresh per run = no collisions and no
 * stored secrets.
 *
 * @param {number} [now] - Epoch ms used in the identifier (defaults to Date.now()).
 * @param {string} [rand] - Random hex suffix (defaults to 8 random hex chars).
 * @returns {{ email: string, password: string, botId: string }} Identity for signup().
 */
export function generateIdentity(now = Date.now(), rand = randomBytes(4).toString('hex')) {
  const tag = `smoke-${now}-${rand}`;
  return {
    email: `${tag}@smoke.paybotcore.com`,
    // Throwaway, single-use, never reused or stored; randomness makes it strong.
    password: `Sm0ke!${now}${rand}${randomBytes(8).toString('hex')}`,
    botId: tag,
  };
}

/**
 * Mask an API key for safe logging: keep at most the last 4 characters.
 *
 * @param {unknown} key - The API key (any non-string yields the full mask).
 * @returns {string} e.g. "****abcd" — never the full key.
 */
export function maskApiKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '****';
  return `****${key.slice(-4)}`;
}

/**
 * Validate the result of PayBotClient.signup() against the README contract.
 *
 * @param {unknown} result - Whatever signup() resolved with.
 * @returns {string[]} Human-readable problems; empty array = valid.
 */
export function validateSignupResult(result) {
  const problems = [];
  if (result === null || typeof result !== 'object') {
    return [`signup() did not return an object (got ${typeof result})`];
  }
  const r = /** @type {Record<string, unknown>} */ (result);
  if (typeof r.operatorId !== 'string' || r.operatorId.length === 0) {
    problems.push('signup(): missing/empty operatorId');
  }
  if (typeof r.apiKey !== 'string' || r.apiKey.length === 0) {
    problems.push('signup(): missing/empty apiKey');
  }
  if (typeof r.botId !== 'string' || r.botId.length === 0) {
    problems.push('signup(): missing/empty botId');
  }
  return problems;
}

/**
 * Validate the result of client.pay() (mock mode) against the README contract:
 * success:true, a 0x-hex txHash, and the commission fields present.
 *
 * @param {unknown} result - Whatever pay() resolved with.
 * @returns {string[]} Human-readable problems; empty array = valid.
 */
export function validatePayResult(result) {
  const problems = [];
  if (result === null || typeof result !== 'object') {
    return [`pay() did not return an object (got ${typeof result})`];
  }
  const r = /** @type {Record<string, unknown>} */ (result);
  if (r.success !== true) {
    problems.push(
      `pay(): success !== true (success=${JSON.stringify(r.success)}, error=${JSON.stringify(r.error)}, errorCode=${JSON.stringify(r.errorCode)})`
    );
  }
  if (typeof r.txHash !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(r.txHash)) {
    problems.push(`pay(): txHash missing or not 0x-hex (got ${JSON.stringify(r.txHash)})`);
  }
  if (typeof r.commissionAmount !== 'string' || r.commissionAmount.length === 0) {
    problems.push(`pay(): commissionAmount missing (got ${JSON.stringify(r.commissionAmount)})`);
  }
  if (typeof r.commissionRate !== 'number' || Number.isNaN(r.commissionRate)) {
    problems.push(`pay(): commissionRate missing or not a number (got ${JSON.stringify(r.commissionRate)})`);
  }
  return problems;
}

/**
 * Redact anything that looks like an API key in a string destined for logs.
 *
 * @param {string} text - Arbitrary log text (e.g. a stringified server response).
 * @returns {string} Same text with pb_-style keys masked to their last 4 chars.
 */
export function redactSecrets(text) {
  return String(text).replace(/pb_[A-Za-z0-9_]{8,}/g, (m) => maskApiKey(m));
}

/** Fail the run loudly: print the step that broke + (redacted) detail, exit 1. */
function fail(step, detail) {
  console.error(`\nQUICKSTART SMOKE FAILED at step: ${step}`);
  console.error(redactSecrets(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)));
  console.error('\nThis means the README quickstart is broken for real users right now.');
  process.exit(1);
}

/**
 * One full network attempt of the quickstart: signup() with a fresh identity,
 * then mock pay(). Returns an error descriptor instead of exiting so the
 * caller can retry ONCE (transient-network tolerance) without masking drift.
 *
 * @param {Function} PayBotClient - The published PayBotClient class.
 * @param {string} facilitatorUrl - Hosted facilitator base URL.
 * @returns {Promise<{ ok: true } | { ok: false, step: string, detail: string }>}
 */
async function attemptQuickstart(PayBotClient, facilitatorUrl) {
  // ---- Step 2: README "Get your API key" — signup() with a FRESH identity.
  const identity = generateIdentity();
  console.log(`[2/3] signup() as ${identity.email} (botId: ${identity.botId})`);
  let account;
  try {
    account = await PayBotClient.signup(identity.email, identity.password, {
      botId: identity.botId,
      facilitatorUrl,
    });
  } catch (err) {
    return {
      ok: false,
      step: 'signup (README "Get your API key")',
      detail: `signup() threw: ${err?.message ?? err}`,
    };
  }
  const signupProblems = validateSignupResult(account);
  if (signupProblems.length > 0) {
    return { ok: false, step: 'signup (README "Get your API key")', detail: signupProblems.join('\n') };
  }
  console.log(`      operatorId: ${account.operatorId}, apiKey: ${maskApiKey(account.apiKey)}`);

  // ---- Step 3: README "Quick Start" — construct the client and pay() in
  // mock mode (no walletPrivateKey => no funds move). README says signup()
  // already registered the bot and to SKIP register(), so we go straight to pay().
  console.log('[3/3] pay() in mock mode');
  const client = new PayBotClient({
    apiKey: account.apiKey,
    botId: account.botId,
    facilitatorUrl,
  });
  let result;
  try {
    result = await client.pay({
      resource: 'https://api.example.com/data',
      amount: '0.05',
      payTo: '0x1234567890123456789012345678901234567890',
    });
  } catch (err) {
    return { ok: false, step: 'pay (README "Quick Start")', detail: `pay() threw: ${err?.message ?? err}` };
  }
  const payProblems = validatePayResult(result);
  if (payProblems.length > 0) {
    return {
      ok: false,
      step: 'pay (README "Quick Start")',
      detail: [...payProblems, `full response: ${JSON.stringify(result)}`].join('\n'),
    };
  }
  console.log(
    `      success: ${result.success}, txHash: ${result.txHash}, ` +
      `commissionRate: ${result.commissionRate}, commissionAmount: ${result.commissionAmount}`
  );
  return { ok: true };
}

async function main() {
  const facilitatorUrl = process.env.PAYBOT_FACILITATOR_URL || DEFAULT_FACILITATOR_URL;
  console.log(`Quickstart smoke vs ${facilitatorUrl}`);

  // ---- Step 1: README "Install" — install the PUBLISHED package in a temp dir.
  // The point is testing what users actually install, not the local source tree.
  const workDir = await mkdtemp(join(tmpdir(), 'paybot-quickstart-smoke-'));
  let sdk;
  try {
    console.log(`[1/3] npm install paybot-sdk@latest (temp dir: ${workDir})`);
    try {
      // A package.json anchors npm to the temp dir — without one, npm walks up
      // the directory tree and may install into an unrelated parent project.
      await writeFile(
        join(workDir, 'package.json'),
        JSON.stringify({ name: 'paybot-quickstart-smoke', private: true, type: 'module' }, null, 2)
      );
      execFileSync('npm', ['install', 'paybot-sdk@latest', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: workDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        timeout: 180_000,
      });
    } catch (err) {
      fail('install (npm install paybot-sdk@latest)', String(err));
    }

    const pkgEntry = pathToFileURL(join(workDir, 'node_modules', 'paybot-sdk', 'dist', 'index.js')).href;
    ({ PayBotClient: sdk } = await import(pkgEntry));
    if (typeof sdk !== 'function') {
      fail('import published package', 'PayBotClient export not found in published paybot-sdk');
    }
    const installedVersion = JSON.parse(
      execFileSync('npm', ['ls', 'paybot-sdk', '--json'], {
        cwd: workDir,
        shell: process.platform === 'win32',
      }).toString()
    )?.dependencies?.['paybot-sdk']?.version;
    console.log(`      installed paybot-sdk@${installedVersion ?? 'unknown'}`);

    // ---- Steps 2-3 (network phase) with a SINGLE retry. A retry uses a brand
    // new identity (botId collisions are global), absorbing transient network
    // noise without masking real drift — two consecutive failures = red.
    let outcome = await attemptQuickstart(sdk, facilitatorUrl);
    if (!outcome.ok) {
      console.warn(`\nAttempt 1 failed at "${outcome.step}" — retrying once with a fresh identity...\n`);
      outcome = await attemptQuickstart(sdk, facilitatorUrl);
    }
    if (!outcome.ok) {
      fail(outcome.step, outcome.detail);
    }
    console.log('\nQUICKSTART SMOKE PASSED — README quickstart works against the hosted facilitator.');
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Run only when executed directly (not when imported by unit tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    fail('unexpected error', String(err?.stack ?? err));
  });
}
