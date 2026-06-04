# Changelog — paybot-sdk (Python)

All notable changes to the Python port of paybot-sdk are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-06-03

x402 v2 parity bundle: brings the Python port to functional parity with the
TypeScript SDK in `src/*.ts`.

### Added

- **Error taxonomy** (`errors.py`): 8-class hierarchy mirroring `src/errors.ts`
  — `PayBotError` (abstract root) → `PayBotApiError` (back-compat anchor) →
  `PayBotNetworkError`, `PayBotTimeoutError`, `PayBotAuthError`,
  `PayBotPolicyError`, `PayBotSignatureError`, `PayBotSettlementError`. Adds
  `POLICY_ERROR_CODES` and `map_http_error`. Every subclass is
  `isinstance(e, PayBotApiError)`, so existing `except PayBotApiError` blocks are
  unaffected.
- **Multi-token registry** (`networks.py`): `TokenConfig`, `TOKENS` (USDC + EURC),
  `get_token`, `get_token_address`, `get_supported_tokens`, `get_eip712_domain`,
  `get_network`, `get_supported_networks`, `Caip2`, `parse_caip2`,
  `is_supported_caip2`. EURC payments are now supported end-to-end.
- **x402 v2 handler** (`x402.py`): `X402Handler` with dual-mode signing
  (`x402` | `mpp` | `dual`), the `upto` metered scheme, EIP-3009
  `TransferWithAuthorization` + MPP `PaymentAuthorization` typed-data signing via
  `eth-account`, `Payment-Intent` header encode/parse, and `on_402_response`.
- **AP2 adapter** (`ap2.py`): `Ap2Adapter`, `Ap2PaymentMandate`,
  `ap2_mandate_to_payment_requirements`, `is_ap2_mandate`. Settles AP2 mandates
  over x402. **Trust boundary: the AP2 verifiable-credential signature is NOT
  verified** (paybot is the settlement layer, not the mandate issuer).
- **MPP seam** (`mpp_seam.py`): `detect_mpp_capability`, `create_mpp_seam`,
  `MppCapability`, `MppAdapter`. `settle()` raises `MPP_NOT_IMPLEMENTED` (501) by
  design — MPP is still in preview.
- **Telemetry** (`telemetry.py`): `PayBotTracer` / `PayBotSpan` runtime-checkable
  Protocols + `with_span`. Zero-overhead no-op when no tracer is injected; a real
  Python OpenTelemetry `Span` satisfies the Protocol directly (snake_case).
- **Idempotency** (`client.py`): per-instance LRU cache (cap 256) + the
  `X-Idempotency-Key` header on `pay()` and `register()` when an
  `idempotency_key` is supplied. Only successful results are cached.
- **Multi-bot client pool** (`client_pool.py`): `PayBotClientPool` with
  `add_bot` / `get_bot` / `pay_as` and an optional shared daily treasury
  (`shared_daily_limit_usd`), enforced pre-network as `TREASURY_EXCEEDED`.
- **Framework middleware** (`middleware.py`): `Paybot402Middleware` (raw ASGI) +
  `paybot_402_dependency` (FastAPI). FastAPI is lazy-imported via the new optional
  `web` extra; the ASGI middleware needs no third-party import.
- **Static auth helpers** (`client.py`): `PayBotClient.signup` and
  `PayBotClient.login`.
- New fields: `PaymentRequest.token`, `PaymentRequest.idempotency_key`,
  `PayBotConfig.telemetry` (all optional with defaults — additive).
- New optional dependency extras: `web` (FastAPI) and `dev` (signing + web + test).

### Changed — observable contract change (flag for callers)

- **`pay()` error code for an unknown token is now `UNSUPPORTED_TOKEN`** (was
  `UNSUPPORTED_NETWORK`). This aligns the Python port with the TS SDK contract.
  Any caller asserting on `UNSUPPORTED_NETWORK` for an unknown *token* must
  update to `UNSUPPORTED_TOKEN`. Unknown *networks* are unaffected (they still
  surface a network-class failure / fall through to the USDC fallback path as
  before).
- `_sign_payload` now resolves its EIP-712 domain via
  `get_eip712_domain(network, symbol)` instead of `EIP712_DOMAINS[network]`.
  **Regression-guaranteed byte-identical for USDC** (locked by a golden-vector
  test); EURC signs under its own token-specific domain.

### Compatibility

- `PayBotApiError(message, code, status_code, details=None)` keeps its exact
  positional signature. All existing public symbols remain exported.
- The four pre-existing test files (`test_receipts`, `test_scaffold`,
  `test_signing`, `test_webhook`) pass unchanged.

## [0.1.0]

- Initial runtime release: EIP-3009 signing in `PayBotClient.pay()` and webhook
  signature verification.
