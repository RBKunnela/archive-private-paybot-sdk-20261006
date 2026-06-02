/**
 * raw-node-script — the smallest possible PayBot SDK smoke test.
 *
 * It does three things, in order:
 *   1. register()  — register this bot with the facilitator (idempotent).
 *   2. balance()   — read the bot's trust level + remaining daily budget.
 *   3. pay()       — make ONE payment for a resource.
 *
 * This is the recommended first run to confirm your API key + bot work.
 *
 * Required env vars (see .env.example):
 *   PAYBOT_API_KEY          — your PayBot API key (pb_...). NEVER hardcode it.
 *   PAYBOT_BOT_ID           — a stable id for this bot, e.g. "smoke-bot".
 *   PAYBOT_PAY_TO           — recipient wallet address (0x...) for the test pay().
 *   WALLET_PRIVATE_KEY      — (optional) enables real EIP-3009 signing. Omit for mock mode.
 *   PAYBOT_FACILITATOR_URL  — (optional) self-hosted facilitator URL.
 */
import 'dotenv/config';
import { PayBotClient } from 'paybot-sdk';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (copy .env.example to .env)`);
  }
  return value;
}

async function main(): Promise<void> {
  const client = new PayBotClient({
    apiKey: requireEnv('PAYBOT_API_KEY'),
    botId: process.env.PAYBOT_BOT_ID ?? 'smoke-bot',
    // Real on-chain signing turns on automatically when a wallet key is present.
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
    // Default is https://api.paybotcore.com. To self-host, set PAYBOT_FACILITATOR_URL.
    facilitatorUrl: process.env.PAYBOT_FACILITATOR_URL,
  });

  // 1. Register the bot at trust level 1.
  console.log('Registering bot…');
  const registration = await client.register(1);
  console.log('  registered:', registration);

  // 2. Read trust level + remaining budget.
  console.log('Checking balance…');
  const balance = await client.balance();
  console.log(
    `  trust=${balance.trustLevelName} ` +
      `daily=$${balance.dailySpentUsd}/$${balance.dailyLimitUsd} ` +
      `(remaining $${balance.dailyRemainingUsd})`,
  );

  // 3. Make one payment. pay() never throws — it returns success:false on failure.
  console.log('Making one payment…');
  const result = await client.pay({
    resource: 'https://api.example.com/premium-data',
    amount: '0.01', // human-readable USDC
    payTo: requireEnv('PAYBOT_PAY_TO'),
    // network defaults to Base Sepolia (eip155:84532) — perfect for testing.
  });

  if (result.success) {
    console.log(`  paid. txHash=${result.txHash ?? '(mock)'} net=${result.netAmount}`);
  } else {
    console.error(`  payment failed [${result.errorCode ?? 'ERROR'}]: ${result.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
