"""Tests for the x402 v2 handler. Mirrors tests/x402-v2.test.ts.

Covers 402 parsing (v2 + legacy headers), dual-mode signing dispatch, the upto
metered-billing scheme + overcharge validation, header encode/decode, and
submit/verify over respx-mocked HTTP. Signing assertions use address recovery.
"""
from __future__ import annotations

import base64
import json

import pytest
import respx
from eth_account import Account
from eth_account.messages import encode_typed_data
from httpx import Response

from paybot_sdk.errors import PayBotApiError
from paybot_sdk.networks import EIP3009_TYPES, get_eip712_domain
from paybot_sdk.x402_v2 import X402Handler
from paybot_sdk.types import (
    PaymentIntent,
    PaymentPayload,
    PaymentRequiredResponse,
    PaymentRequirements,
)

TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
TEST_ADDR = Account.from_key(TEST_KEY).address
PAY_TO = "0x000000000000000000000000000000000000dEaD"


def _reqs(**kw) -> PaymentRequirements:
    base = dict(
        scheme="exact",
        network="eip155:84532",
        asset="eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount="10000",
        pay_to=PAY_TO,
        max_timeout_seconds=300,
    )
    base.update(kw)
    return PaymentRequirements(**base)


def _payload(protocol="x402", scheme="exact", **reqkw) -> PaymentPayload:
    reqs = _reqs(scheme=scheme, **reqkw)
    intent = PaymentIntent(
        intent_id="intent_1",
        protocol=protocol,
        requirements=reqs,
        version="2.0",
        created_at="2026-01-01T00:00:00.000Z",
        expires_at="2026-01-01T00:05:00.000Z",
    )
    return PaymentPayload(payment_intent=intent, requirements=reqs)


# ── constructor ───────────────────────────────────────────────────────────


def test_constructor_rejects_non_0x_key():
    with pytest.raises(ValueError, match="0x"):
        X402Handler("abc")


def test_constructor_allows_no_key_for_parsing():
    h = X402Handler()
    assert h is not None


# ── on_402_response ───────────────────────────────────────────────────────


def test_on_402_rejects_non_402_status():
    h = X402Handler()
    with pytest.raises(PayBotApiError) as exc:
        h.on_402_response(PaymentRequiredResponse(status=200, headers={}, body={}))
    assert exc.value.code == "INVALID_HTTP_STATUS"


def test_on_402_parses_v2_payment_required_header():
    h = X402Handler()
    reqs_dict = {
        "scheme": "exact",
        "network": "eip155:84532",
        "asset": "x",
        "amount": "10000",
        "payTo": PAY_TO,
        "maxTimeoutSeconds": 300,
    }
    header = base64.b64encode(json.dumps(reqs_dict).encode()).decode()
    payload = h.on_402_response(
        PaymentRequiredResponse(
            status=402,
            headers={"PAYMENT-REQUIRED": header},
            body={"requirements": reqs_dict},
        )
    )
    assert payload.requirements.amount == "10000"
    assert payload.payment_intent.protocol == "x402"


def test_on_402_parses_legacy_payment_intent_header():
    h = X402Handler()
    reqs_dict = {
        "scheme": "exact",
        "network": "eip155:84532",
        "asset": "x",
        "amount": "5000",
        "payTo": PAY_TO,
        "maxTimeoutSeconds": 300,
    }
    intent = {"intentId": "i1", "protocol": "x402", "requirements": reqs_dict, "version": "2.0"}
    encoded = base64.b64encode(json.dumps(intent).encode()).decode()
    payload = h.on_402_response(
        PaymentRequiredResponse(
            status=402,
            headers={"Payment-Intent": f"x402:v2:{encoded}"},
            body={"requirements": reqs_dict},
        )
    )
    assert payload.payment_intent.intent_id == "i1"
    assert payload.requirements.amount == "5000"


def test_on_402_legacy_header_is_fully_case_insensitive():
    # CodeRabbit #14: the legacy Payment-Intent extractor previously checked only
    # two hardcoded casings ("Payment-Intent"/"payment-intent") and missed e.g.
    # the fully-uppercase form. It must read the header case-insensitively.
    h = X402Handler()
    reqs_dict = {
        "scheme": "exact",
        "network": "eip155:84532",
        "asset": "x",
        "amount": "6000",
        "payTo": PAY_TO,
        "maxTimeoutSeconds": 300,
    }
    intent = {"intentId": "i2", "protocol": "x402", "requirements": reqs_dict, "version": "2.0"}
    encoded = base64.b64encode(json.dumps(intent).encode()).decode()
    payload = h.on_402_response(
        PaymentRequiredResponse(
            status=402,
            headers={"PAYMENT-INTENT": f"x402:v2:{encoded}"},  # all-caps casing
            body={"requirements": reqs_dict},
        )
    )
    assert payload.payment_intent.intent_id == "i2"
    assert payload.requirements.amount == "6000"


def test_on_402_missing_header_raises():
    h = X402Handler()
    with pytest.raises(PayBotApiError) as exc:
        h.on_402_response(PaymentRequiredResponse(status=402, headers={}, body={"requirements": {}}))
    assert exc.value.code == "MISSING_PAYMENT_INTENT_HEADER"


def test_on_402_missing_requirements_in_body_raises():
    h = X402Handler()
    reqs_dict = {"scheme": "exact", "amount": "1", "payTo": PAY_TO, "maxTimeoutSeconds": 1}
    header = base64.b64encode(json.dumps(reqs_dict).encode()).decode()
    with pytest.raises(PayBotApiError) as exc:
        h.on_402_response(
            PaymentRequiredResponse(status=402, headers={"PAYMENT-REQUIRED": header}, body={})
        )
    assert exc.value.code == "MISSING_PAYMENT_REQUIREMENTS"


# ── signing: dispatch + recovery ─────────────────────────────────────────


def _recover_x402(signed_data) -> str:
    domain = get_eip712_domain("eip155:84532", "USDC")
    message = {
        "from": signed_data["from"],
        "to": signed_data["to"],
        "value": int(signed_data["value"]),
        "validAfter": int(signed_data["validAfter"]),
        "validBefore": int(signed_data["validBefore"]),
        "nonce": signed_data["nonce"],
    }
    encoded = encode_typed_data(domain, EIP3009_TYPES, message)
    return Account.recover_message(encoded, signature=signed_data["signature"])


def test_sign_payment_x402_recovers_signer():
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload(protocol="x402"))
    assert signed.protocol == "x402"
    assert _recover_x402(signed.signed_data).lower() == TEST_ADDR.lower()


def test_sign_payment_mpp_differs_from_x402():
    h = X402Handler(TEST_KEY)
    x = h.sign_payment(_payload(protocol="x402"))
    m = h.sign_payment(_payload(protocol="mpp"))
    assert m.protocol == "mpp"
    # Distinct typed-data structures → distinct signatures.
    assert m.signature != x.signature
    assert "payer" in m.signed_data


def test_sign_payment_dual_packs_both():
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload(protocol="dual"))
    assert signed.protocol == "dual"
    assert "x402" in signed.signed_data and "mpp" in signed.signed_data
    # Top-level signature mirrors the x402 (primary) signature.
    assert signed.signature == signed.signed_data["x402"]["signature"]
    # The MPP arm carries a real signature too.
    assert signed.signed_data["mpp"]["signature"].startswith("0x")


def _recover_mpp(signed_data) -> str:
    """Recover the MPP PaymentAuthorization signer from on-wire signed_data.

    Mirrors :func:`_recover_x402` but for the MPP typed-data structure. This is
    the regression guard for CodeRabbit #15: it re-derives the signed message
    purely from what was serialized onto the wire (``signed_data``) and asserts
    the recovered signer. If the signed ``expires`` and the serialized
    ``expires`` ever diverge again, recovery yields a different address and the
    test fails.
    """
    from paybot_sdk.x402_v2 import _MPP_TYPES

    domain = {
        "name": "Machine Payments Protocol",
        "version": "1.0",
        "chainId": 1,
        "verifyingContract": signed_data["recipient"],
    }
    message = {
        "payer": signed_data["payer"],
        "recipient": signed_data["recipient"],
        "amount": int(signed_data["amount"]),
        "nonce": signed_data["nonce"],
        "expires": int(signed_data["expires"]),
        "paymentIntent": signed_data["paymentIntent"],
    }
    encoded = encode_typed_data(domain, _MPP_TYPES, message)
    return Account.recover_message(encoded, signature=signed_data["signature"])


def test_sign_payment_mpp_recovers_signer():
    # Regression for CodeRabbit #15: before the fix, _sign_mpp signed
    # expires=now+3600 but serialized expires=str(now), so recovery from the
    # wire payload produced a different address and this assertion failed.
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload(protocol="mpp"))
    assert signed.protocol == "mpp"
    assert _recover_mpp(signed.signed_data).lower() == TEST_ADDR.lower()


def test_sign_payment_dual_mpp_arm_recovers_signer():
    # The dual-mode MPP arm must also be wire-consistent (same #15 root cause).
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload(protocol="dual"))
    assert _recover_mpp(signed.signed_data["mpp"]).lower() == TEST_ADDR.lower()


def test_sign_payment_missing_wallet_key_raises():
    h = X402Handler()
    with pytest.raises(PayBotApiError) as exc:
        h.sign_payment(_payload())
    assert exc.value.code == "MISSING_WALLET_KEY"


def test_sign_payment_unsupported_protocol_raises():
    h = X402Handler(TEST_KEY)
    payload = _payload()
    payload.payment_intent.protocol = "bogus"  # type: ignore[assignment]
    with pytest.raises(PayBotApiError) as exc:
        h.sign_payment(payload)
    assert exc.value.code == "UNSUPPORTED_PROTOCOL"


def test_sign_payment_unsupported_network_raises():
    h = X402Handler(TEST_KEY)
    with pytest.raises(PayBotApiError) as exc:
        h.sign_payment(_payload(network="eip155:999999"))
    assert exc.value.code == "UNSUPPORTED_NETWORK"


# ── upto scheme ───────────────────────────────────────────────────────────


def test_sign_payment_upto_signs_max():
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload(scheme="upto", max_amount="50000"))
    assert signed.signed_data["scheme"] == "upto"
    assert signed.signed_data["value"] == "50000"  # signs the MAX
    assert signed.signed_data["maxAmount"] == "50000"


def test_sign_upto_falls_back_to_amount_without_max():
    h = X402Handler(TEST_KEY)
    acct = Account.from_key(TEST_KEY)
    r = h.sign_upto(acct, _reqs(scheme="upto", amount="7777"))
    assert r["signed_data"]["value"] == "7777"


def test_validate_upto_capture_allows_under_and_equal():
    assert X402Handler.validate_upto_capture("5000000", "3000000") == "3000000"
    assert X402Handler.validate_upto_capture("5000000", "5000000") == "5000000"


def test_validate_upto_capture_overcharge_raises():
    with pytest.raises(PayBotApiError) as exc:
        X402Handler.validate_upto_capture("5000000", "6000000")
    assert exc.value.code == "UPTO_OVERCHARGE"
    assert exc.value.status_code == 402


def test_validate_upto_capture_invalid_amount_raises():
    with pytest.raises(PayBotApiError) as exc:
        X402Handler.validate_upto_capture("5000000", "-1")
    assert exc.value.code == "INVALID_AMOUNT"


# ── headers ───────────────────────────────────────────────────────────────


def test_encode_payment_signature_header_roundtrip():
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload())
    header = X402Handler.encode_payment_signature_header(signed)
    decoded = json.loads(base64.b64decode(header).decode())
    assert decoded["protocol"] == "x402"
    assert decoded["signature"] == signed.signature


def test_parse_payment_response_header_happy():
    b64 = base64.b64encode(
        json.dumps({"receiptId": "r1", "status": "confirmed", "txHash": "0xabc"}).encode()
    ).decode()
    conf = X402Handler.parse_payment_response_header(b64)
    assert conf.receipt_id == "r1"
    assert conf.status == "confirmed"
    assert conf.transaction_id == "0xabc"


def test_parse_payment_response_header_defaults_status_pending():
    b64 = base64.b64encode(json.dumps({"receipt_id": "r2"}).encode()).decode()
    conf = X402Handler.parse_payment_response_header(b64)
    assert conf.receipt_id == "r2"
    assert conf.status == "pending"


def test_parse_payment_response_header_missing_receipt_raises():
    b64 = base64.b64encode(json.dumps({"status": "confirmed"}).encode()).decode()
    with pytest.raises(PayBotApiError) as exc:
        X402Handler.parse_payment_response_header(b64)
    assert exc.value.code == "INVALID_PAYMENT_RESPONSE"


def test_parse_payment_response_header_bad_base64_raises():
    with pytest.raises(PayBotApiError) as exc:
        X402Handler.parse_payment_response_header("!!!not-base64!!!")
    assert exc.value.code == "INVALID_PAYMENT_RESPONSE"


# ── submit / verify ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_submit_payment_returns_receipt():
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload())
    with respx.mock:
        route = respx.post("https://merchant.example/settle").mock(
            return_value=Response(
                200,
                json={
                    "receiptId": "rcpt_1",
                    "transactionId": "0xtx",
                    "status": "confirmed",
                    "amount": "10000",
                    "network": "eip155:84532",
                },
            )
        )
        receipt = await h.submit_payment(signed, "https://merchant.example/settle")
    assert route.called
    assert receipt.receipt_id == "rcpt_1"
    assert receipt.status == "confirmed"
    # Both v1 + v2 headers were sent.
    req = route.calls.last.request
    assert "Payment-Intent-Authorization" in req.headers
    assert "PAYMENT-SIGNATURE" in req.headers


@pytest.mark.asyncio
async def test_submit_payment_non_2xx_raises():
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload())
    with respx.mock:
        respx.post("https://merchant.example/settle").mock(
            return_value=Response(400, json={"error": "bad", "code": "BAD_REQ"})
        )
        with pytest.raises(PayBotApiError) as exc:
            await h.submit_payment(signed, "https://merchant.example/settle")
    assert exc.value.code == "BAD_REQ"


@pytest.mark.asyncio
async def test_submit_payment_malformed_2xx_json_raises_api_error():
    # CodeRabbit #16: a 2xx with a non-JSON body must surface as a typed
    # PayBotApiError, not a bare ValueError from response.json().
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload())
    with respx.mock:
        respx.post("https://merchant.example/settle").mock(
            return_value=Response(200, content=b"not json", headers={"content-type": "text/plain"})
        )
        with pytest.raises(PayBotApiError) as exc:
            await h.submit_payment(signed, "https://merchant.example/settle")
    assert exc.value.code == "INVALID_RECEIPT"


@pytest.mark.asyncio
async def test_submit_payment_2xx_missing_receipt_id_raises_api_error():
    # CodeRabbit #16: a 2xx JSON body lacking receiptId must not KeyError.
    h = X402Handler(TEST_KEY)
    signed = h.sign_payment(_payload())
    with respx.mock:
        respx.post("https://merchant.example/settle").mock(
            return_value=Response(200, json={"status": "confirmed"})
        )
        with pytest.raises(PayBotApiError) as exc:
            await h.submit_payment(signed, "https://merchant.example/settle")
    assert exc.value.code == "INVALID_RECEIPT"


@pytest.mark.asyncio
async def test_verify_receipt_true_false_paths():
    h = X402Handler(TEST_KEY)
    from paybot_sdk.types import Receipt

    receipt = Receipt(receipt_id="r", status="confirmed", amount="1", network="eip155:84532")
    with respx.mock:
        respx.post("https://merchant.example/verify").mock(
            return_value=Response(200, json={"verified": True})
        )
        assert await h.verify_receipt(receipt, "https://merchant.example/verify") is True
    with respx.mock:
        respx.post("https://merchant.example/verify").mock(
            return_value=Response(200, json={"verified": False})
        )
        assert await h.verify_receipt(receipt, "https://merchant.example/verify") is False


@pytest.mark.asyncio
async def test_verify_receipt_swallows_transport_error():
    h = X402Handler(TEST_KEY)
    from paybot_sdk.types import Receipt

    receipt = Receipt(receipt_id="r", status="confirmed", amount="1", network="eip155:84532")
    with respx.mock:
        import httpx

        respx.post("https://merchant.example/verify").mock(side_effect=httpx.ConnectError("x"))
        assert await h.verify_receipt(receipt, "https://merchant.example/verify") is False
