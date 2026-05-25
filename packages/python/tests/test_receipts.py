from __future__ import annotations

import pytest

from paybot_sdk import (
    ReceiptAgent,
    ReceiptArtifact,
    ReceiptCapability,
    ReceiptReputationPointer,
    ReceiptSettlement,
    SignedReceipt,
    UnsignedReceipt,
    canonicalize,
    receipt_signing_payload,
    sign_receipt,
    verify_receipt,
)


PAYER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
OTHER_PRIVATE_KEY = "0x59c6995e998f97a5a0044976f5787df9739ce7bbd781e9d6d1edaea8c2ea7a9f"
PAYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
OTHER_ADDRESS = "0xC36e74F224B90C71dbc4C782727dBe884d93f8B0"


def base_receipt() -> UnsignedReceipt:
    return UnsignedReceipt(
        version="1.0",
        receipt_id="receipt_20260516_0001",
        payer=ReceiptAgent(bot_id="payer-bot", wallet_address=PAYER_ADDRESS),
        payee=ReceiptAgent(
            bot_id="payee-bot",
            wallet_address="0x0000000000000000000000000000000000000001",
            service_card_ref="https://example.com/agent-card.json",
        ),
        capability=ReceiptCapability(
            id="text.summarize.v1",
            descriptor="Summarize one document",
            request_hash="sha256:request",
        ),
        settlement=ReceiptSettlement(
            tx_hash="0x1234",
            network="eip155:8453",
            gross_amount="100000",
            net_amount="97500",
            timestamp="2026-05-16T21:30:00.000Z",
        ),
        artifact=ReceiptArtifact(
            hash="sha256:artifact",
            content_type="text/markdown",
            uri="ipfs://bafyreceipt",
        ),
        reputation=ReceiptReputationPointer(
            registry_uri="https://reputation.example.com",
            payee_record_id="payee-bot",
        ),
        signed_by="payer",
    )


def test_canonicalizes_object_keys_recursively_and_omits_none_fields():
    payload = {
        "z": 1,
        "a": {"b": 2, "a": None, "c": [{"y": True, "x": "ok"}]},
    }
    assert canonicalize(payload) == '{"a":{"b":2,"c":[{"x":"ok","y":true}]},"z":1}'


def test_canonicalizes_receipt_with_typescript_wire_keys():
    receipt = base_receipt()
    payload = receipt_signing_payload(receipt)

    assert '"receiptId":"receipt_20260516_0001"' in payload
    assert '"botId":"payer-bot"' in payload
    assert '"walletAddress":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"' in payload
    assert '"requestHash":"sha256:request"' in payload
    assert '"signedBy":"payer"' in payload
    assert "receipt_id" not in payload
    assert "wallet_address" not in payload


def test_throws_for_unsupported_receipt_value_types():
    with pytest.raises(TypeError, match="Unsupported receipt value: function"):
        canonicalize({"bad": lambda: "nope"})


def test_keeps_nested_objects_deterministic_when_every_field_is_none():
    payload = {
        "z": {"b": None, "a": None},
        "a": [{"c": None}, {"b": 2, "a": None}],
    }
    assert canonicalize(payload) == '{"a":[{}, {"b":2}],"z":{}}'.replace(" ", "")


def test_excludes_signature_from_the_signing_payload():
    unsigned = base_receipt()
    signed = SignedReceipt(
        **{**unsigned.__dict__, "signer_address": PAYER_ADDRESS},
        signature="0xdeadbeef",
    )

    unsigned_with_signer = SignedReceipt(
        **{**unsigned.__dict__, "signer_address": PAYER_ADDRESS}, signature=""
    )
    assert receipt_signing_payload(signed) == receipt_signing_payload(unsigned_with_signer)
    assert "deadbeef" not in receipt_signing_payload(signed)


def test_signs_and_verifies_receipt_with_embedded_signer_address():
    signed = sign_receipt(base_receipt(), PAYER_PRIVATE_KEY)

    assert signed.signature.startswith("0x")
    assert signed.signer_address == PAYER_ADDRESS
    assert verify_receipt(signed) is True


def test_rejects_tampered_receipt_content():
    signed = sign_receipt(base_receipt(), PAYER_PRIVATE_KEY)
    tampered = SignedReceipt(
        **{
            **signed.__dict__,
            "capability": ReceiptCapability(id="audio.transcribe.v1"),
        }
    )

    assert verify_receipt(tampered) is False


def test_verifies_against_explicit_signer_and_rejects_wrong_signer():
    signed = sign_receipt(base_receipt(), PAYER_PRIVATE_KEY)
    other_signed = sign_receipt(
        UnsignedReceipt(**{**base_receipt().__dict__, "signed_by": "facilitator"}),
        OTHER_PRIVATE_KEY,
    )

    assert verify_receipt(signed, PAYER_ADDRESS) is True
    assert verify_receipt(other_signed, PAYER_ADDRESS) is False
    assert verify_receipt(other_signed, OTHER_ADDRESS) is True


def test_rejects_payer_signed_receipts_when_signer_address_mismatches_payer_wallet():
    receipt = UnsignedReceipt(
        **{
            **base_receipt().__dict__,
            "signer_address": "0x0000000000000000000000000000000000000001",
        }
    )
    signed = sign_receipt(receipt, PAYER_PRIVATE_KEY)

    assert verify_receipt(signed) is False


@pytest.mark.parametrize("signature", ["0xdeadbeef", "not-hex", None])
def test_rejects_malformed_receipt_signatures_without_masking_other_errors(signature):
    signed = sign_receipt(base_receipt(), PAYER_PRIVATE_KEY)
    malformed = SignedReceipt(**{**signed.__dict__, "signature": signature})

    assert verify_receipt(malformed) is False
