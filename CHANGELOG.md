# Changelog

All notable changes to `paybot-sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog covers the TypeScript package (`paybot-sdk` on npm). The Python
port (`packages/python/`, published to PyPI) is versioned independently and ships
at `0.2.0` alongside this release.

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
