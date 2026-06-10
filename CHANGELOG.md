# Changelog

All notable changes to `paybot-sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog covers the TypeScript package (`paybot-sdk` on npm). The Python
port (`packages/python/`, published to PyPI) is versioned independently and ships
at `0.2.0` alongside this release.

## [0.5.1] - 2026-06-10

Docs-only patch release. Its purpose is to push the README onboarding overhaul
to npm, where most users actually read it.

### Documentation

- **README onboarding overhaul** (#97) — documents the `signup()` → API-key
  path ("Get your API key" section, no dashboard needed), adds the
  mock-mode vs real-settlement section, fixes the trust-level table to mirror
  the facilitator's canonical registry, and cleans up the stale roadmap.
- **"ESM only" note** near Install — the package ships no CommonJS export, so
  `require('paybot-sdk')` in a default `npm init -y` project fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. The README now tells users to set
  `"type": "module"` (or use `.mjs`).
- **Base-units note** — documents that amounts returned by `history()` /
  `balance()` payment records are 6-decimal USDC base units
  (`1000000` = 1 USDC), unlike the human-readable strings passed to `pay()`.

### CI

- **Quickstart smoke test** (#98) — daily CI job runs the README quickstart
  against the hosted facilitator, so onboarding docs cannot silently rot.

## [0.5.0] - 2026-06-07

Bundles the pending-approval (HITL) feature, a set of correctness/security fixes
back-ported to the TypeScript SDK, and the Python 0.2.0 parity work with a new
CI gate. Published to npm as `paybot-sdk@0.5.0` (`latest`).

### Security

- **MPP / dual signature wire divergence (action required).** Versions `<= 0.4.2`
  produced MPP / dual-mode signatures that are **unverifiable on the wire**: the
  signer signed a payload whose `expires` / `paymentIntent` fields differed from
  the serialized, transmitted bytes, so a verifier reconstructing the signed
  message from what it received computes a different digest and rejects a
  structurally valid signature. The signer now signs exactly the wire bytes.
  All MPP / dual-signature users should upgrade to `0.5.0`. (#88)

### Added

- **Pending-approval (HITL) support** per the A5 contract (#89): `waitForApproval`
  to await resolution of a payment parked in `PENDING_APPROVAL` (approved →
  settles, denied → rejects), and x402 `202 Accepted` pass-through so pending
  payments propagate as a first-class outcome distinct from over-ceiling
  rejection.
- **Python SDK 0.2.0 parity** — x402-v2 dual-mode signing, AP2, MPP seam,
  telemetry, multi-bot client pool, middleware, 8-class error taxonomy (#70).
- **`python-tests` CI gate** — the Python suite now runs on every PR (it
  previously never ran in CI); post-mortem correction from PR #70.

### Fixed (TypeScript back-port of the PR #70 findings, #88)

- **Treasury validation + reservation race** — `client-pool` rejects invalid
  amounts and reserves the treasury before the await in `payAs`.
- **Idempotency race** — in-flight idempotent calls are shared; logical failures
  are no longer cached.
- **Money-math precision** — precision guard on micropayment amounts.
- **Batch / gas / auto-settle scoping** — loud batch ids, per-batch gas, and the
  auto-settle decision scoped to the target window.
- **x402-v2 hardening** — case-insensitive `Payment-Intent` header and a typed
  `INVALID_RECEIPT` error on 2xx bodies.
- **AP2 mandate windows** — sub-second windows are ceiled so they no longer fall
  back to the 300s default.

## [0.4.2] - 2026-06-06

Security and packaging point release (version bump only at the time; documented
here retroactively). Includes the open-core boundary tripwire hash fix (#86) so
the operator-private address the tripwire guards is no longer republished.

## [0.4.1] - 2026-06-04

Point release (version bump only at the time; documented here retroactively).

## [0.4.0] - YYYY-MM-DD

First release since the published `0.3.0`. It bundles three previously merged
but unreleased work streams (#57, #59, #62) together with this session's
multi-network, CLI, and Python-parity work, so the public surface that changed
since `0.3.0` ships in a single release.

### Added

- **Multi-network support** — Optimism, Arbitrum, and Polygon added alongside Base.
- **Token registry** — DAI added. EURC resolves on mainnet via the operator
  `tokenAddressOverrides` mechanism; testnet EURC remains in the public registry.
  (Premium token resolution stays operator-side per the open-core boundary, #62.)
- **`paybot` CLI** — `register`, `balance`, `pay`, `health`, `networks`, and
  `tokens` commands.
- **Examples ramp** — 7 runnable example apps under `examples/`.
- **Python SDK 0.2.0 x402-v2 parity** — dual-mode signing, AP2 support, an MPP
  seam, telemetry, a multi-bot client pool, middleware, and an 8-class error
  taxonomy.

### Changed

- Token resolution now respects the open-core boundary: premium tokens are
  resolved through operator-supplied `tokenAddressOverrides` rather than being
  bundled in the public registry (#62).

### Removed

- Stale `win32` `optionalDependencies` cleaned out of the dependency tree (B5
  dependency hygiene).

### Previously merged, now shipping

- **#57** — x402 v2 conformance, webhooks, and OpenTelemetry support.
- **#59** — EURC tokens, error taxonomy, idempotency, multi-bot pool, and the
  AP2/MPP seam.
- **#62** — open-core boundary: operator-override token resolution keeps premium
  token resolution out of the public SDK.

## [0.3.0]

Previously published baseline on npm.
