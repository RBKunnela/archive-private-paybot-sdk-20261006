# AP2 official-toolchain fixtures — provenance (story AK-1, T1/AC1/AC6)

These fixtures back the claim that PayBot's AP2 verifier consumes credentials
produced by the **official `google-agentic-commerce/AP2` reference toolchain**,
not just by our own test signer.

## Source

| Field | Value |
|---|---|
| Reference repo | https://github.com/google-agentic-commerce/AP2 |
| Reference commit | `e1ea56db72a6385bce3e5c1112b3a56ce60acb43` |
| Commit date | 2026-04-29 |
| Retrieved | 2026-06-13 |
| Reference SDK path | `code/sdk/python` (the `ap2` package) |
| Signer used | `ap2.sdk.sdjwt.sd_jwt.create` (ES256, RFC 9901 SD-JWT) |
| Mandate models used | `ap2.models.mandate.IntentMandate`, `ap2.models.mandate.CartMandate` |
| Proof suite | `sd-jwt-es256` (the only suite the reference SDK emits at this commit) |

This commit is **identical to the spec-pin** already recorded in
`src/ap2-vc.ts`'s module docstring — the conformance target has not moved.

## Why these are minted, not copied verbatim

The AP2 reference repo at the pinned commit **ships no pre-signed sample
mandate VCs**. It ships the Pydantic mandate models, JSON schemas, and tests
that mint SD-JWTs at runtime — but no committed `*.sd-jwt` / signed-JSON
artifacts to copy. (Verified: `find . -iname '*mandate*' -o -iname '*.jwt'`
returns only source, schemas, docs, and unsigned A2A `agent.json` cards.)

The honest "official sample" is therefore one **minted with the reference
signer**: `tests/fixtures/ap2/generate.py` drives `ap2.sdk.sdjwt.sd_jwt.create`
over the genuine `ap2.models.IntentMandate` / `CartMandate` bodies, using a
**deterministic** ES256 issuer key (derived from a fixed label, so the issuer
public key is byte-stable across runs). The SD-JWT tokens themselves carry
random RFC 9901 salts and so differ run-to-run — that is by design; the
verifier checks the cryptographic signature, never a frozen token string.

These are NOT credentials signed by Google or by any production AP2 issuer.
They are signed by the **reference SD-JWT issuer code** with a test key whose
public half is pinned in `issuer-did-document.json`. That is the strongest
"official toolchain" evidence the upstream repo permits at this commit.

## Files

| File | What it is |
|---|---|
| `intent-mandate.vc.json` | `ap2.models.IntentMandate` body, signed by the reference SD-JWT issuer, wrapped in our `Ap2MandateVc` envelope. |
| `cart-mandate.vc.json` | `ap2.models.CartMandate` body, same treatment. |
| `issuer-did-document.json` | The DID document publishing the deterministic issuer's P-256 public key (the pinned offline trust anchor). |
| `meta.json` | Machine-readable issuer DID, kid, reference commit, proof suite. |
| `generate.py` | The generator. Re-run against a reference checkout to regenerate (see below). |

## Regenerating

```bash
git clone --depth 1 https://github.com/google-agentic-commerce/AP2 /tmp/ap2-ref
SHA=$(git -C /tmp/ap2-ref rev-parse HEAD)
PYTHONPATH=/tmp/ap2-ref/code/sdk/python \
  python tests/fixtures/ap2/generate.py --out tests/fixtures/ap2 --ref-commit "$SHA"
```

If `$SHA` differs from the pinned commit above, that is itself a finding:
re-pin the suite in `src/ap2-vc.ts` and update this file.

## Interop finding (AC1, recorded 2026-06-13)

Verifying these official-toolchain fixtures surfaced a real defect in the
merged verify pipeline: the reference SD-JWT issuer emits a **bare** JOSE
`kid` (e.g. `issuer-key-1`), but the verifier originally required the `kid`
to equal a DID-fragment-qualified verificationMethod id
(`did:web:...#issuer-key-1`). The two are different namespaces. Fixed in
`src/ap2-vc.ts` (kid now also matches the VM-id fragment / `<did>#<kid>`),
without weakening the cross-issuer-confusion guard (candidate keys still come
only from the issuer's own DID document). Without the fix, AC1 fails closed
with `AP2_KEY_RESOLUTION_FAILED` on every reference-issued mandate — the
fixtures earned the fix.
