# paybot-sdk (Python port)

Python port of `paybot-sdk`. Mirror of the TypeScript SDK in `../../src/`.

> **Status: runtime (0.1.0).** Type surface, network config, HTTP transport, all
> client REST methods, EIP-3009 signing (`PayBotClient.pay()` real-mode path),
> and webhook signature verification are implemented and tested. The signed
> payload and the webhook signature are byte-for-byte compatible with the TS SDK.

## Install

```bash
pip install paybot-sdk
```

Or with the signing extras (required for `pay()` in real mode):

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

## What's implemented

| File | Mirror of TS | Status |
|---|---|---|
| `paybot_sdk/types.py` | `src/types.ts` | ✅ Full type surface as `@dataclass` |
| `paybot_sdk/networks.py` | `src/networks.ts` | ✅ Full (chain IDs, USDC addresses, EIP-712 domains, EIP-3009 types) |
| `paybot_sdk/errors.py` | `src/errors.ts` | ✅ Full (`PayBotApiError`, `get_error_message`) |
| `paybot_sdk/crypto.py` | `src/crypto.ts` | ✅ Full (`generate_eip3009_nonce` via `secrets.token_hex`) |
| `paybot_sdk/client.py` | `src/client.ts` | ✅ Full — all REST methods + real-mode EIP-3009 signing in `_sign_payload()` |
| `paybot_sdk/webhook.py` | `src/webhook.ts` | ✅ Full (`verify_webhook_signature`, HMAC-SHA256, replay guard) |
| `paybot_sdk/__init__.py` | `src/index.ts` | ✅ Full exports |
| `paybot_sdk/middleware.py` | `src/middleware.ts` | ❌ Not yet ported |
| `paybot_sdk/x402_handler.py` | `src/x402-handler.ts` | ❌ Not yet ported |

**Working today:**
`register()`, `balance()`, `history()`, `set_limits()`, `health()`,
`commission_summary()`, `commission_ledger()`, `create_api_key()`,
`list_api_keys()`, `revoke_api_key()`, real-mode `pay()` (EIP-3009 signing),
and `verify_webhook_signature()`. Mock mode (no `wallet_private_key`) and real
mode both mirror the TS SDK wire contract.

**Not yet ported:**
- `middleware.py`
- `x402_handler.py`

## Webhook verification

```python
from paybot_sdk import verify_webhook_signature

ok = verify_webhook_signature(
    payload=request_body,                # str or bytes — the raw body
    signature=headers["Paybot-Signature"],  # "t=<unix_ts>,v1=<hex>"
    secret="whsec_...",
    tolerance=300,                       # replay window in seconds
)
```

The signing string is `f"{t}.{payload}"` and the header format is
`t=<unix_ts>,v1=<hmac_sha256_hex>`, identical to the TS
`verifyWebhookSignature`, so a server-signed webhook verifies in either runtime.

## Notes

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
pip install -e ".[signing,test]"
pytest
```

The test suite (in `tests/`) covers:
- Type surface (every dataclass constructable from valid inputs)
- `PayBotClient.__init__` validation (api_key required, bot_id required, facilitator_url URL, wallet_private_key 0x-prefix)
- `_to_base_units` corner cases (zero, no decimal, exact decimal, more decimals than scale)
- `generate_eip3009_nonce` shape (0x-prefixed, 66 chars)
- `NETWORKS` parity with `src/networks.ts` (chain IDs, USDC addresses)
- EIP-3009 signing (`test_signing.py`): TS wire shape, signer-address recovery round-trip, unsupported-network + missing-key errors, deterministic-given-nonce structure
- Real-mode `pay()` verify→settle flow (respx-mocked HTTP)
- Webhook verification (`test_webhook.py`): valid/tampered/expired/future/malformed-header cases + the `f"{t}.{payload}"` cross-language signing contract
