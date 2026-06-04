"""Tests for X402Handler — x402 v2 handler + dual-mode signing.
Mirrors ``tests/x402-v2.test.ts``.

Highest-risk module. Heavy on signing branches + header parse/encode round-trips.
Uses a deterministic throwaway key and never hits the network (signing is local;
``submit_payment`` / ``verify_receipt`` are respx-mocked).

Includes the GOLDEN-VECTOR regression lock for USDC ``_sign_payload`` so the
existing real-mode ``pay()`` signature does not regress.
"""
from __future__ import annotations

import base64
import json
from unittest import mock

import pytest
import respx
from eth_account import Account
from eth_account.messages import encode_typed_data
from httpx import Response

from paybot_sdk import PayBotClient, PayBotConfig
from paybot_sdk.errors import PayBotApiError
from paybot_sdk.networks import EIP3009_TYPES, get_eip712_domain
from paybot_sdk.types import (
    PaymentIntent,
    PaymentPayload,
    PaymentRequiredResponse,
    PaymentRequirements,
    PaymentRequest,
    Receipt,
    SignedPayment,
)
from paybot_sdk.x402 import X402Handler

TEST_PK = "0x" + "1" * 64
TEST_ADDR = Account.from_key(TEST_PK).address
PAY_TO = "0x000000000000000000000000000000000000dEaD"
NETWORK = "eip155:84532"


def _reqs(scheme="exact", token=None, network=NETWORK, amount="50000", max_amount=None):
    return PaymentRequirements(
        scheme=scheme,
        network=network,
        asset=f"{network}/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount=amount,
        pay_to=PAY_TO,
        max_timeout_seconds=300,
        token=token,
        max_amount=max_amount,
    )


def _payload(protocol, scheme="exact", token=None, amount="50000", max_amount=None, network=NETWORK):
    reqs = _reqs(scheme=scheme, token=token, amount=amount, max_amount=max_amount, network=network)
    intent = PaymentIntent(
        intent_id="intent_abc",
        protocol=protocol,
        requirements=reqs,
        version="2.0",
        created_at="2026-01-01T00:00:00.000Z",
        expires_at="2026-01-01T00:05:00.000Z",
    )
    return PaymentPayload(payment_intent=intent, requirements=reqs)


# ── constructor ────────────────────────────────────────────────────────────


def test_constructor_accepts_no_key():
    h = X402Handler()
    assert h is not None


def test_constructor_accepts_0x_key():
    h = X402Handler(TEST_PK)
    assert h is not None


def test_constructor_rejects_non_0x_key():
    with pytest.raises(ValueError, match="0x"):
        X402Handler("abc123")


# ── sign_payment dispatch ──────────────────────────────────────────────────


async def test_sign_payment_missing_key_raises():
    h = X402Handler()
    with pytest.raises(PayBotApiError) as ei:
        await h.sign_payment(_payload("x402"))
    assert ei.value.code == "MISSING_WALLET_KEY"
    assert ei.value.status_code == 402


async def test_sign_payment_unsupported_protocol_raises():
    h = X402Handler(TEST_PK)
    with pytest.raises(PayBotApiError) as ei:
        await h.sign_payment(_payload("ripple"))
    assert ei.value.code == "UNSUPPORTED_PROTOCOL"
    assert ei.value.status_code == 402


async def test_sign_payment_x402_shape():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("x402"))
    assert signed.protocol == "x402"
    assert signed.signature.startswith("0x")
    assert len(signed.signature) == 132
    assert set(signed.signed_data.keys()) == {
        "from", "to", "value", "validAfter", "validBefore", "nonce", "signature",
    }
    assert signed.signed_data["from"] == TEST_ADDR
    assert signed.signed_data["to"] == PAY_TO
    assert signed.signed_data["value"] == "50000"
    assert isinstance(signed.timestamp, int)


async def test_sign_payment_mpp_shape():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("mpp"))
    assert signed.protocol == "mpp"
    assert set(signed.signed_data.keys()) == {
        "payer", "recipient", "amount", "nonce", "expires", "paymentIntent", "signature",
    }
    assert signed.signed_data["payer"] == TEST_ADDR
    assert signed.signed_data["paymentIntent"] == "intent_abc"


async def test_sign_payment_mpp_unknown_intent_falls_back():
    h = X402Handler(TEST_PK)
    p = _payload("mpp")
    p.payment_intent.intent_id = ""
    signed = await h.sign_payment(p)
    # signed_data carries the original (falsy) intent id; the SIGNED message uses 'unknown'.
    assert signed.signed_data["paymentIntent"] == ""


async def test_sign_payment_dual_packs_both():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("dual"))
    assert signed.protocol == "dual"
    assert set(signed.signed_data.keys()) == {"x402", "mpp"}
    assert "signature" in signed.signed_data["x402"]
    assert "signature" in signed.signed_data["mpp"]


async def test_sign_payment_dual_primary_is_x402():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("dual"))
    assert signed.signature == signed.signed_data["x402"]["signature"]


async def test_x402_and_mpp_signatures_differ():
    """Critical correctness property: different typed-data → different signatures."""
    h = X402Handler(TEST_PK)
    sx = await h.sign_payment(_payload("x402"))
    sm = await h.sign_payment(_payload("mpp"))
    assert sx.signature != sm.signature


async def test_dual_inner_x402_mpp_signatures_differ():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("dual"))
    assert signed.signed_data["x402"]["signature"] != signed.signed_data["mpp"]["signature"]


async def test_x402_signature_recovers_signer():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("x402"))
    blob = signed.signed_data
    message = {
        "from": blob["from"],
        "to": blob["to"],
        "value": int(blob["value"]),
        "validAfter": int(blob["validAfter"]),
        "validBefore": int(blob["validBefore"]),
        "nonce": blob["nonce"],
    }
    encoded = encode_typed_data(get_eip712_domain(NETWORK, "USDC"), EIP3009_TYPES, message)
    recovered = Account.recover_message(encoded, signature=blob["signature"])
    assert recovered.lower() == TEST_ADDR.lower()


# ── token-specific domain ──────────────────────────────────────────────────


async def test_eurc_signs_differently_from_usdc():
    h = X402Handler(TEST_PK)
    su = await h.sign_payment(_payload("x402", token="USDC"))
    se = await h.sign_payment(_payload("x402", token="EURC"))
    assert su.signature != se.signature


async def test_sign_unsupported_token_raises():
    h = X402Handler(TEST_PK)
    with pytest.raises(PayBotApiError) as ei:
        await h.sign_payment(_payload("x402", token="DOGE"))
    assert ei.value.code == "UNSUPPORTED_TOKEN"
    assert ei.value.status_code == 402


async def test_sign_invalid_caip2_network_raises():
    h = X402Handler(TEST_PK)
    with pytest.raises(PayBotApiError) as ei:
        await h.sign_payment(_payload("x402", network="not-a-network"))
    assert ei.value.code == "INVALID_CAIP2"


async def test_sign_unsupported_network_raises():
    h = X402Handler(TEST_PK)
    with pytest.raises(PayBotApiError) as ei:
        await h.sign_payment(_payload("x402", network="eip155:999999"))
    assert ei.value.code == "UNSUPPORTED_NETWORK"


# ── upto scheme ────────────────────────────────────────────────────────────


async def test_upto_dispatched_on_scheme():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("x402", scheme="upto", amount="50000"))
    assert signed.signed_data["scheme"] == "upto"
    assert signed.signed_data["maxAmount"] == "50000"


async def test_upto_signs_max_amount_when_present():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(
        _payload("x402", scheme="upto", amount="1000", max_amount="5000000")
    )
    assert signed.signed_data["value"] == "5000000"
    assert signed.signed_data["maxAmount"] == "5000000"


def test_validate_upto_capture_ok():
    assert X402Handler.validate_upto_capture("5000000", "3000000") == "3000000"


def test_validate_upto_capture_equal_max_ok():
    assert X402Handler.validate_upto_capture("5000000", "5000000") == "5000000"


def test_validate_upto_capture_overcharge_raises():
    with pytest.raises(PayBotApiError) as ei:
        X402Handler.validate_upto_capture("5000000", "6000000")
    assert ei.value.code == "UPTO_OVERCHARGE"
    assert ei.value.status_code == 402


def test_validate_upto_capture_non_integer_raises():
    with pytest.raises(PayBotApiError) as ei:
        X402Handler.validate_upto_capture("5000000", "3.5")
    assert ei.value.code == "INVALID_AMOUNT"
    assert ei.value.status_code == 400


def test_validate_upto_capture_negative_raises():
    with pytest.raises(PayBotApiError):
        X402Handler.validate_upto_capture("5000000", "-1")


# ── on_402_response parsing ────────────────────────────────────────────────


def _b64(obj):
    return base64.b64encode(json.dumps(obj).encode()).decode()


def test_on_402_wrong_status_raises():
    h = X402Handler()
    resp = PaymentRequiredResponse(status=200, headers={}, body={})
    with pytest.raises(PayBotApiError) as ei:
        h.on_402_response(resp)
    assert ei.value.code == "INVALID_HTTP_STATUS"


def test_on_402_missing_payment_intent_header_raises():
    h = X402Handler()
    resp = PaymentRequiredResponse(status=402, headers={}, body={"requirements": {}})
    with pytest.raises(PayBotApiError) as ei:
        h.on_402_response(resp)
    assert ei.value.code == "MISSING_PAYMENT_INTENT_HEADER"


def test_on_402_legacy_payment_intent_header():
    h = X402Handler()
    intent = {
        "intentId": "i1",
        "protocol": "x402",
        "requirements": {"scheme": "exact", "network": NETWORK, "asset": "a",
                          "amount": "1", "payTo": PAY_TO, "maxTimeoutSeconds": 300},
        "version": "2.0", "createdAt": "t", "expiresAt": "t",
    }
    header = "x402:v2:" + _b64(intent)
    body = {"requirements": {"scheme": "exact", "network": NETWORK, "asset": "a",
                             "amount": "1", "payTo": PAY_TO, "maxTimeoutSeconds": 300}}
    resp = PaymentRequiredResponse(status=402, headers={"Payment-Intent": header}, body=body)
    payload = h.on_402_response(resp)
    assert payload.payment_intent.intent_id == "i1"
    assert payload.requirements.pay_to == PAY_TO


def test_on_402_v2_payment_required_header():
    h = X402Handler()
    intent = {
        "intentId": "i2", "protocol": "x402",
        "requirements": {"scheme": "exact", "network": NETWORK, "asset": "a",
                         "amount": "1", "payTo": PAY_TO, "maxTimeoutSeconds": 300},
        "version": "2.0", "createdAt": "t", "expiresAt": "t",
    }
    body = {"requirements": {"scheme": "exact", "network": NETWORK, "asset": "a",
                             "amount": "1", "payTo": PAY_TO, "maxTimeoutSeconds": 300}}
    resp = PaymentRequiredResponse(
        status=402, headers={"PAYMENT-REQUIRED": _b64(intent)}, body=body
    )
    payload = h.on_402_response(resp)
    assert payload.payment_intent.intent_id == "i2"


def test_on_402_v2_header_case_insensitive():
    h = X402Handler()
    reqs = {"scheme": "exact", "network": NETWORK, "asset": "a", "amount": "1",
            "payTo": PAY_TO, "maxTimeoutSeconds": 300}
    body = {"requirements": reqs}
    resp = PaymentRequiredResponse(
        status=402, headers={"payment-required": _b64(reqs)}, body=body
    )
    payload = h.on_402_response(resp)
    # bare requirements wrapped into a synthetic intent
    assert payload.payment_intent.protocol == "x402"


def test_on_402_bad_base64_intent_raises():
    h = X402Handler()
    resp = PaymentRequiredResponse(
        status=402, headers={"Payment-Intent": "x402:v2:!!!notbase64!!!"},
        body={"requirements": {}},
    )
    with pytest.raises(PayBotApiError) as ei:
        h.on_402_response(resp)
    assert ei.value.code == "INVALID_PAYMENT_INTENT_FORMAT"


def test_on_402_invalid_body_raises():
    h = X402Handler()
    intent = {"requirements": {}}
    resp = PaymentRequiredResponse(
        status=402, headers={"Payment-Intent": "x402:v2:" + _b64(intent)}, body=None
    )
    with pytest.raises(PayBotApiError) as ei:
        h.on_402_response(resp)
    assert ei.value.code == "INVALID_PAYMENT_BODY"


def test_on_402_missing_requirements_raises():
    h = X402Handler()
    intent = {"requirements": {"scheme": "exact"}}
    resp = PaymentRequiredResponse(
        status=402, headers={"Payment-Intent": "x402:v2:" + _b64(intent)},
        body={"merchant": {"name": "m", "url": "u"}},
    )
    with pytest.raises(PayBotApiError) as ei:
        h.on_402_response(resp)
    assert ei.value.code == "MISSING_PAYMENT_REQUIREMENTS"


def test_on_402_bad_legacy_prefix_raises():
    h = X402Handler()
    resp = PaymentRequiredResponse(
        status=402, headers={"Payment-Intent": "wrong:v2:" + _b64({"requirements": {}})},
        body={"requirements": {}},
    )
    with pytest.raises(PayBotApiError) as ei:
        h.on_402_response(resp)
    assert ei.value.code == "INVALID_PAYMENT_INTENT_FORMAT"


# ── header encode / parse round-trips ──────────────────────────────────────


def _signed():
    return SignedPayment(
        protocol="x402",
        signed_data={"from": TEST_ADDR, "to": PAY_TO, "signature": "0xabc"},
        signature="0xabc",
        timestamp=1_700_000_000_000,
    )


def test_encode_payment_signature_header_is_bare_base64():
    enc = X402Handler.encode_payment_signature_header(_signed())
    decoded = json.loads(base64.b64decode(enc).decode())
    assert decoded["protocol"] == "x402"
    assert decoded["signature"] == "0xabc"
    assert decoded["timestamp"] == 1_700_000_000_000


def test_parse_payment_response_header_round_trip():
    payload = {"receiptId": "r1", "status": "confirmed", "transactionId": "0xtx"}
    enc = base64.b64encode(json.dumps(payload).encode()).decode()
    conf = X402Handler.parse_payment_response_header(enc)
    assert conf.receipt_id == "r1"
    assert conf.status == "confirmed"
    assert conf.transaction_id == "0xtx"


def test_parse_payment_response_header_snake_case_variants():
    payload = {"receipt_id": "r2", "status": "pending", "txHash": "0xhh"}
    enc = base64.b64encode(json.dumps(payload).encode()).decode()
    conf = X402Handler.parse_payment_response_header(enc)
    assert conf.receipt_id == "r2"
    assert conf.transaction_id == "0xhh"


def test_parse_payment_response_header_defaults_status_pending():
    payload = {"receiptId": "r3", "status": "weird"}
    enc = base64.b64encode(json.dumps(payload).encode()).decode()
    conf = X402Handler.parse_payment_response_header(enc)
    assert conf.status == "pending"


def test_parse_payment_response_header_bad_base64_raises():
    with pytest.raises(PayBotApiError) as ei:
        X402Handler.parse_payment_response_header("!!!notb64!!!")
    assert ei.value.code == "INVALID_PAYMENT_RESPONSE"
    assert ei.value.status_code == 502


def test_parse_payment_response_header_missing_receipt_id_raises():
    enc = base64.b64encode(json.dumps({"status": "confirmed"}).encode()).decode()
    with pytest.raises(PayBotApiError) as ei:
        X402Handler.parse_payment_response_header(enc)
    assert ei.value.code == "INVALID_PAYMENT_RESPONSE"


def test_parse_payment_response_header_non_object_raises():
    enc = base64.b64encode(json.dumps([1, 2, 3]).encode()).decode()
    with pytest.raises(PayBotApiError):
        X402Handler.parse_payment_response_header(enc)


def test_create_payment_intent_header_round_trips():
    reqs = _reqs(token="USDC")
    intent = PaymentIntent(
        intent_id="i9", protocol="dual", requirements=reqs, version="2.0",
        created_at="2026-01-01T00:00:00.000Z", expires_at="2026-01-01T00:05:00.000Z",
    )
    header = X402Handler.create_payment_intent_header(intent)
    assert header.startswith("x402:v2:")
    decoded = json.loads(base64.b64decode(header[len("x402:v2:"):]).decode())
    assert decoded["intentId"] == "i9"
    assert decoded["requirements"]["payTo"] == PAY_TO
    assert decoded["requirements"]["token"] == "USDC"


def test_create_then_parse_payment_intent_header_round_trip():
    reqs = _reqs()
    intent = PaymentIntent(
        intent_id="rt1", protocol="x402", requirements=reqs, version="2.0",
        created_at="2026-01-01T00:00:00.000Z", expires_at="2026-01-01T00:05:00.000Z",
    )
    header = X402Handler.create_payment_intent_header(intent)
    h = X402Handler()
    parsed = h._parse_payment_intent(header)
    assert parsed.intent_id == "rt1"
    assert parsed.requirements.pay_to == PAY_TO


# ── negotiate_payment_intent ───────────────────────────────────────────────


def test_negotiate_payment_intent_defaults_dual():
    reqs = _reqs()
    intent = X402Handler.negotiate_payment_intent(reqs)
    assert intent.protocol == "dual"
    assert intent.intent_id.startswith("intent_")
    assert intent.version == "2.0"


def test_negotiate_payment_intent_unique_ids():
    reqs = _reqs()
    a = X402Handler.negotiate_payment_intent(reqs)
    b = X402Handler.negotiate_payment_intent(reqs)
    assert a.intent_id != b.intent_id


# ── submit_payment / verify_receipt (respx-mocked) ─────────────────────────


async def test_submit_payment_success():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("x402"))
    with respx.mock:
        route = respx.post("https://merchant.example/settle").mock(
            return_value=Response(
                200,
                json={"receiptId": "r1", "status": "confirmed", "amount": "50000",
                      "network": NETWORK, "transactionId": "0xtx"},
            )
        )
        receipt = await h.submit_payment(signed, "https://merchant.example/settle")
    assert route.called
    assert isinstance(receipt, Receipt)
    assert receipt.receipt_id == "r1"
    assert receipt.status == "confirmed"
    assert receipt.transaction_id == "0xtx"


async def test_submit_payment_sends_both_headers():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("x402"))
    with respx.mock:
        route = respx.post("https://m.example/s").mock(
            return_value=Response(200, json={"receiptId": "r", "status": "pending",
                                             "amount": "1", "network": NETWORK})
        )
        await h.submit_payment(signed, "https://m.example/s", auth_token="tok")
    req = route.calls.last.request
    assert req.headers["Payment-Intent-Authorization"].startswith("x402:v2:")
    assert req.headers["PAYMENT-SIGNATURE"]  # bare base64, non-empty
    assert req.headers["Authorization"] == "Bearer tok"


async def test_submit_payment_server_error_raises():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("x402"))
    with respx.mock:
        respx.post("https://m.example/s").mock(
            return_value=Response(400, json={"error": "bad", "code": "BAD_PAY"})
        )
        with pytest.raises(PayBotApiError) as ei:
            await h.submit_payment(signed, "https://m.example/s")
    assert ei.value.code == "BAD_PAY"


async def test_submit_payment_body_includes_protocol():
    h = X402Handler(TEST_PK)
    signed = await h.sign_payment(_payload("x402"))
    with respx.mock:
        route = respx.post("https://m.example/s").mock(
            return_value=Response(200, json={"receiptId": "r", "status": "pending",
                                             "amount": "1", "network": NETWORK})
        )
        await h.submit_payment(signed, "https://m.example/s")
    body = json.loads(route.calls.last.request.content)
    assert body["protocol"] == "x402"
    assert "signature" in body


async def test_verify_receipt_true():
    h = X402Handler()
    receipt = Receipt(receipt_id="r1", status="confirmed", amount="1", network=NETWORK,
                      transaction_id="0xtx")
    with respx.mock:
        respx.post("https://m.example/verify").mock(
            return_value=Response(200, json={"verified": True})
        )
        assert await h.verify_receipt(receipt, "https://m.example/verify") is True


async def test_verify_receipt_false_when_not_verified():
    h = X402Handler()
    receipt = Receipt(receipt_id="r1", status="pending", amount="1", network=NETWORK)
    with respx.mock:
        respx.post("https://m.example/verify").mock(
            return_value=Response(200, json={"verified": False})
        )
        assert await h.verify_receipt(receipt, "https://m.example/verify") is False


async def test_verify_receipt_false_on_non_2xx():
    h = X402Handler()
    receipt = Receipt(receipt_id="r1", status="pending", amount="1", network=NETWORK)
    with respx.mock:
        respx.post("https://m.example/verify").mock(return_value=Response(500))
        assert await h.verify_receipt(receipt, "https://m.example/verify") is False


# ── GOLDEN VECTOR — USDC _sign_payload regression lock ─────────────────────

# Pinned signature for the fixed (key, nonce, validBefore, amount, payTo, network)
# tuple. If switching _sign_payload from EIP712_DOMAINS to get_eip712_domain ever
# changes USDC signing, THIS test breaks loudly. Recomputed value:
GOLDEN_USDC_SIG = (
    "0xdd3150537a2b348f564f805d3a1dc1f5c48798ae9979dbc5eabef258e1a10df2"
    "5a58e6259ad2a9ef0c306c75f11e8c9643d5a72900b67ef734eb58cab644e1de1b"
)


async def test_golden_vector_usdc_signature_unchanged():
    """Regression lock: the USDC real-mode pay() signature is byte-stable."""
    with mock.patch("paybot_sdk.client.generate_eip3009_nonce", lambda: "0x" + "ab" * 32), \
            mock.patch("paybot_sdk.client.time.time", lambda: 1_700_000_000):
        client = PayBotClient(
            PayBotConfig(api_key="k", bot_id="b", wallet_private_key=TEST_PK)
        )
        raw = await client._sign_payload(
            request=PaymentRequest(resource="https://x/y", amount="0.05", pay_to=PAY_TO),
            amount_base_units="50000",
            token_contract="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            network_id=NETWORK,
            symbol="USDC",
        )
        blob = json.loads(raw)
        assert blob["signature"] == GOLDEN_USDC_SIG
        await client.close()
