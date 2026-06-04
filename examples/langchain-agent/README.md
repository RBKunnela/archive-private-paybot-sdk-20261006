# langchain-agent

The **agent-pays-for-API** pattern: an LLM agent that pays for a paywalled API
mid-reasoning, then continues.

**Demonstrates:** `createX402Handler` — its `.fetch()` transparently pays a 402
(within a spend cap) and retries the request, so the agent's tool "just works".

## Why dependency-light?

The story calls for showing the *pattern*, not shipping a heavy LangChain stack.
So this is a minimal **agent-tool loop**: a `payAndFetch(url)` tool plus a tiny
deterministic agent loop. The bottom of `index.ts` shows the exact drop-in to wrap
`payAndFetch` as a LangChain `DynamicTool` if you want a real LLM in the loop.

## What it does

1. Builds an `createX402Handler` (the agent's "wallet") with a `maxAutoPay` cap.
2. The agent "decides" it needs paid data and calls `payAndFetch(url)`.
3. If the URL returns **402** within the cap, the handler pays via `PayBotClient`
   and retries. If the 402 **exceeds** the cap, `.fetch()` throws — the agent
   handles that as a tool failure.

## Run

```bash
cd ../.. && npm install && npm run build && cd examples/langchain-agent
cp .env.example .env   # fill in PAYBOT_API_KEY
npm install
npm start
```

## Required env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `PAYBOT_API_KEY` | yes | Your PayBot API key. |
| `PAYBOT_BOT_ID` | no | Bot id (default `agent-bot`). |
| `WALLET_PRIVATE_KEY` | no | Enables real on-chain signing. |
| `AGENT_MAX_AUTOPAY` | no | Max USD to auto-pay per call (default `1.00`). |
| `PAYBOT_FACILITATOR_URL` | no | Self-hosted facilitator. Defaults to `https://api.paybotcore.com`. |

## LangChain integration

See the comment at the bottom of `index.ts` for the `DynamicTool` wrapper. The
tool shape (name + description + async `func`) is identical to what a LangChain
agent expects.
