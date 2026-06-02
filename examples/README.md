# PayBot SDK — Examples

Minimal, runnable apps that demonstrate the **real** public API of:

- **TypeScript** `paybot-sdk` v0.3.0 (root of this repo)
- **Python** `paybot-sdk` v0.2.0 (`packages/python/`)

Every example references secrets via a `.env.example` and **never hardcodes a key**.
All examples default to the hosted facilitator `https://api.paybotcore.com`; each
shows (in a comment) how to point at a self-hosted facilitator via `facilitatorUrl`
(TS) / `facilitator_url` (Python).

> These are reference apps. They are syntactically valid and type-check, but they
> do **not** need a live facilitator to read — the calls that hit the network are
> clearly marked.

## Index

| Example | Language | SDK feature it demonstrates |
|---------|----------|-----------------------------|
| [`raw-node-script/`](./raw-node-script/) | Node (TS) | Smallest smoke test: `PayBotClient` → `register()` → `balance()` → one `pay()` |
| [`express-bot/`](./express-bot/) | Node/Express | Consumer side `PayBotClient.pay()` **and** provider side `paybot402()` middleware on a route |
| [`nextjs-route-handler/`](./nextjs-route-handler/) | Next.js App Router | Gating a paid API route with `createX402Handler` / the x402 402-challenge pattern in a `route.ts` |
| [`hono-cloudflare-worker/`](./hono-cloudflare-worker/) | Hono / Cloudflare Workers | Manual x402 402 wall on a Worker route (no Hono middleware port yet) |
| [`multi-bot-pool/`](./multi-bot-pool/) | Node (TS) | `PayBotClientPool` shared treasury (`sharedDailyLimitUsd`) + `payAs()` + the `TREASURY_EXCEEDED` guard |
| [`fastapi-bot/`](./fastapi-bot/) | Python / FastAPI | `paybot_402_dependency` route gate + startup bot `register()` with the async Python `PayBotClient` |
| [`langchain-agent/`](./langchain-agent/) | Node (TS) | Agent-pays-for-API pattern: an LLM tool loop that calls `pay()` when it hits a 402 |

## Running a TypeScript example

Each TS example depends on the SDK via `"paybot-sdk": "file:../.."`, so build the
SDK once at the repo root first:

```bash
# from the repo root
npm install
npm run build      # produces dist/ that the examples import
```

Then, inside an example folder:

```bash
cd examples/raw-node-script
cp .env.example .env     # fill in your keys
npm install
npm start
```

## Running the Python example

```bash
cd examples/fastapi-bot
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env     # fill in your keys
uvicorn app:app --reload
```

## Getting an API key

Use `PayBotClient.signup(email, password)` (TS) once to obtain an `apiKey` + `botId`,
then store the key in your `.env`. See [`raw-node-script/`](./raw-node-script/) for the
full first-run flow. The key is shown **only once** — save it.

## Self-hosting the facilitator

All examples talk to `https://api.paybotcore.com` by default. To point at a
self-hosted facilitator, set `facilitatorUrl` (TS) / `facilitator_url` (Python) —
each example reads it from `PAYBOT_FACILITATOR_URL` in `.env`. See the repo-root
[`SELF_HOSTING.md`](../SELF_HOSTING.md).
