# paybot-sdk (Python port)

Python port of `paybot-sdk`. Mirror of the TypeScript SDK in `../../src/`.

> **Status: scaffold.** Type surface, network config, HTTP transport, and all
> non-signing client methods are complete and reviewable. EIP-3009 signing
> (`PayBotClient.pay()` real-mode path) raises `NotImplementedError` in this PR
> by design; the runtime port lands in the follow-up PR-2 once the type surface
> is reviewed and merged.

## Install

```bash
pip install paybot-sdk
```

Or with the signing extras (needed for `pay()` in real mode, once PR-2 lands):

```bash
pip install paybot-sdk[signing]
```

## Quick start (mock mode)

```python
import asyncio
from paybot_sdk import PayBotClient, PayBotConfig, PaymentRequest

async def main():
    client = PayBotClient(PayBotConfig(
        api_key="pb_test_...",
        bot_id="my-bot",
    ))
    await client.register()
    balance = await client.balance()
    print(balance)

asyncio.run(main())
```

## What's in this scaffold

| File | Mirror of TS | Status |
|---|---|---|
| `paybot_sdk/types.py` | `src/types.ts` | ✅ Full type surface as `@dataclass` |
| `paybot_sdk/networks.py` | `src/networks.ts` | ✅ Full (chain IDs, USDC addresses, EIP-712 domains, EIP-3009 types) |
| `paybot_sdk/errors.py` | `src/errors.ts` | ✅ Full (`PayBotApiError`, `get_error_message`) |
| `paybot_sdk/crypto.py` | `src/crypto.ts` | ✅ Full (`generate_eip3009_nonce` via `secrets.token_hex`) |
| `paybot_sdk/client.py` | `src/client.ts` | ⚠️ Partial — all REST methods complete; `_sign_payload()` raises `NotImplementedError` |
| `paybot_sdk/__init__.py` | `src/index.ts` | ✅ Full exports |
| `paybot_sdk/middleware.py` | `src/middleware.ts` | ❌ Not yet (lands in PR-2) |
| `paybot_sdk/x402_handler.py` | `src/x402-handler.ts` | ❌ Not yet (lands in PR-2) |

**Fully working in this scaffold (mock mode):**
`register()`, `balance()`, `history()`, `set_limits()`, `health()`,
`commission_summary()`, `commission_ledger()`, `create_api_key()`,
`list_api_keys()`, `revoke_api_key()`. Everything that doesn't require
EIP-3009 signing — anyone using the SDK in mock mode (no `wallet_private_key`)
gets the same surface they'd have on the TS side.

**Pending PR-2:**
- `_sign_payload()` runtime — EIP-712 typed-data signing with `eth-account`
- `middleware.py` port
- `x402_handler.py` port
- Full integration test suite (right now `tests/` has type-surface tests only)

## Review focus for this PR

What I'd love eyes on first, since the runtime is a known follow-up:

1. **Snake-case naming.** TS uses `botId`, `walletPrivateKey`. Python convention
   is `bot_id`, `wallet_private_key`. Wire format on the HTTP boundary is still
   camelCase (matches the TS server contract). Worth confirming this is the
   right boundary placement.
2. **`PayBotConfig` as dataclass vs. kwargs.** Currently `PayBotConfig` is a
   dataclass that gets passed in. Could also expose `PayBotClient(api_key=..., bot_id=...)` directly. Open to either; let me know which matches the SDK's intended ergonomics.
3. **Async-first vs. sync wrapper.** Right now everything is `async def`. The TS
   SDK is also async-first (promise-based). If the consumer use cases include
   sync agents (LangChain old-style), a thin `paybot_sdk.sync` wrapper is easy
   to add. Worth deciding now so the public API doesn't drift.
4. **`_to_base_units`.** String-based conversion to avoid float drift. Matches
   the TS path; worth verifying no precision corner cases I missed.

## Test plan

```bash
cd packages/python
pip install -e ".[test]"
pytest
```

The current test suite (in `tests/`) covers:
- Type surface (every dataclass constructable from valid inputs)
- `PayBotClient.__init__` validation (api_key required, bot_id required, facilitator_url URL, wallet_private_key 0x-prefix)
- `_to_base_units` corner cases (zero, no decimal, exact decimal, more decimals than scale)
- `generate_eip3009_nonce` shape (0x-prefixed, 66 chars)
- `NETWORKS` parity with `src/networks.ts` (chain IDs, USDC addresses)

End-to-end tests against the live facilitator land in PR-2 alongside the
signing runtime.
