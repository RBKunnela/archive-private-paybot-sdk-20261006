"""Tests for the AP2 adapter + MPP seam.
Mirrors ``tests/ap2.test.ts`` (~17) + ``tests/mpp-seam.test.ts`` (~10).
"""
from __future__ import annotations

import pytest
import respx
from httpx import Response

from paybot_sdk import (
    Ap2Adapter,
    Ap2PaymentMandate,
    Ap2SettleOptions,
    MppAdapter,
    MppCapability,
    X402Handler,
    ap2_mandate_to_payment_requirements,
    create_mpp_seam,
    detect_mpp_capability,
    is_ap2_mandate,
)
from paybot_sdk.errors import PayBotApiError

TEST_PK = "0x" + "1" * 64
PAYER = "0x000000000000000000000000000000000000bEEF"
PAYEE = "0x000000000000000000000000000000000000dEaD"


def _mandate(**over):
    base = dict(
        mandate_id="m1",
        payer=PAYER,
        payee=PAYEE,
        amount="1000000",
        currency="USDC",
        network="eip155:8453",
    )
    base.update(over)
    return Ap2PaymentMandate(**base)


# ── ap2_mandate_to_payment_requirements ────────────────────────────────────


def test_mandate_to_requirements_happy():
    reqs = ap2_mandate_to_payment_requirements(_mandate())
    assert reqs.scheme == "exact"
    assert reqs.token == "USDC"
    assert reqs.pay_to == PAYEE
    assert reqs.amount == "1000000"
    assert reqs.asset == "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def test_mandate_to_requirements_eurc():
    reqs = ap2_mandate_to_payment_requirements(_mandate(currency="EURC"))
    assert reqs.token == "EURC"
    assert "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" in reqs.asset


def test_mandate_to_requirements_missing_field_raises():
    with pytest.raises(PayBotApiError) as ei:
        ap2_mandate_to_payment_requirements(_mandate(payee=""))
    assert ei.value.code == "INVALID_AP2_MANDATE"
    assert ei.value.status_code == 400


def test_mandate_to_requirements_unknown_token_raises():
    with pytest.raises(PayBotApiError) as ei:
        ap2_mandate_to_payment_requirements(_mandate(currency="DOGE"))
    assert ei.value.code == "UNSUPPORTED_TOKEN"
    assert ei.value.status_code == 400


def test_mandate_to_requirements_token_not_on_network_raises():
    with pytest.raises(PayBotApiError) as ei:
        ap2_mandate_to_payment_requirements(_mandate(network="eip155:1"))
    assert ei.value.code == "UNSUPPORTED_NETWORK"


def test_mandate_to_requirements_default_timeout():
    reqs = ap2_mandate_to_payment_requirements(_mandate())
    assert reqs.max_timeout_seconds == 300


# ── is_ap2_mandate ─────────────────────────────────────────────────────────


def test_is_ap2_mandate_dataclass_true():
    assert is_ap2_mandate(_mandate()) is True


def test_is_ap2_mandate_dict_true():
    assert is_ap2_mandate(
        {"mandate_id": "m", "payer": "a", "payee": "b", "amount": "1",
         "currency": "USDC", "network": "eip155:8453"}
    ) is True


def test_is_ap2_mandate_partial_dict_false():
    assert is_ap2_mandate({"payer": "a"}) is False


def test_is_ap2_mandate_non_object_false():
    assert is_ap2_mandate(None) is False
    assert is_ap2_mandate("x") is False
    assert is_ap2_mandate(42) is False


# ── Ap2Adapter.validate_mandate ────────────────────────────────────────────


def test_validate_mandate_ok():
    adapter = Ap2Adapter(X402Handler(TEST_PK))
    assert adapter.validate_mandate(_mandate()) == {"valid": True}


def test_validate_mandate_missing_field():
    adapter = Ap2Adapter(X402Handler(TEST_PK))
    res = adapter.validate_mandate(_mandate(amount=""))
    assert res["valid"] is False
    assert "amount" in res["reason"]


def test_validate_mandate_future_expiry_ok():
    adapter = Ap2Adapter(X402Handler(TEST_PK))
    # now_ms injected well before expiry
    m = _mandate(expires_at="2030-01-01T00:00:00Z")
    assert adapter.validate_mandate(m, now_ms=0)["valid"] is True


def test_validate_mandate_expired():
    adapter = Ap2Adapter(X402Handler(TEST_PK))
    m = _mandate(expires_at="2020-01-01T00:00:00Z")
    res = adapter.validate_mandate(m, now_ms=4_000_000_000_000)
    assert res["valid"] is False
    assert res["reason"] == "mandate expired"


def test_validate_mandate_bad_expiry_format():
    adapter = Ap2Adapter(X402Handler(TEST_PK))
    res = adapter.validate_mandate(_mandate(expires_at="not-a-date"))
    assert res["valid"] is False
    assert "ISO-8601" in res["reason"]


# ── Ap2Adapter.settle (respx-mocked) ───────────────────────────────────────


async def test_settle_happy_path():
    adapter = Ap2Adapter(X402Handler(TEST_PK))
    with respx.mock:
        route = respx.post("https://merchant.example/settle").mock(
            return_value=Response(
                200,
                json={"receiptId": "r1", "status": "confirmed", "amount": "1000000",
                      "network": "eip155:8453", "transactionId": "0xtx"},
            )
        )
        receipt = await adapter.settle(
            _mandate(), Ap2SettleOptions(payment_endpoint="https://merchant.example/settle")
        )
    assert route.called
    assert receipt.receipt_id == "r1"
    assert receipt.status == "confirmed"


async def test_settle_invalid_mandate_raises():
    adapter = Ap2Adapter(X402Handler(TEST_PK))
    with pytest.raises(PayBotApiError) as ei:
        await adapter.settle(_mandate(payee=""))
    assert ei.value.code == "INVALID_AP2_MANDATE"


async def test_settle_expired_mandate_raises():
    adapter = Ap2Adapter(X402Handler(TEST_PK))
    with pytest.raises(PayBotApiError) as ei:
        await adapter.settle(_mandate(expires_at="2020-01-01T00:00:00Z"))
    assert ei.value.code == "INVALID_AP2_MANDATE"


async def test_settle_does_not_verify_signature():
    """Trust boundary: an opaque/garbage VC signature does NOT block settlement."""
    adapter = Ap2Adapter(X402Handler(TEST_PK))
    with respx.mock:
        respx.post("https://m.example/s").mock(
            return_value=Response(200, json={"receiptId": "r", "status": "pending",
                                             "amount": "1", "network": "eip155:8453"})
        )
        receipt = await adapter.settle(
            _mandate(signature="totally-bogus-not-verified"),
            Ap2SettleOptions(payment_endpoint="https://m.example/s"),
        )
    assert receipt.receipt_id == "r"


# ── MPP seam ───────────────────────────────────────────────────────────────


def test_detect_mpp_no_headers():
    cap = detect_mpp_capability()
    assert cap.supported is False
    assert cap.mode == "none"
    assert cap.reason == "no MPP advertisement"


def test_detect_mpp_empty_headers():
    cap = detect_mpp_capability({})
    assert cap.supported is False


def test_detect_mpp_version_header():
    cap = detect_mpp_capability({"MPP-Version": "2024-09-preview"})
    assert cap.supported is True
    assert cap.mode == "detect-only"
    assert cap.spec_version == "2024-09-preview"


def test_detect_mpp_stripe_version_header():
    cap = detect_mpp_capability({"Stripe-Version": "2024-06-20"})
    assert cap.supported is True
    assert cap.spec_version == "2024-06-20"


def test_detect_mpp_case_insensitive():
    cap = detect_mpp_capability({"mpp-version": "v1"})
    assert cap.supported is True


def test_detect_mpp_www_authenticate_payment():
    cap = detect_mpp_capability({"WWW-Authenticate": "Payment realm=mpp"})
    assert cap.supported is True
    assert "Payment" in cap.spec_version


def test_detect_mpp_www_authenticate_non_payment():
    cap = detect_mpp_capability({"WWW-Authenticate": "Bearer realm=api"})
    assert cap.supported is False


def test_create_mpp_seam_returns_adapter():
    seam = create_mpp_seam()
    assert isinstance(seam, MppAdapter)


def test_mpp_seam_detect_works():
    seam = create_mpp_seam()
    assert seam.detect({"MPP-Version": "x"}).supported is True


def test_mpp_seam_settle_raises_not_implemented():
    seam = create_mpp_seam()
    with pytest.raises(PayBotApiError) as ei:
        seam.settle()
    assert ei.value.code == "MPP_NOT_IMPLEMENTED"
    assert ei.value.status_code == 501


def test_mpp_capability_is_dataclass():
    cap = MppCapability(supported=True, mode="detect-only", spec_version="v")
    assert cap.supported is True
