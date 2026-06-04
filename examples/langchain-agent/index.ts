/**
 * langchain-agent — the agent-pays-for-API pattern.
 *
 * An LLM agent often needs to call a paid API mid-reasoning. When that API
 * returns HTTP 402, the agent should pay and retry — autonomously, within a
 * spend cap. This example shows that pattern as a minimal "agent tool" loop so
 * it stays dependency-light (no heavy LangChain install required).
 *
 * The PayBot piece is `createX402Handler`, whose `.fetch()` transparently:
 *   1. issues the request,
 *   2. if it gets a 402 within `maxAutoPay`, pays via PayBotClient and retries,
 *   3. otherwise returns the original response.
 *
 * Wiring into LangChain: wrap `payAndFetch` below as a StructuredTool / DynamicTool
 * (the shape is identical — a name, a description, and an async `func`). See the
 * comment at the bottom.
 *
 * Required env vars (see .env.example):
 *   PAYBOT_API_KEY          — your PayBot API key (pb_...).
 *   PAYBOT_BOT_ID           — stable bot id (default "agent-bot").
 *   WALLET_PRIVATE_KEY      — (optional) enables real EIP-3009 signing.
 *   PAYBOT_FACILITATOR_URL  — (optional) self-hosted facilitator URL.
 *   AGENT_MAX_AUTOPAY       — (optional) max USD to auto-pay per call (default 1.00).
 */
import 'dotenv/config';
import { createX402Handler } from 'paybot-sdk';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (copy .env.example to .env)`);
  }
  return value;
}

// The x402 auto-handler: this is the agent's "wallet". It pays + retries on 402.
const handler = createX402Handler({
  apiKey: requireEnv('PAYBOT_API_KEY'),
  botId: process.env.PAYBOT_BOT_ID ?? 'agent-bot',
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
  facilitatorUrl: process.env.PAYBOT_FACILITATOR_URL, // default https://api.paybotcore.com
  // Refuse to auto-pay anything above this. The handler THROWS if a 402 exceeds it.
  maxAutoPay: process.env.AGENT_MAX_AUTOPAY ?? '1.00',
});

/**
 * The agent's "fetch a paid resource" tool.
 *
 * @param url - The resource the agent wants. If it 402s, this pays & retries.
 * @returns The response body as text (what the agent reasons over next).
 */
async function payAndFetch(url: string): Promise<string> {
  const response = await handler.fetch(url);
  if (!response.ok) {
    return `tool error: HTTP ${response.status} for ${url}`;
  }
  return await response.text();
}

/**
 * A minimal agent loop. A real LLM would choose the URL; here we hardcode one
 * "thought" so the example is deterministic and needs no model key.
 */
async function runAgent(task: string): Promise<void> {
  console.log(`Agent task: ${task}`);

  // Step 1 — the agent decides it needs paid data and calls its tool.
  const resourceUrl = 'https://api.example.com/premium-insight';
  console.log(`Agent → calling tool payAndFetch(${resourceUrl})`);

  try {
    const data = await payAndFetch(resourceUrl);
    // Step 2 — the agent reasons over the (now-paid-for) data.
    console.log('Agent ← tool returned:', data.slice(0, 200));
    console.log('Agent: done. (A real agent would now produce its final answer.)');
  } catch (err) {
    // createX402Handler throws when a 402 exceeds maxAutoPay or payment fails.
    console.error('Agent: tool failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

runAgent('Summarize the latest premium market insight').catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

/*
 * LangChain wiring (drop-in, if you add `langchain` / `@langchain/core`):
 *
 *   import { DynamicTool } from '@langchain/core/tools';
 *
 *   const payTool = new DynamicTool({
 *     name: 'pay_and_fetch',
 *     description:
 *       'Fetch a URL that may require x402 payment. Pays automatically (up to ' +
 *       'the configured cap) and returns the response body.',
 *     func: async (url: string) => payAndFetch(url),
 *   });
 *
 *   // Then add `payTool` to your agent's tool list and let the LLM call it when
 *   // it hits a paywalled API.
 */
