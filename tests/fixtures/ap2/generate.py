#!/usr/bin/env python3
# pyright: reportMissingImports=false, reportReturnType=false, reportUnusedImport=false, reportUnusedVariable=false
# (Imports the external google-agentic-commerce/AP2 reference SDK, present only in
#  the AC6 interop CI job / a local reference env — not in the default repo
#  toolchain. The unresolved-import + return-type warnings are expected and
#  harmless; this script SystemExit(2)s honestly if `ap2` is absent.)
# Copyright 2026 FriendlyAI / PayBot.
# SPDX-License-Identifier: Apache-2.0
#
# AP2 official-toolchain fixture generator (story AK-1, tasks T1/T8).
#
# This script drives the OFFICIAL google-agentic-commerce/AP2 reference SDK
# (the `ap2` Python package) to MINT real Intent and Cart mandate SD-JWTs and
# vendor them under tests/fixtures/ap2/ together with the issuer's public key.
#
# It is the AC6 interop generator: the fixtures it emits are produced by the
# reference SD-JWT issuer (`ap2.sdk.sdjwt.sd_jwt.create`, ES256, RFC 9901),
# NOT by our own signing code. Our TypeScript verifier then consumes them.
#
# WHY a generator instead of pre-signed checked-in samples vendored verbatim:
# the AP2 reference repo at the pinned commit ships NO pre-signed sample
# mandate VCs (only models, JSON schemas, and tests that mint at runtime).
# The honest "official sample" is therefore one we mint with the reference
# toolchain and pin by recording the exact commit + a deterministic issuer
# key. See PROVENANCE.md.
#
# Reproducibility: the issuer key is derived deterministically from a fixed
# label, so re-running this script against the same reference commit yields
# byte-stable issuer keys (the SD-JWT salts are random per RFC 9901, so the
# tokens themselves differ run-to-run — that is expected and fine, the
# verifier checks the signature, not a frozen token string).
#
# Usage (from a checkout of the reference repo):
#   PYTHONPATH=<AP2>/code/sdk/python \
#     python tests/fixtures/ap2/generate.py --out tests/fixtures/ap2 \
#       --ref-commit <sha>
#
# In CI this is invoked by .github/workflows/ap2-interop.yml.

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
from typing import Any


def _import_reference_sdk() -> None:
    """Verify the reference AP2 SDK imports or fail with an honest message."""
    try:
        from ap2.models.mandate import (  # noqa: F401
            CartContents,
            CartMandate,
            IntentMandate,
        )
        from ap2.models.payment_request import (  # noqa: F401
            PaymentCurrencyAmount,
            PaymentDetailsInit,
            PaymentItem,
            PaymentMethodData,
            PaymentRequest,
        )
        from ap2.sdk.sdjwt import sd_jwt  # noqa: F401
        from cryptography.hazmat.primitives.asymmetric import ec  # noqa: F401
        from jwcrypto.jwk import JWK  # noqa: F401
    except Exception as exc:  # pragma: no cover - environment guard
        sys.stderr.write(
            'FATAL: the google-agentic-commerce/AP2 reference SDK is not '
            'importable.\n'
            f'  ({type(exc).__name__}: {exc})\n'
            'Set PYTHONPATH to <AP2-checkout>/code/sdk/python and install its '
            'deps (jwcrypto, sd_jwt, pydantic, cryptography). This generator '
            'refuses to fabricate "official" fixtures without the real '
            'toolchain.\n'
        )
        raise SystemExit(2) from exc


def _deterministic_issuer_key(label: str) -> Any:
    """Derive a reproducible P-256 (ES256) issuer JWK from a fixed label."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from jwcrypto.jwk import JWK

    order = int(
        'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
        16,
    )
    digest = hashlib.sha256(label.encode('utf-8')).digest()
    secret = (int.from_bytes(digest, 'big') % (order - 1)) + 1
    priv = ec.derive_private_key(secret, ec.SECP256R1())
    jwk = JWK.from_pyca(priv)
    as_dict = json.loads(jwk.export())
    as_dict['kid'] = 'issuer-key-1'
    return JWK.from_json(json.dumps(as_dict))


def _disclosed_body(token: str, issuer_key: Any) -> dict[str, Any]:
    """Resolve the SD-JWT and return the single disclosed delegate body."""
    from ap2.sdk.sdjwt import sd_jwt
    from jwcrypto.jwk import JWK

    resolved = sd_jwt.verify(token, JWK.from_json(issuer_key.export_public()))
    dicts = [
        item
        for item in resolved.get('delegate_payload', [])
        if isinstance(item, dict)
    ]
    if len(dicts) != 1:
        raise RuntimeError(
            f'expected exactly 1 disclosed body, got {len(dicts)}'
        )
    return dicts[0]


def _public_jwk(issuer_key: Any) -> dict[str, str]:
    pub = json.loads(issuer_key.export_public())
    return {k: pub[k] for k in ('kty', 'crv', 'x', 'y')}


def _did_web(host: str) -> str:
    return f'did:web:{host}'


def _did_document(did: str, kid: str, jwk: dict[str, str]) -> dict[str, Any]:
    """A W3C DID document our verifier's pinned-cache resolver can consume."""
    return {
        'id': did,
        'verificationMethod': [
            {
                'id': kid,
                'type': 'JsonWebKey2020',
                'controller': did,
                'publicKeyJwk': {**jwk, 'kid': kid},
            }
        ],
        'assertionMethod': [kid],
    }


def _envelope(
    *,
    mandate_type: str,
    mandate_id: str,
    issuer_did: str,
    kid: str,
    token: str,
    subject: dict[str, Any],
    valid_until: str,
    valid_from: str | None = None,
    extra_subject: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Wrap an official SD-JWT in our Ap2MandateVc envelope.

    `credentialSubject` MUST equal the SD-JWT's disclosed delegate body
    (plus optional non-signed reference fields the verifier ignores for the
    signature binding) — our verifier checks the signed body canonically
    equals `credentialSubject`, so we pass the disclosed body through as-is.
    """
    subject_out = dict(subject)
    if extra_subject:
        # NOTE: extra fields would break the signature binding; only used for
        # types that the verifier reads outside the signed body. We keep this
        # empty in practice and assert equality in the test.
        subject_out.update(extra_subject)
    env: dict[str, Any] = {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        'type': ['VerifiableCredential', mandate_type],
        'id': mandate_id,
        'issuer': {'id': issuer_did},
        'validUntil': valid_until,
        'credentialSubject': subject_out,
        'proof': {'type': 'SdJwtProof', 'token': token},
    }
    if valid_from is not None:
        env['validFrom'] = valid_from
    return env


def main() -> int:
    _import_reference_sdk()
    from ap2.models.mandate import CartContents, CartMandate, IntentMandate
    from ap2.models.payment_request import (
        PaymentCurrencyAmount,
        PaymentDetailsInit,
        PaymentItem,
        PaymentMethodData,
        PaymentRequest,
    )
    from ap2.sdk.sdjwt import sd_jwt

    parser = argparse.ArgumentParser(description='AP2 fixture generator')
    parser.add_argument('--out', default='tests/fixtures/ap2')
    parser.add_argument(
        '--ref-commit',
        default='unknown',
        help='AP2 reference repo commit SHA (for PROVENANCE).',
    )
    args = parser.parse_args()

    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    issuer_host = 'issuer.ap2-sample.example'
    issuer_did = _did_web(issuer_host)
    kid = f'{issuer_did}#issuer-key-1'

    issuer_key = _deterministic_issuer_key('paybot-ap2-ak1-fixture-issuer-v1')
    pub_jwk = _public_jwk(issuer_key)

    # ---- Intent Mandate (real ap2.models.IntentMandate) -----------------
    intent_model = IntentMandate(
        natural_language_description=(
            'High top, old school, red basketball shoes'
        ),
        merchants=['did:web:merchant.ap2-sample.example'],
        intent_expiry='2027-01-01T00:00:00Z',
    )
    intent_token = sd_jwt.create(
        payload=intent_model, issuer_key=issuer_key
    ).sd_jwt_issuance
    intent_body = _disclosed_body(intent_token, issuer_key)
    intent_env = _envelope(
        mandate_type='IntentMandate',
        mandate_id='ap2-sample-intent-001',
        issuer_did=issuer_did,
        kid=kid,
        token=intent_token,
        subject=intent_body,
        valid_until='2027-01-01T00:00:00Z',
        valid_from='2026-01-01T00:00:00Z',
    )

    # ---- Cart Mandate (real ap2.models.CartMandate) ---------------------
    cart_model = CartMandate(
        contents=CartContents(
            id='cart_ak1_sample_001',
            user_cart_confirmation_required=True,
            payment_request=PaymentRequest(
                method_data=[
                    PaymentMethodData(supported_methods='basic-card')
                ],
                details=PaymentDetailsInit(
                    id='order_ref_001',
                    display_items=[
                        PaymentItem(
                            label='Red basketball shoes',
                            amount=PaymentCurrencyAmount(
                                currency='USD', value=120.0
                            ),
                        )
                    ],
                    total=PaymentItem(
                        label='Total',
                        amount=PaymentCurrencyAmount(
                            currency='USD', value=120.0
                        ),
                    ),
                ),
            ),
            cart_expiry='2027-01-01T00:00:00Z',
            merchant_name='AP2 Sample Merchant',
        )
    )
    cart_token = sd_jwt.create(
        payload=cart_model, issuer_key=issuer_key
    ).sd_jwt_issuance
    cart_body = _disclosed_body(cart_token, issuer_key)
    cart_env = _envelope(
        mandate_type='CartMandate',
        mandate_id='ap2-sample-cart-001',
        issuer_did=issuer_did,
        kid=kid,
        token=cart_token,
        subject=cart_body,
        valid_until='2027-01-01T00:00:00Z',
        valid_from='2026-01-01T00:00:00Z',
    )

    did_doc = _did_document(issuer_did, kid, pub_jwk)

    def _write(name: str, value: Any) -> None:
        path = out_dir / name
        path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
        sys.stdout.write(f'wrote {path}\n')

    _write('intent-mandate.vc.json', intent_env)
    _write('cart-mandate.vc.json', cart_env)
    _write('issuer-did-document.json', did_doc)
    _write(
        'meta.json',
        {
            'issuerDid': issuer_did,
            'kid': kid,
            'referenceRepo': 'https://github.com/google-agentic-commerce/AP2',
            'referenceCommit': args.ref_commit,
            'proofSuite': 'sd-jwt-es256',
            'note': (
                'Minted by the AP2 reference SD-JWT issuer '
                '(ap2.sdk.sdjwt.sd_jwt.create, ES256). Tokens carry random '
                'RFC 9901 salts; the issuer key is deterministic.'
            ),
        },
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
