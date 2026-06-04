/**
 * multi-bot-pool — run several bots from one operator process with a shared
 * spend treasury.
 *
 * Demonstrates:
 *   - PayBotClientPool with sharedDailyLimitUsd (a shared daily envelope).
 *   - addBot() for two bots, each with its own signing key.
 *   - payAs() routing a payment through a specific bot.
 *   - the TREASURY_EXCEEDED guard: a spend that would blow the shared budget is
 *     refused locally with NO network call.
 *
 * Required env vars (see .env.example):
 *   PAYBOT_API_KEY          — operator API key shared by all bots in the pool.
 *   PAYBOT_PAY_TO           — recipient wallet (0x...) for the demo payments.
 *   BOT_A_WALLET_KEY        — (optional) bot-a signing key for real mode.
 *   BOT_B_WALLET_KEY        — (optional) bot-b signing key for real mode.
 *   PAYBOT_FACILITATOR_URL  — (optional) self-hosted facilitator URL.
 */
import 'dotenv/config';
import { PayBotClientPool } from 'paybot-sdk';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (copy .env.example to .env)`);
  }
  return value;
}

async function main(): Promise<void> {
  const payTo = requireEnv('PAYBOT_PAY_TO');

  // Shared treasury: the pool refuses cumulative spend over $10/day across ALL bots.
  const pool = new PayBotClientPool({
    apiKey: requireEnv('PAYBOT_API_KEY'),
    sharedDailyLimitUsd: 10,
    facilitatorUrl: process.env.PAYBOT_FACILITATOR_URL, // default https://api.paybotcore.com
  });

  // Each bot keeps its own signing context; bots never cross-sign.
  pool.addBot({ botId: 'bot-a', walletPrivateKey: process.env.BOT_A_WALLET_KEY });
  pool.addBot({ botId: 'bot-b', walletPrivateKey: process.env.BOT_B_WALLET_KEY });

  console.log('Pool bots:', pool.botIds());
  console.log('Remaining treasury:', pool.remainingTreasuryUsd(), 'USD');

  // A payment that fits the budget. On success the pool records the spend.
  const ok = await pool.payAs('bot-a', {
    resource: 'https://api.example.com/data-1',
    amount: '4',
    payTo,
  });
  console.log('bot-a $4 →', ok.success ? 'OK' : `FAIL ${ok.errorCode}`);
  console.log('Remaining treasury:', pool.remainingTreasuryUsd(), 'USD');

  // A payment that would blow the remaining budget. canSpend() short-circuits
  // this BEFORE any network call and returns a TREASURY_EXCEEDED failure.
  const tooBig = await pool.payAs('bot-b', {
    resource: 'https://api.example.com/data-2',
    amount: '50', // > remaining treasury
    payTo,
  });
  if (!tooBig.success && tooBig.errorCode === 'TREASURY_EXCEEDED') {
    console.log('bot-b $50 → correctly refused by the shared treasury (no network call)');
  } else {
    console.log('bot-b $50 →', tooBig);
  }

  // Local per-bot bookkeeping (a convenience projection, not the source of truth).
  console.log('bot-a stats:', pool.botStats('bot-a'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
