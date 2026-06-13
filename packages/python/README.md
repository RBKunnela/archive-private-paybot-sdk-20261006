# paybot-sdk (Python port)

Python port of `paybot-sdk`. Mirror of the TypeScript SDK in `../../src/`.

> **Status: feature-parity (0.2.0).** Brings the Python SDK to parity with the
> TypeScript SDK: type surface, network + multi-token registry, HTTP transport,
> all client REST methods, the full error taxonomy, idempotency + `refund()`,
> EIP-3009 signing, the x402 v2 handler (`X402Handler`), the multi-bot client
> pool, the micropayment batching engine, opt-in telemetry, the AP2 → x402
> settlement adapter, the MPP capability seam, and webhook verification. Signed
> payloads and webhook signatures are byte-for-byte compatible with the TS SDK.

## Install

```bash
pip install paybot-sdk
```

Or with the signing extras (required for `pay()`, `X402Handler` signing, and the
micropayment engine in real mode):

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

## Parity table (TS module → Python module)

| TS module | Python module | Status |
|---|---|---|
| `src/types.ts` | `paybot_sdk/types.py` | ✅ Full type surface as `@dataclass` (incl. x402 v2, micropayment, refund types) |
| `src/networks.ts` | `paybot_sdk/networks.py` | ✅ Full — `NETWORKS`, `TOKENS` (USDC/EURC/PYUSD/RLUSD/DAI) with `signing_method` + `eip712_version`, `get_eip712_domain`, `resolve_token_address`, CAIP-2 helpers |
| `src/errors.ts` | `paybot_sdk/errors.py` | ✅ Full taxonomy — `PayBotError` → `PayBotApiError` → network/timeout/auth/policy/signature/settlement/unsupported-signing, `map_http_error` |
| `src/crypto.ts` | `paybot_sdk/crypto.py` | ✅ Full (`generate_eip3009_nonce`) |
| `src/client.ts` | `paybot_sdk/client.py` | ✅ Full — REST methods, EIP-3009 signing, multi-token resolution, idempotency LRU, `refund()`, telemetry hooks |
| `src/client-pool.ts` | `paybot_sdk/client_pool.py` | ✅ `PayBotClientPool` — per-bot signing, shared treasury (`TREASURY_EXCEEDED`), `pay_as` |
| `src/x402-v2.ts` | `paybot_sdk/x402_v2.py` | ✅ `X402Handler` — 402 parse, x402/MPP/dual signing, `upto` scheme + capture validation, PAYMENT-SIGNATURE/RESPONSE headers, submit/verify |
| `src/telemetry.ts` | `paybot_sdk/telemetry.py` | ✅ Opt-in `PayBotTracer`/`PayBotSpan` protocols + `with_span`, no OTel dependency |
| `src/micropayment-engine.ts` | `paybot_sdk/micropayment_engine.py` | ✅ `MicropaymentEngine` — queue, thresholds, signed batch, stats |
| `src/ap2.ts` | `paybot_sdk/ap2.py` | ✅ `Ap2Adapter` legacy slice (translation-only; does NOT verify the AP2 VC signature) |
| `src/ap2-vc.ts` | — | ⚠️ **Parity gap (AK-1):** AP2 mandate VC verification (`verifyMandate`, `settleVc`, replay store, trust anchors) is **TypeScript-only**. See "AP2 VC verification parity gap" below. |
| `src/mpp-seam.ts` | `paybot_sdk/mpp_seam.py` | ✅ `detect_mpp_capability` + `create_mpp_seam` (`settle` raises `MPP_NOT_IMPLEMENTED` — full MPP deferred to GA) |
| `src/webhook.ts` | `paybot_sdk/webhook.py` | ✅ Full (`verify_webhook_signature`, HMAC-SHA256, replay guard) |
| `src/index.ts` | `paybot_sdk/__init__.py` | ✅ Full exports |
| `src/middleware.ts` | — | ❌ Not ported (see below) |
| `src/x402-handler.ts` | — | ⚠️ Not ported as a separate module — its surface is subsumed by `X402Handler` in `x402_v2.py` |

**Still unported (honest gaps):**

- **`src/middleware.ts`** — an **Express-style** HTTP middleware (`paybot402`).
  There is no direct Python equivalent because it is bound to the Express
  request/response model. The natural Python analogue is a **FastAPI/Starlette
  dependency** (or an ASGI middleware) — a clean follow-up, but a different
  shape, so it is deliberately left out of this parity pass rather than ported
  as a non-idiomatic line-for-line copy.
- **`src/x402-handler.ts`** — the older, thin handler. Its capability is covered
  by the full `X402Handler` in `x402_v2.py`; a separate thin module would be
  redundant.

> **eip2612 tokens (RLUSD, DAI):** present in the `TOKENS` registry for discovery
> with `signing_method="eip2612"`, but signing them is a **documented rejection** —
> the SDK implements EIP-3009 (`TransferWithAuthorization`) only. Use
> `PayBotUnsupportedSigningMethodError` as the typed boundary when wiring permit
> support later.

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

## AP2 VC verification parity gap (AK-1)

**The Python SDK does NOT verify AP2 mandate verifiable-credential signatures.**
AP2 VC verification — the fail-closed 8-step pipeline (`verifyMandate`),
SD-JWT/`eddsa-jcs-2022` proof checking, offline `did:key`/`did:web` resolution,
operator trust anchors, replay protection, and verified settlement (`settleVc`)
— lives in **TypeScript only** (`src/ap2-vc.ts`). The Python `paybot_sdk/ap2.py`
module is **translation-only**: it maps the settlement slice of an AP2 Payment
Mandate onto x402 requirements and treats the VC signature as opaque (its module
docstring states this trust boundary).

Do **not** represent the Python SDK as verifying AP2 mandates. A Python caller
that needs cryptographic assurance a mandate is authentic MUST either:

1. verify the VC out-of-band before handing it to `Ap2Adapter.settle`, or
2. settle through **paybot core**, whose settle path is the authoritative
   verification + audit + replay layer.

Mirroring the 1300+ line TS verify pipeline into Python is deliberately **out of
scope** for the AK-1 slice (per task T7's explicit parity-gap allowance — a full
port, not a half-implementation). Tracked as a follow-up:

> **TODO (AK-1 follow-up):** Port `src/ap2-vc.ts` verification to
> `paybot_sdk/ap2_vc.py` (envelope types, JCS canonicalization, `did:key`
> resolver, SD-JWT ES256 + `eddsa-jcs-2022` proof verification, replay store,
> the 8-step `verify_mandate`) with the official-fixture interop test from
> `tests/ap2-interop.test.ts` reproduced under `packages/python/tests/`.
> Until then this row stays ⚠️ in the parity table above.

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

The test suite (in `tests/`) covers, per module:
- `test_scaffold.py` / `test_signing.py` — type surface, `__init__` validation,
  `_to_base_units`, nonce shape, `NETWORKS` parity, EIP-3009 signing + recovery
- `test_webhook.py` — valid/tampered/expired/future/malformed-header cases
- `test_errors_taxonomy.py` — the full error hierarchy + `map_http_error` dispatch
- `test_tokens.py` — multi-token registry, EIP-712 domain resolution, the EURC
  mainnet open-core boundary, and `pay({token})` integration
- `test_telemetry.py` — no-op path, span lifecycle (OK/ERROR), attribute attach
- `test_x402_v2.py` — 402 parsing, x402/MPP/dual dispatch (signature recovery),
  `upto` scheme + overcharge, header encode/decode, submit/verify
- `test_client_pool.py` — add/get/remove, per-bot signing isolation, shared
  treasury (`TREASURY_EXCEEDED` pre-network block), `pay_as`
- `test_micropayment_engine.py` — queue, batch signing (recovery), stats, gas
- `test_ap2.py` — mandate translation, validation/expiry, settlement wiring
- `test_mpp_seam.py` — detection + the `MPP_NOT_IMPLEMENTED` dead-end
- `test_idempotency.py` — pay()/register() caching + LRU internals
- `test_refund.py` — `refund()` success/failure (never raises)
