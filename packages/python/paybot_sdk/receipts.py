"""Signed receipt primitives for the Python paybot-sdk port.

Mirrors the TypeScript implementation in ``src/receipts.ts`` so EIP-191
receipt signatures can be verified across SDK runtimes.
"""
from __future__ import annotations

import json
from binascii import Error as BinasciiError
from dataclasses import fields, is_dataclass, replace
from typing import Any, Dict, Optional, Union

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_keys.exceptions import BadSignature
from eth_utils.exceptions import ValidationError

from .types import SignedReceipt, UnsignedReceipt


ReceiptLike = Union[SignedReceipt, UnsignedReceipt, Dict[str, Any]]


def _snake_to_camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def _dataclass_to_wire(value: Any) -> Dict[str, Any]:
    return {
        _snake_to_camel(item.name): getattr(value, item.name)
        for item in fields(value)
    }


def _to_mapping(value: Any) -> Any:
    if is_dataclass(value):
        return _dataclass_to_wire(value)
    return value


def _normalize(value: Any) -> Any:
    value = _to_mapping(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    if isinstance(value, tuple):
        return [_normalize(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _normalize(value[key])
            for key in sorted(value.keys())
            if value[key] is not None
        }
    raise TypeError(f"Unsupported receipt value: {type(value).__name__}")


def _unsigned_receipt(receipt: ReceiptLike) -> Any:
    if isinstance(receipt, SignedReceipt):
        data = _dataclass_to_wire(receipt)
        data.pop("signature", None)
        return data
    if isinstance(receipt, dict):
        data = dict(receipt)
        data.pop("signature", None)
        return data
    return receipt


# NOTE: Python's JSON encoder already emits lowercase booleans/null like
# JSON.stringify. ``ensure_ascii=False`` and compact separators match the
# canonicalization contract documented in #7.
def canonicalize(value: Any) -> str:
    """Serialize a receipt payload with recursively sorted keys and no spaces."""
    return json.dumps(_normalize(value), separators=(",", ":"), ensure_ascii=False)


def receipt_signing_payload(receipt: ReceiptLike) -> str:
    """Return the canonical EIP-191 message string, excluding ``signature``."""
    return canonicalize(_unsigned_receipt(receipt))


def sign_receipt(receipt: UnsignedReceipt, private_key: str) -> SignedReceipt:
    """Sign an unsigned receipt with an EVM private key using EIP-191."""
    account = Account.from_key(private_key)
    signer_address = receipt.signer_address or account.address
    receipt_to_sign = replace(receipt, signer_address=signer_address)
    message = encode_defunct(text=receipt_signing_payload(receipt_to_sign))
    signed = Account.sign_message(message, private_key=private_key)
    return SignedReceipt(
        **receipt_to_sign.__dict__,
        signature=f"0x{signed.signature.hex()}",
    )


def verify_receipt(receipt: SignedReceipt, expected_signer: Optional[str] = None) -> bool:
    """Verify a signed receipt against its embedded or expected signer address."""
    address = expected_signer or receipt.signer_address
    if not address:
        return False
    if (
        receipt.signed_by == "payer"
        and receipt.payer.wallet_address is not None
        and receipt.payer.wallet_address.lower() != address.lower()
    ):
        return False

    try:
        recovered = Account.recover_message(
            encode_defunct(text=receipt_signing_payload(receipt)),
            signature=receipt.signature,
        )
    except (BadSignature, BinasciiError, TypeError, ValidationError):
        return False
    return recovered.lower() == address.lower()
